/**
 * Отправка email. Два пути, в порядке приоритета:
 *
 *   1) Resend (RESEND_API_KEY) — обычный HTTPS-запрос. Предпочтительнее:
 *      хостинги часто режут исходящие SMTP-порты 465/587, и тогда письма
 *      молча не уходят. Плюс Resend сам подписывает письма DKIM, а без
 *      подписи почтовики кладут письмо в спам.
 *   2) SMTP через nodemailer (SMTP_HOST/USER/PASS) — если Resend не задан.
 */
let transporter = null;

const RESEND_URL = 'https://api.resend.com/emails';
/* Дефолтный отправитель Resend: работает без своего домена, но письма
   уходят ТОЛЬКО на почту владельца аккаунта Resend. Для покупателей нужен
   подтверждённый домен (resend.com/domains) и RESEND_FROM на нём. */
const RESEND_SANDBOX_FROM = 'onboarding@resend.dev';

function resendKey() {
  return String(process.env.RESEND_API_KEY || '').trim();
}
function resendConfigured() {
  return !!resendKey();
}

function smtpConfigured() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  return !!(host && user && pass);
}

/** Почта вообще настроена хоть каким-то способом. */
function mailConfigured() {
  return resendConfigured() || smtpConfigured();
}

/** Кто в поле «От кого». Для Resend адрес обязан быть на его домене. */
function smtpFrom() {
  const explicit = String(
    process.env.MAIL_FROM || process.env.RESEND_FROM || process.env.SMTP_FROM || ''
  ).trim();
  if (explicit) return explicit;
  const user = String(process.env.SMTP_USER || '').trim();
  if (user) return user;
  return resendConfigured() ? RESEND_SANDBOX_FROM : '';
}

function replyTo() {
  return String(process.env.MAIL_REPLY_TO || '').trim();
}

/**
 * В инбоксе отправитель виден раньше темы: «Canvas» читается лучше,
 * чем shop@mail.ru. Если имя уже задано в переменной — не трогаем.
 */
function fromHeader(brand) {
  const raw = smtpFrom();
  if (!raw || raw.includes('<')) return raw;
  const name = String(brand || 'Canvas').replace(/["\\]/g, '').trim();
  return name ? `"${name}" <${raw}>` : raw;
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

/**
 * Resend отвечает понятным текстом, и его важно не потерять: чаще всего
 * это «домен не подтверждён» или «в песочнице можно писать только себе».
 */
async function sendViaResend({ to, subject, text, html, from, attachments }) {
  const body = {
    from,
    to: [to],
    subject,
    text,
    /* заголовок и текстовая часть обязательны: письмо без text-версии
       почтовики считают подозрительным */
    html: html || undefined
  };
  const rt = replyTo();
  if (rt) body.reply_to = [rt];
  /* content_id делает вложение встроенной картинкой (cid:), а не файлом
     в самом низу письма. */
  if (attachments && attachments.length) {
    body.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString('base64'),
      content_type: a.contentType,
      content_id: a.cid
    }));
  }

  let res;
  try {
    res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw Object.assign(new Error(`Resend недоступен: ${e.message}`), { status: 502 });
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && (data.message || data.error || data.name)) || `код ${res.status}`;
    throw Object.assign(new Error(`Resend отказал: ${msg}`), { status: res.status === 403 ? 503 : 502 });
  }
  return { ok: true, id: (data && data.id) || '', via: 'resend' };
}

async function sendMail({ to, subject, text, html, brand, attachments }) {
  const from = fromHeader(brand);
  if (!from) throw Object.assign(new Error('Не задан адрес отправителя'), { status: 503 });

  if (resendConfigured()) {
    return sendViaResend({ to, subject, text, html, from, attachments });
  }

  const tx = getTransporter();
  if (!tx) throw Object.assign(new Error('Почта не настроена'), { status: 503 });
  const rt = replyTo();
  /* text обязателен всегда: у части клиентов HTML отключён, и письмо без
     текстовой версии заметно чаще уезжает в спам. */
  await tx.sendMail({
    from,
    to,
    subject,
    text,
    html: html || undefined,
    replyTo: rt || undefined,
    attachments: attachments && attachments.length ? attachments : undefined
  });
  return { ok: true, via: 'smtp' };
}

/** Отправитель сидит на общем домене-песочнице Resend. */
function resendSandbox() {
  return resendConfigured() && /@resend\.dev>?\s*$/i.test(smtpFrom());
}

/** Что писать в логах при старте, чтобы не гадать, работает ли почта. */
function mailMode() {
  if (resendConfigured()) {
    return `Resend · от «${smtpFrom()}»${resendSandbox() ? ' · ПЕСОЧНИЦА' : ''}`;
  }
  if (smtpConfigured()) return `SMTP ${process.env.SMTP_HOST} · от «${smtpFrom()}»`;
  return 'OFF (нет RESEND_API_KEY и SMTP_*)';
}

/**
 * Тихая поломка почты дороже всего: письма «уходят», а покупатели их не
 * получают. Поэтому о песочнице кричим прямо в лог при каждом старте.
 */
function mailWarnings() {
  if (!resendSandbox()) return [];
  return [
    'Почта Resend работает в режиме песочницы: домен не подтверждён.',
    'Письма уйдут ТОЛЬКО на адрес владельца аккаунта Resend — покупатели',
    'сброс пароля по почте не получат, и письма с resend.dev почтовики',
    'кладут в «Спам». Что сделать:',
    '  1. resend.com/domains → добавить свой домен',
    '  2. внести показанные DNS-записи (SPF и DKIM) у регистратора домена',
    '  3. дождаться статуса Verified',
    '  4. RESEND_FROM=noreply@ваш-домен.ru и Redeploy'
  ];
}

module.exports = {
  smtpConfigured: mailConfigured,
  mailConfigured,
  resendConfigured,
  resendSandbox,
  sendMail,
  smtpFrom,
  fromHeader,
  mailMode,
  mailWarnings
};
