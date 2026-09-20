'use strict';
const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');

const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.SF_HOST || '127.0.0.1',            // use 0.0.0.0 to expose on your network / a server
  dbFile: process.env.SF_DB || path.join(__dirname, 'data', 'schoolflow.db'),
  secureCookies: process.env.SF_SECURE_COOKIES === '1', // set to 1 behind HTTPS
  trustProxy: process.env.SF_TRUST_PROXY === '1',       // set to 1 behind nginx/Cloudflare so client IPs are real
  baseDomain: process.env.SF_BASE_DOMAIN || '',         // e.g. schoolflow.app -> greenfield.schoolflow.app gets its own branded login
  smsUrl: process.env.SF_SMS_URL, smsKey: process.env.SF_SMS_KEY, smsSender: process.env.SF_SMS_SENDER || 'SchoolFlow',
  emailUrl: process.env.SF_EMAIL_URL, emailKey: process.env.SF_EMAIL_KEY, emailFrom: process.env.SF_EMAIL_FROM,
};

const db = openDb(config.dbFile);
const { server } = createApp(db, config);
server.listen(config.port, config.host, () => {
  console.log(`SchoolFlow running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  if (!config.smsUrl) console.log('SMS/email: no gateway configured (SF_SMS_URL / SF_EMAIL_URL) — messages are logged, not delivered.');
});

const shutdown = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
