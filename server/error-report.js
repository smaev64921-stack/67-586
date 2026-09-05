/**
 * Пересылка ошибок владельцу в Telegram.
 *
 * Проблема, которую это решает: почти все сбои на сайте ловятся в try/catch
 * и уходят в console.error — то есть в логи хостинга, куда никто не смотрит.
 * Так молча сломалась отправка почты, и заметили это случайно. Теперь любая
 * такая ошибка приходит в бот одному человеку — владельцу.
 *
 * Ловим четыре источника:
 *   1) console.error   — те самые «проглоченные» ошибки из catch;
 *   2) uncaughtException / unhandledRejection — падения процесса;
 *   3) ошибки Express  — всё, что долетело до обработчика 500;
 *   4) ошибки в браузере покупателя — их присылает сама страница.
 *
 * Главное здесь — не завалить чат. Одинаковые ошибки шлются раз в 10 минут
 * с числом повторов, а больше 25 сообщений в час бот не отправит вообще.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');
const { isLocal } = require('./public-url');

const LOG_FILE = path.join(DATA_DIR, 'errors.log');
const MAX_BYTES = 2 * 1024 * 1024;

/** Кому слать. Админов трое, но ошибки — забота одного. */
const CHAT = () =>
  String(
    process.env.TELEGRAM_ERROR_CHAT_ID ||
    process.env.TELEGRAM_DATA_OWNER_CHAT_ID ||
    '8133757512'
  ).trim();

/**
 * Локальный запуск. Разработческая копия поднимается с тем же токеном, что и
 * рабочая, и её ошибки — не новость для владельца, а шум. Пишем их только в
 * файл. Адрес проверяем лениво: хуки ставятся раньше, чем index.js успевает
 * разобраться с PUBLIC_URL.
 */
const LOCAL_RUN = () => isLocal(String(process.env.PUBLIC_URL || '').trim());

const ENABLED = () =>
  String(process.env.ERRORS_TO_TELEGRAM || '1') !== '0' && !LOCAL_RUN();
/** Перехват console.error можно выключить, оставив падения и Express. */
const HOOK_CONSOLE = () => String(process.env.ERRORS_HOOK_CONSOLE || '1') !== '0';

/* --- антиспам --- */
const REPEAT_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HOUR_LIMIT = 25;

const seen = new Map();
let hourStart = 0;
let hourCount = 0;
let mutedNotice = false;

/* Сообщения уходят по очереди, по одному. Раньше здесь стоял простой флаг
   «идёт отправка», и он глушил не только рекурсию, но и соседние ошибки:
   пока летело первое сообщение, второе и третье молча терялись. */
const queue = [];
let pumping = false;
/* А вот это — только против рекурсии: отправка может упасть и сама позвать
   console.error, который снова попросит отправку. */
let inSend = false;

const LEVELS = {
  crash: '🔥 Падение сервера',
  express: '🔴 Ошибка запроса',
  server: '🟠 Ошибка на сервере',
  client: '🟡 Ошибка у покупателя'
};

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cut(v, n) {
  const s = String(v == null ? '' : v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function rotate() {
  try {
    if (fs.statSync(LOG_FILE).size < MAX_BYTES) return;
    try { fs.unlinkSync(LOG_FILE + '.1'); } catch (_) {}
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch (_) {}
}

/** Лог на диске ведём всегда, даже когда в Telegram отправлять нельзя. */
function writeLog(row) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    rotate();
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n', 'utf8');
  } catch (_) {}
}

/** Разбираем что угодно: Error, строку, объект. */
function readError(err) {
  if (!err) return { message: 'неизвестная ошибка', stack: '' };
  if (err instanceof Error) {
    return { message: err.message || String(err), stack: String(err.stack || '') };
  }
  if (typeof err === 'object') {
    return {
      message: String(err.message || err.error || JSON.stringify(err)),
      stack: String(err.stack || '')
    };
  }
  return { message: String(err), stack: '' };
}

/** Строки стека из node_modules только шумят — оставляем свой код. */
function ownStack(stack) {
  return String(stack || '')
    .split('\n')
    .slice(1)
    .filter((l) => l.includes('at ') && !l.includes('node_modules') && !l.includes('node:internal'))
    .slice(0, 4)
    .map((l) => l.trim())
    .join('\n');
}

/**
 * По подписи решаем, новая это ошибка или повтор старой.
 * Стек намеренно не учитываем: одна и та же поломка часто прилетает из
 * разных мест кода, а владельцу это одна и та же новость. Зато числа,
 * айдишники и адреса из текста вычищаем, иначе «заказ 1201 не найден» и
 * «заказ 1202 не найден» посчитаются разными и завалят чат.
 */
function signature(scope, message) {
  const norm = String(message)
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return scope + '|' + norm;
}

function send(text) {
  queue.push(text);
  /* Телеграм не любит очередей длиной в тысячу: если бот недоступен,
     копить сообщения бесконечно бессмысленно — всё есть в логе. */
  if (queue.length > 30) queue.splice(0, queue.length - 30);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const text = queue.shift();
      inSend = true;
      try {
        const bot = require('./telegram-bot');
        if (bot.configured()) await bot.sendText(CHAT(), text);
      } catch (e) {
        /* Через console.error нельзя — попадём в собственный перехватчик. */
        process.stderr.write('[ERR-REPORT] не отправилось: ' + (e && e.message) + '\n');
      } finally {
        inSend = false;
      }
      /* пауза между сообщениями: у Telegram свои лимиты на частоту */
      await new Promise((r) => setTimeout(r, 350));
    }
  } finally {
    pumping = false;
  }
}

