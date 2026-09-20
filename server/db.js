'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, no install needed

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

// Every tenant-owned table carries school_id and every query filters on it.
// Money is stored as integer pesewas (GH₵ 1.00 = 100) to avoid floating point errors.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, type TEXT, location TEXT, motto TEXT, phone TEXT, email TEXT,
  primary_color TEXT NOT NULL DEFAULT '#0f766e',
  secondary_color TEXT NOT NULL DEFAULT '#f59e0b',
  logo TEXT, cover TEXT,
  academic_year TEXT, current_term INTEGER NOT NULL DEFAULT 1,
  ca_max INTEGER NOT NULL DEFAULT 30, exam_max INTEGER NOT NULL DEFAULT 70,
  grading_scale TEXT, levels TEXT, expected_students INTEGER,
  admissions_open INTEGER NOT NULL DEFAULT 1,
  admission_seq INTEGER NOT NULL DEFAULT 0,
  application_seq INTEGER NOT NULL DEFAULT 0,
  receipt_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year TEXT NOT NULL,
  term INTEGER NOT NULL CHECK (term BETWEEN 1 AND 4),
  start_date TEXT, end_date TEXT, next_term_begins TEXT,
  UNIQUE (school_id, academic_year, term)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','principal','teacher','accountant','parent')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL, level TEXT,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (school_id, name)
);
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE (school_id, name)
);
CREATE TABLE IF NOT EXISTS class_subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (class_id, subject_id)
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  admission_no TEXT NOT NULL,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  gender TEXT CHECK (gender IN ('male','female')),
  dob TEXT,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('applicant','active','transferred','graduated','withdrawn')),
  address TEXT, previous_school TEXT, admitted_on TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE (school_id, admission_no)
);
CREATE INDEX IF NOT EXISTS idx_students_school_status ON students(school_id, status);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE TABLE IF NOT EXISTS guardians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  name TEXT NOT NULL, relationship TEXT, phone TEXT, email TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_guardians_student ON guardians(student_id);
CREATE TABLE IF NOT EXISTS parent_students (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, student_id)
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent','late','excused')),
  marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (student_id, date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_school_date ON attendance(school_id, date);
-- Ghana-style assessment: continuous assessment (class score) + end-of-term exam score.
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  academic_year TEXT NOT NULL,
  term INTEGER NOT NULL CHECK (term BETWEEN 1 AND 4),
  ca_score REAL CHECK (ca_score BETWEEN 0 AND 100),
  exam_score REAL CHECK (exam_score BETWEEN 0 AND 100),
  total REAL GENERATED ALWAYS AS (
    CASE WHEN ca_score IS NOT NULL AND exam_score IS NOT NULL THEN ca_score + exam_score END) VIRTUAL,
  entered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (student_id, subject_id, academic_year, term)
);
CREATE INDEX IF NOT EXISTS idx_results_lookup ON results(school_id, academic_year, term, subject_id);
CREATE TABLE IF NOT EXISTS report_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year TEXT NOT NULL, term INTEGER NOT NULL,
  teacher_remark TEXT, head_remark TEXT, conduct TEXT,
  UNIQUE (student_id, academic_year, term)
);
-- Parents only see report cards after the school publishes them for a class + term.
CREATE TABLE IF NOT EXISTS published_reports (
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  academic_year TEXT NOT NULL, term INTEGER NOT NULL,
  published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at TEXT NOT NULL DEFAULT (${NOW}),
  PRIMARY KEY (class_id, academic_year, term)
);
-- Anyone can check a printed report card is genuine via /verify?code=...
CREATE TABLE IF NOT EXISTS report_verifications (
  code TEXT PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year TEXT NOT NULL, term INTEGER NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE (student_id, academic_year, term)
);
-- Financial records are never cascaded away: no ON DELETE CASCADE on invoices/payments.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  description TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  academic_year TEXT, term INTEGER, due_date TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_invoices_student ON invoices(student_id);
CREATE INDEX IF NOT EXISTS idx_invoices_school ON invoices(school_id, academic_year);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','momo','bank','cheque')),
  reference TEXT,
  receipt_no TEXT NOT NULL,
  received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_at TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE (school_id, receipt_no)
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','staff','parents','students')),
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, location TEXT,
  start_date TEXT NOT NULL, end_date TEXT,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','staff','parents','students')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, due_date TEXT,
  assigned_to INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS timetable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 7),
  start_time TEXT NOT NULL, end_time TEXT NOT NULL, room TEXT
);
CREATE INDEX IF NOT EXISTS idx_timetable_class ON timetable(class_id, day);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_user_id, to_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(to_user_id, read_at);
-- Outbox for SMS / email. A background worker hands queued rows to the configured provider.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
  recipient TEXT NOT NULL, subject TEXT, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, related TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW}), sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, entity TEXT, entity_id INTEGER, summary TEXT, ip TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_audit_school ON audit_log(school_id, id);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const norm = (a) => a.map((x) => (x === undefined ? null : x)); // sqlite refuses undefined

  return {
    run: (sql, ...p) => stmt(sql).run(...norm(p)),
    get: (sql, ...p) => stmt(sql).get(...norm(p)),
    all: (sql, ...p) => stmt(sql).all(...norm(p)),
    // Not re-entrant: do not nest tx() calls.
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const out = fn(); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },
    close: () => db.close(),
  };
}

module.exports = { openDb };
