/**
 * Опциональная отправка email (SMTP через nodemailer).
 */
let transporter = null;

function smtpConfigured() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  return !!(host && user && pass);
}

function smtpFrom() {
  return String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
}

function getTransporter() {
  if (!smtpConfigured()) return null;
  if (transporter) return transporter;
  const nodemailer = require('nodemailer');
  const port = +(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE !== '0' && port === 465;
  transporter = nodemailer.createTransport({
    host: String(process.env.SMTP_HOST).trim(),
    port,
    secure,
    auth: {
      user: String(process.env.SMTP_USER).trim(),
      pass: String(process.env.SMTP_PASS).trim()
    }
  });
  return transporter;
}

async function sendMail({ to, subject, text }) {
  const tx = getTransporter();
  if (!tx) throw Object.assign(new Error('SMTP не настроен'), { status: 503 });
  const from = smtpFrom() || String(process.env.SMTP_USER).trim();
  await tx.sendMail({ from, to, subject, text });
  return { ok: true };
}

module.exports = { smtpConfigured, sendMail, smtpFrom };