/** Сколько сообщений уже ушло за текущий час. */
function quotaLeft() {
  const now = Date.now();
  if (now - hourStart > HOUR_MS) { hourStart = now; hourCount = 0; mutedNotice = false; }
  return HOUR_LIMIT - hourCount;
}

function when() {
  return new Date().toLocaleString('ru-RU', { timeZone: process.env.TZ || 'Europe/Moscow' });
}

function format(scope, message, stack, meta, repeats) {
  const rows = [`<b>${LEVELS[scope] || LEVELS.server}</b>`, ''];
  rows.push(`<code>${esc(cut(message, 600))}</code>`);
  if (repeats > 1) rows.push(`\nПовторилась <b>${repeats}</b> раз(а) за последние 10 минут.`);

  const info = [];
  if (meta.method || meta.url) info.push(['Запрос', `${meta.method || ''} ${cut(meta.url, 160)}`.trim()]);
  if (meta.status) info.push(['Ответ', meta.status]);
  if (meta.user) info.push(['Пользователь', cut(meta.user, 80)]);
  if (meta.ip) info.push(['IP', meta.ip]);
  if (meta.page) info.push(['Страница', cut(meta.page, 160)]);
  if (meta.browser) info.push(['Браузер', cut(meta.browser, 120)]);
  if (info.length) {
    rows.push('');
    info.forEach(([k, v]) => rows.push(`${k}: <code>${esc(v)}</code>`));
  }

  const st = ownStack(stack);
  if (st) rows.push('', `<pre>${esc(cut(st, 700))}</pre>`);
  rows.push('', `<i>${esc(when())}</i>`);
  return cut(rows.join('\n'), 3800);
}

/**
 * Точка входа. Ничего не бросает и ничего не ждёт — сообщение уходит
 * в фоне, чтобы отчёт об ошибке сам не тормозил ответ покупателю.
 */
function report(scope, err, meta = {}) {
  const { message, stack } = readError(err);
  if (!message) return;

  const row = { t: new Date().toISOString(), scope, message: cut(message, 800), ...meta };
  if (stack) row.stack = cut(stack, 2000);
  writeLog(row);

  if (!ENABLED()) return;

  const key = signature(scope, message);
  const now = Date.now();
  const prev = seen.get(key);
  if (prev) {
    prev.count += 1;
    /* та же ошибка: молчим до конца окна, потом присылаем со счётчиком */
    if (now - prev.sentAt < REPEAT_MS) return;
    prev.sentAt = now;
    const repeats = prev.count;
    prev.count = 0;
    if (quotaLeft() <= 0) return;
    hourCount += 1;
    send(format(scope, message, stack, meta, repeats + 1));
    return;
  }

  if (seen.size > 400) seen.clear();
  seen.set(key, { count: 0, sentAt: now });

  const left = quotaLeft();
  if (left <= 0) {
    if (!mutedNotice) {
      mutedNotice = true;
      send(
        `<b>⚠️ Слишком много ошибок</b>\n\nЗа час больше ${HOUR_LIMIT} разных ошибок — ` +
        `остальные пишутся только в <code>data/errors.log</code>. Отправка возобновится через час.`
      );
    }
    return;
  }
  hourCount += 1;
  send(format(scope, message, stack, meta, 1));
}

/** Падения процесса. Сообщение уходит до того, как Node всё уронит. */
function installProcessHooks() {
  process.on('uncaughtException', (err) => {
    report('crash', err, { kind: 'uncaughtException' });
    process.stderr.write('[CRASH] ' + (err && err.stack ? err.stack : err) + '\n');
  });
  process.on('unhandledRejection', (reason) => {
    report('crash', reason, { kind: 'unhandledRejection' });
  });
}

/**
 * Перехват console.error. Именно здесь живут «скрытые» ошибки: их поймали
 * в catch, записали в консоль и забыли. Оригинальный вывод сохраняем.
 */
function installConsoleHook() {
  if (!HOOK_CONSOLE()) return;
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    try {
      if (inSend) return;
      const first = args.find((a) => a instanceof Error);
      const text = args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!text) return;
      report('server', first || text, {});
    } catch (_) {}
  };
}

module.exports = {
  report,
  installProcessHooks,
  installConsoleHook,
  chatId: CHAT,
  enabled: ENABLED,
  LOG_FILE
};
