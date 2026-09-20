'use strict';
const { v, bad, HttpError, notFound, obj } = require('../lib');
const { created } = require('../http');

module.exports = (r, { db, limiters, slugFrom, shared, notifier, audit }) => {
  const schoolBySlug = (slug) => db.get(`SELECT id, slug, name, type, location, motto, phone, email, primary_color, secondary_color, logo, cover, admissions_open
    FROM schools WHERE slug = ?`, slug);

  // Branding for the login / admissions pages (subdomain or ?school=slug). Nothing private is exposed.
  r.get('/api/public/school', { auth: false }, (ctx) => {
    const s = schoolBySlug(slugFrom(ctx));
    if (!s) throw notFound('School');
    s.classes = db.all('SELECT id, name FROM classes WHERE school_id = ? ORDER BY id', s.id);
    delete s.id;
    return s;
  });

  r.post('/api/public/apply', { auth: false, maxBody: 50_000 }, (ctx) => {
    limiters.apply.check(ctx.ip);
    limiters.apply.fail(ctx.ip);
    if (ctx.body.website) return created({ application_no: 'APP-RECEIVED' }); // honeypot: silently drop bots
    const s = schoolBySlug(String(ctx.body.school || slugFrom(ctx)).toLowerCase());
    if (!s) throw notFound('School');
    if (!s.admissions_open) throw new HttpError(409, 'This school is not accepting applications right now');
    const d = {
      first: v.str(ctx.body.first_name, 'First name', { required: true, max: 60 }),
      last: v.str(ctx.body.last_name, 'Last name', { required: true, max: 60 }),
      gender: v.enum(ctx.body.gender, 'Gender', ['male', 'female']),
      dob: v.date(ctx.body.dob, 'Date of birth', { notFuture: true }),
      classId: v.id(ctx.body.class_id, 'Class applied for'),
      address: v.str(ctx.body.address, 'Address', { max: 200 }),
      previous: v.str(ctx.body.previous_school, 'Previous school', { max: 120 }),
      gName: v.str(ctx.body.guardian_name, 'Parent/guardian name', { required: true, max: 100 }),
      gRel: v.str(ctx.body.guardian_relationship, 'Relationship', { max: 40 }),
      gPhone: v.phone(ctx.body.guardian_phone, 'Parent/guardian phone'),
      gEmail: v.email(ctx.body.guardian_email, 'Parent/guardian email', { required: false }),
    };
    if (!d.gPhone && !d.gEmail) throw bad('Provide a phone number or email so the school can reach you');
    if (d.classId && !db.get('SELECT 1 x FROM classes WHERE id = ? AND school_id = ?', d.classId, s.id)) throw bad('Unknown class');
    const appNo = db.tx(() => {
      db.run('UPDATE schools SET application_seq = application_seq + 1 WHERE id = ?', s.id);
      const n = db.get('SELECT application_seq FROM schools WHERE id = ?', s.id).application_seq;
      const no = `APP-${new Date().getUTCFullYear()}-${String(n).padStart(4, '0')}`;
      const sid = Number(db.run("INSERT INTO students(school_id,admission_no,first_name,last_name,gender,dob,class_id,status,address,previous_school) VALUES (?,?,?,?,?,?,?,'applicant',?,?)",
        s.id, no, d.first, d.last, d.gender, d.dob, d.classId, d.address, d.previous).lastInsertRowid);
      db.run('INSERT INTO guardians(school_id,student_id,name,relationship,phone,email,is_primary) VALUES (?,?,?,?,?,?,1)', s.id, sid, d.gName, d.gRel, d.gPhone, d.gEmail);
      return no;
    });
    const msg = `${s.name}: we received the application for ${d.first} ${d.last}. Reference ${appNo}. The school will contact you.`;
    if (d.gPhone) notifier.enqueue(s.id, { channel: 'sms', to: d.gPhone, body: msg, related: `application:${appNo}` });
    if (d.gEmail) notifier.enqueue(s.id, { channel: 'email', to: d.gEmail, subject: 'Application received', body: msg, related: `application:${appNo}` });
    audit({ schoolId: s.id, user: null, ip: ctx.ip }, 'admission.applied', 'student', null, `New online application ${appNo}: ${d.first} ${d.last}`);
    return created({ application_no: appNo });
  });

  // Anyone (an employer, another school) can check that a printed report card is genuine
  r.get('/api/verify', { auth: false }, (ctx) => {
    limiters.verify.check(ctx.ip);
    const code = String(ctx.query.code || '').trim().toUpperCase();
    const row = /^SF-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) && db.get('SELECT * FROM report_verifications WHERE code = ?', code);
    if (!row) { limiters.verify.fail(ctx.ip); return { valid: false }; }
    const rep = shared.buildReport(row.school_id, row.student_id, row.academic_year, row.term);
    return {
      valid: true, school: rep.school.name, student: rep.student.name, class: rep.student.class_name,
      academic_year: rep.academic_year, term: rep.term, average: rep.overall.average, grade: rep.overall.grade,
      position: rep.overall.position, out_of: rep.overall.out_of, issued_at: row.issued_at,
    };
  });
};
