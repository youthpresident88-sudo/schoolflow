'use strict';
const { v, bad, HttpError, notFound, paging, escapeLike, today } = require('../lib');
const { created } = require('../http');

const METHODS = ['cash', 'momo', 'bank', 'cheque'];
const ghs = (p) => `GH₵${(p / 100).toFixed(2)}`;
const PAID = '(SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id)';

module.exports = (r, { db, audit, shared, notifier }) => {
  r.get('/api/fees/summary', { perm: 'fees:read' }, (ctx) => shared.feeStats(ctx.schoolId, shared.currentPeriod(ctx.schoolId).year));

  const BASE = `SELECT i.id, i.student_id, s.first_name, s.last_name, s.admission_no, c.name AS class_name, i.description, i.amount,
      i.academic_year, i.term, i.due_date, i.created_at, ${PAID} AS paid
    FROM invoices i JOIN students s ON s.id = i.student_id LEFT JOIN classes c ON c.id = s.class_id`;

  r.get('/api/invoices', { perm: 'fees:read' }, (ctx) => {
    const { q, student_id: studentId, status, class_id: classId } = ctx.query;
    const { page, limit, offset } = paging(ctx.query);
    const where = ['i.school_id = ?']; const p = [ctx.schoolId];
    if (studentId) { where.push('i.student_id = ?'); p.push(v.id(studentId, 'Student')); }
    if (classId) { where.push('s.class_id = ?'); p.push(v.id(classId, 'Class')); }
    if (q) {
      const like = `%${escapeLike(String(q).slice(0, 60))}%`;
      where.push("((s.first_name || ' ' || s.last_name) LIKE ? ESCAPE '\\' OR s.admission_no LIKE ? ESCAPE '\\')");
      p.push(like, like);
    }
    const filter = { outstanding: 't.amount > t.paid', paid: 't.amount <= t.paid', overdue: "t.amount > t.paid AND t.due_date IS NOT NULL AND t.due_date < date('now')" }[status];
    if (status && !filter) throw bad('status must be outstanding, paid or overdue');
    const inner = `${BASE} WHERE ${where.join(' AND ')}`;
    const outer = filter ? `WHERE ${filter}` : '';
    const total = db.get(`SELECT COUNT(*) AS n FROM (${inner}) t ${outer}`, ...p).n;
    const items = db.all(`SELECT * FROM (${inner}) t ${outer} ORDER BY t.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset)
      .map((x) => ({ ...x, balance: x.amount - x.paid }));
    return { items, total, page, limit };
  });

  // One student, one class, or everyone active. Re-running the same bill skips students who already have it.
  r.post('/api/invoices', { perm: 'fees:write' }, (ctx) => {
    const b = ctx.body;
    const period = shared.currentPeriod(ctx.schoolId);
    const d = {
      description: v.str(b.description, 'Description', { required: true, max: 120 }),
      amount: v.int(b.amount, 'Amount (pesewas)', { min: 1, max: 100_000_000, required: true }),
      term: v.int(b.term, 'Term', { min: 1, max: 4 }) || period.term,
      year: v.str(b.academic_year, 'Academic year', { max: 20 }) || period.year,
      due: v.date(b.due_date, 'Due date'),
      studentId: v.id(b.student_id, 'Student'), classId: v.id(b.class_id, 'Class'),
    };
    let students;
    if (d.studentId) {
      students = db.all("SELECT id FROM students WHERE id = ? AND school_id = ? AND status IN ('active','applicant')", d.studentId, ctx.schoolId);
    } else if (d.classId) {
      students = db.all("SELECT id FROM students WHERE school_id = ? AND class_id = ? AND status = 'active'", ctx.schoolId, d.classId);
    } else {
      students = db.all("SELECT id FROM students WHERE school_id = ? AND status = 'active'", ctx.schoolId);
    }
    if (!students.length) throw bad('No matching students to bill');
    let createdCount = 0; let skipped = 0;
    db.tx(() => {
      for (const s of students) {
        if (db.get('SELECT 1 x FROM invoices WHERE student_id = ? AND description = ? AND academic_year IS ? AND term IS ?', s.id, d.description, d.year, d.term)) { skipped++; continue; }
        db.run('INSERT INTO invoices(school_id,student_id,description,amount,academic_year,term,due_date,created_by) VALUES (?,?,?,?,?,?,?,?)',
          ctx.schoolId, s.id, d.description, d.amount, d.year, d.term, d.due, ctx.user.id);
        createdCount++;
      }
    });
    audit(ctx, 'invoices.created', 'invoice', null, `Billed ${createdCount} student(s): ${d.description} ${ghs(d.amount)}`);
    return created({ created: createdCount, skipped });
  });

  r.post('/api/payments', { perm: 'fees:write' }, (ctx) => {
    const invoiceId = v.id(ctx.body.invoice_id, 'Invoice', { required: true });
    const amount = v.int(ctx.body.amount, 'Amount (pesewas)', { min: 1, max: 100_000_000, required: true });
    const method = v.enum(ctx.body.method, 'Payment method', METHODS, { required: true });
    const reference = v.str(ctx.body.reference, 'Reference', { max: 60 });
    const receipt = db.tx(() => {
      const inv = db.get(`SELECT i.id, i.student_id, i.description, i.amount, i.term, i.academic_year, ${PAID} AS paid
        FROM invoices i WHERE i.id = ? AND i.school_id = ?`, invoiceId, ctx.schoolId);
      if (!inv) throw notFound('Invoice');
      const balance = inv.amount - inv.paid;
      if (balance <= 0) throw new HttpError(409, 'This invoice is already fully paid');
      if (amount > balance) throw bad(`Payment exceeds the outstanding balance (${ghs(balance)})`);
      db.run('UPDATE schools SET receipt_seq = receipt_seq + 1 WHERE id = ?', ctx.schoolId);
      const { receipt_seq: n } = db.get('SELECT receipt_seq FROM schools WHERE id = ?', ctx.schoolId);
      const no = `RCT-${new Date().getUTCFullYear()}-${String(n).padStart(5, '0')}`;
      const pid = Number(db.run('INSERT INTO payments(school_id,invoice_id,student_id,amount,method,reference,receipt_no,received_by) VALUES (?,?,?,?,?,?,?,?)',
        ctx.schoolId, invoiceId, inv.student_id, amount, method, reference, no, ctx.user.id).lastInsertRowid);
      return { id: pid, receipt_no: no, amount, method, reference, invoice_id: invoiceId, description: inv.description, term: inv.term,
        academic_year: inv.academic_year, balance_after: balance - amount, student_id: inv.student_id };
    });
    const st = db.get('SELECT first_name, last_name, admission_no FROM students WHERE id = ?', receipt.student_id);
    audit(ctx, 'payment.received', 'payment', receipt.id, `${receipt.receipt_no}: ${ghs(amount)} for ${st.first_name} ${st.last_name}`);
    // best-effort confirmation to the primary guardian
    const g = db.get('SELECT name, phone, email FROM guardians WHERE student_id = ? ORDER BY is_primary DESC, id LIMIT 1', receipt.student_id);
    if (g && g.phone) {
      const school = db.get('SELECT name FROM schools WHERE id = ?', ctx.schoolId);
      notifier.enqueue(ctx.schoolId, { channel: 'sms', to: g.phone, related: `receipt:${receipt.receipt_no}`, userId: ctx.user.id,
        body: `${school.name}: received ${ghs(amount)} for ${st.first_name} ${st.last_name}. Receipt ${receipt.receipt_no}. Balance ${ghs(receipt.balance_after)}. Thank you.` });
    }
    return created({ ...receipt, student: { name: `${st.first_name} ${st.last_name}`, admission_no: st.admission_no }, received_at: new Date().toISOString() });
  });

  r.get('/api/payments', { perm: 'fees:read' }, (ctx) => {
    const { page, limit, offset } = paging(ctx.query);
    const where = ['p.school_id = ?']; const p = [ctx.schoolId];
    if (ctx.query.student_id) { where.push('p.student_id = ?'); p.push(v.id(ctx.query.student_id, 'Student')); }
    const W = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM payments p WHERE ${W}`, ...p).n;
    const items = db.all(`SELECT p.id, p.receipt_no, p.amount, p.method, p.reference, p.received_at, i.description, s.first_name, s.last_name, s.admission_no, u.name AS received_by
      FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN students s ON s.id = p.student_id LEFT JOIN users u ON u.id = p.received_by
      WHERE ${W} ORDER BY p.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
    return { items, total, page, limit };
  });

  // Queue SMS/email reminders to guardians of students who owe money
  r.post('/api/fees/remind', { perm: 'fees:write' }, (ctx) => {
    const classId = v.id(ctx.body.class_id, 'Class');
    const minBalance = v.int(ctx.body.min_balance, 'Minimum balance (pesewas)', { min: 1 }) || 1;
    const overdueOnly = !!ctx.body.overdue_only;
    const school = db.get('SELECT name FROM schools WHERE id = ?', ctx.schoolId);
    const rows = db.all(`SELECT s.id, s.first_name, s.last_name,
      SUM(i.amount) - COALESCE(SUM(${PAID}), 0) AS balance
      FROM invoices i JOIN students s ON s.id = i.student_id
      WHERE i.school_id = ? AND s.status = 'active' AND (? IS NULL OR s.class_id = ?)
        AND (? = 0 OR (i.due_date IS NOT NULL AND i.due_date < ?))
      GROUP BY s.id HAVING balance >= ? LIMIT 500`, ctx.schoolId, classId, classId, overdueOnly ? 1 : 0, today(), minBalance);
    let queued = 0; let noContact = 0;
    for (const s of rows) {
      const g = db.get('SELECT name, phone, email FROM guardians WHERE student_id = ? ORDER BY is_primary DESC, id LIMIT 1', s.id);
      const body = `${school.name}: fees reminder for ${s.first_name} ${s.last_name}. Outstanding balance ${ghs(s.balance)}. Please pay at the school office or by mobile money. Thank you.`;
      let sent = false;
      if (g && g.phone) sent = notifier.enqueue(ctx.schoolId, { channel: 'sms', to: g.phone, body, related: `reminder:${s.id}`, userId: ctx.user.id }) || sent;
      if (g && g.email) sent = notifier.enqueue(ctx.schoolId, { channel: 'email', to: g.email, subject: 'Fees reminder', body, related: `reminder:${s.id}`, userId: ctx.user.id }) || sent;
      if (sent) queued++; else noContact++;
    }
    audit(ctx, 'fees.reminders', 'invoice', null, `Queued fee reminders for ${queued} guardian(s)`);
    return { students_with_balance: rows.length, queued, no_contact: noContact };
  });
};
