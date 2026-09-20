'use strict';
const { toE164 } = require('./lib');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Providers receive { to, subject, body } and must throw on failure.
//  - SF_SMS_URL / SF_EMAIL_URL : POST JSON to any gateway or small adapter you host
//    (Authorization: Bearer <SF_SMS_KEY / SF_EMAIL_KEY>). Point it at your SMS gateway adapter.
//  - otherwise "dev-log": prints the message and marks it sent with a dev note, so flows can be tested
//    without spending money. Nothing is actually delivered in this mode.
function webhookProvider(url, key, extra = {}) {
  return async (msg) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ ...extra, ...msg }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Gateway responded ${res.status}`);
  };
}

function createNotifier(db, config = {}, log = console) {
  const devLog = (channel) => async (msg) => {
    log.log(`[notify:${channel}:dev-log] to=${msg.to} :: ${msg.subject ? msg.subject + ' — ' : ''}${msg.body}`);
    return 'dev-log: nothing was actually delivered (no gateway configured)';
  };
  const providers = {
    sms: config.smsUrl ? webhookProvider(config.smsUrl, config.smsKey, { sender: config.smsSender }) : devLog('sms'),
    email: config.emailUrl ? webhookProvider(config.emailUrl, config.emailKey, { from: config.emailFrom }) : devLog('email'),
  };

  function enqueue(schoolId, { channel, to, subject = null, body, related = null, userId = null }) {
    const recipient = channel === 'sms' ? toE164(to) : (EMAIL_RE.test(String(to || '')) ? String(to).toLowerCase() : null);
    if (!recipient || !body) return false;
    const text = channel === 'sms' ? String(body).slice(0, 480) : String(body).slice(0, 5000);
    db.run(
      'INSERT INTO notifications(school_id,channel,recipient,subject,body,related,created_by) VALUES (?,?,?,?,?,?,?)',
      schoolId, channel, recipient, subject, text, related, userId,
    );
    return true;
  }

  let running = false;
  async function processQueue(limit = 25) {
    if (running) return 0;
    running = true;
    let done = 0;
    try {
      const rows = db.all("SELECT * FROM notifications WHERE status='queued' AND attempts<3 ORDER BY id LIMIT ?", limit);
      for (const n of rows) {
        try {
          const note = await providers[n.channel]({ to: n.recipient, subject: n.subject, body: n.body });
          db.run("UPDATE notifications SET status='sent', attempts=attempts+1, error=?, sent_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?", note || null, n.id);
        } catch (e) {
          const status = n.attempts + 1 >= 3 ? 'failed' : 'queued';
          db.run('UPDATE notifications SET status=?, attempts=attempts+1, error=? WHERE id=?', status, String(e.message).slice(0, 200), n.id);
        }
        done++;
      }
    } finally { running = false; }
    return done;
  }

  let timer = null;
  const start = (ms) => { if (ms > 0) { timer = setInterval(() => processQueue().catch(() => {}), ms); timer.unref(); } };
  const stop = () => clearInterval(timer);

  return { enqueue, processQueue, start, stop };
}

module.exports = { createNotifier };
