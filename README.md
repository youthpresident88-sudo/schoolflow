# SchoolFlow

Multi-tenant school management platform, built Ghana-first: admissions, students, attendance, Ghana-style
assessment (class score + exam), report cards with class positions and online verification, fees with mobile-money
reference tracking, SMS/email outbox, parent portal, timetable, staff tasks and analytics.

## Run it

Needs **Node.js 22.13 or newer**. There is nothing to install (no npm packages): the server uses Node's built-in
HTTP and SQLite modules.

```bash
node server/index.js          # http://127.0.0.1:3000
npm test                      # 35 tests: the API, plus every UI view for every role
```

Open <http://localhost:3000>, choose **Create a school account**, finish the wizard, and you land in your dashboard.
Data is stored in `server/data/schoolflow.db` (SQLite, created on first run).

### Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `PORT`, `SF_HOST` | Port (3000) and bind address. Use `SF_HOST=0.0.0.0` on a server. |
| `SF_DB` | Database file path. |
| `SF_SECURE_COOKIES=1` | Mark the session cookie `Secure`. **Set this behind HTTPS.** |
| `SF_TRUST_PROXY=1` | Trust `X-Forwarded-*` from nginx/Cloudflare so rate limits see real client IPs. |
| `SF_BASE_DOMAIN` | e.g. `schoolflow.app`. Then `greenfield.schoolflow.app` serves Greenfield's branded sign-in. Without it, use `login.html?school=<slug>`. |
| `SF_SMS_URL`, `SF_SMS_KEY`, `SF_SMS_SENDER` | Your SMS gateway endpoint (see below). |
| `SF_EMAIL_URL`, `SF_EMAIL_KEY`, `SF_EMAIL_FROM` | Your email gateway endpoint. |

### SMS and email

Every message (fee reminders, announcements, receipts, admission confirmations) is written to an outbox table and
sent by a background worker. With no gateway configured the worker only **logs** messages (marked `dev-log`, nothing is
delivered). To send for real, point `SF_SMS_URL` / `SF_EMAIL_URL` at a gateway or a small adapter you host: SchoolFlow
POSTs `{to, subject, body, sender|from}` as JSON with `Authorization: Bearer <key>` and treats any 2xx as delivered.
Failed sends retry up to 3 times. Phone numbers are normalised to `+233…`.

## What is built

| Area | Highlights |
|---|---|
| **Onboarding & tenancy** | Self-serve school signup; classes from “Primary 1–6, JHS 1–3”; default subjects; school slug; branded sign-in; every row belongs to a school and every query is scoped (tested). |
| **Roles** | Admin, Principal, Teacher, Accountant, Parent. Permission-based; teachers are limited to their own class / subjects; teachers never see fee balances. |
| **Students** | Register, search, profile, guardians, admissions review, promotion / graduation, change history via the audit log, CSV export. |
| **Online admissions** | Public form (`apply.html?school=<slug>`), honeypot + rate limit, applicants reviewed and admitted into a class with an auto admission number and SMS/email confirmation. |
| **Attendance** | Daily register per class, draft autosave (survives refresh / dropped connection), 30-day report, term-scoped attendance on report cards. |
| **Exams & results** | Ghana-style **class score + exam score** (30/70, 40/60 or 50/50), custom grading scale, live totals and grades, subject and overall **class positions** (ties handled), remarks and conduct, class broadsheet. |
| **Report cards** | Printable, **verification code** + public check page (`verify.html`), published to parents only when the school releases them (scores lock while published). |
| **Fees & finance** | Bulk billing per class or school (no double billing), partial payments, cash / MoMo / bank / cheque with reference, receipts, overdue tracking, reminders by SMS/email, collection analytics. Money is stored in pesewas (integers). |
| **Parent portal** | One login per family (siblings share it): attendance, fees and receipts, published report cards, timetable, announcements, events, messages to teachers. |
| **Communication** | Announcements (school, class, staff, parents) with optional SMS/email broadcast, events calendar, direct messages, outbox log. |
| **Timetable** | Weekly grid by class or teacher with clash detection (class and teacher). |
| **Staff & HR** | Accounts with temporary passwords (forced change), deactivation signs people out, **task assignment** with due dates, **staff activity log** (audit trail). |
| **Reports & analytics** | Enrollment by class and gender, attendance by class, fees by class and overdue, subject averages, grade distribution. |
| **Settings & data** | Branding (logo, colours, login background), academic year and terms with dates, assessment split, grading scale, admissions switch, full data export (JSON) and CSVs. |

## App shell and responsiveness

* Single-page navigation: every section is a tab (`#/students`, `#/fees`, …); switching is instant, with no reload,
  and back/forward and deep links work. Sections a role may not use never appear.
* Three layouts: full sidebar on desktop, icon rail on tablets, and on phones a slide-in menu plus a bottom tab bar
  (four sections + **More**). Tables turn into stacked cards under 700px; dialogs become bottom sheets on phones.
* State: filters, search text, selected class/subject/term and the last tab of each section are remembered while you
  move between sections (per browser tab, cleared on sign-out or when another person signs in). Attendance and score
  drafts are also saved locally until you press Save.
* Feedback: skeleton loading, entrance transitions, button spinners while saving, toasts, live totals and grades,
  live attendance counts. Motion is disabled for people who set “reduce motion”.

## Security notes

* Passwords: scrypt with per-user salt; login and password-change attempts are rate limited; deactivating a user
  ends their sessions; changing a password signs out other devices.
* Sessions: random 256-bit tokens, only their SHA-256 is stored; `HttpOnly`, `SameSite=Lax` cookies.
* CSRF: mutating requests must be `application/json` and same-origin.
* All SQL is parameterised. All UI output goes through an auto-escaping template helper. CSV exports neutralise
  spreadsheet formulas. Uploaded images are validated data-URLs used only as CSS / `img` sources.
* Security headers on every response (CSP, `nosniff`, frame denial).
* Ghana Data Protection Act: collect only what you need, keep the export and audit log, and register the school as a
  data controller with the Data Protection Commission. This code does not make a school compliant on its own.

## Known limits and next steps

* **Database**: SQLite is fine for hundreds of schools on one server. For scale, move `server/db.js` to PostgreSQL;
  all queries are plain SQL with `school_id` on every table.
* **Payments**: MoMo is recorded manually (method + reference). Online collection needs a payment-gateway integration.
* **Report card QR**: cards carry a verification code and link; a scannable QR image needs a QR library.
* **Not built yet**: LMS / assignments, library, transport, inventory, boarding (exeat), e-voting, multi-campus,
  school public website builder, offline-first PWA, file storage for documents and photos, scheduled backups.
* **Not verified in a real browser**: automated tests run every view in a simulated DOM against the real API;
  layout, print styling and touch behaviour still need a manual pass on real phones and printers.
