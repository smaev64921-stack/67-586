/**
 * Сообщение админу «приложение обновилось».
 *
 * Зачем. Владелец жмёт «Обновить из Git» в панели хостинга и потом гадает,
 * доехала правка или нет: панель показывает «success» сразу, а контейнер
 * пересобирается ещё несколько минут. Теперь бот пишет сам — ровно в тот
 * момент, когда сервер уже поднялся на новой версии.
 *
 * Что считаем новой версией. Отпечаток файлов, которые видит покупатель.
 *   Не время запуска: сервер перезапускается и без выката (падение, перенос
 *   на другую машину хостинга), и писать «обновлено» на каждый такой раз —
 *   врать.
 *   Не номер коммита: на хостинге разворачивается собранная папка, .git там
 *   может и не быть.
 *
 * Кому пишем. Всем админам бота плюс тем, кто связал Telegram со своим
 * админским аккаунтом на сайте — их находим по почте в таблице users.
 * Список складываем, а не выбираем один: у владельца бывает и бот-админ,
 * и обычный вход по почте, и заранее не угадать, что из этого настроено.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./db');

const FILE = path.join(DATA_DIR, 'deploy-notice.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* Файлы, изменение которых и означает «вышла новая версия». Серверные модули
   сюда не берём: их правки почти всегда идут вместе с этими. */
const WATCH = ['index.html', 'onboarding.html', 'sw.js', 'manifest.webmanifest'];

function fingerprint() {
  const h = crypto.createHash('sha256');
  let read = 0;
  for (const name of WATCH) {
    try {
      h.update(name);
      h.update(fs.readFileSync(path.join(PUBLIC_DIR, name)));
      read += 1;
    } catch (_) {
      /* файла нет — так и запишем, это тоже часть отпечатка */
      h.update('missing');
    }
  }
  /* Ни одного файла не прочли — значит дело не в версии, а в правах или пути.
     Пустой отпечаток отличается от любого настоящего, и мы промолчим. */
  return read ? h.digest('hex').slice(0, 16) : '';
}

function readStored() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function writeStored(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.warn('deploy-notice: не смог записать отметку —', e.message);
    return false;
  }
}

/** Chat id всех, кому уместно сообщить о выкате. */
function recipients() {
  const ids = new Set();

  try {
    const { getOwnerChatIds } = require('./tg-owner');
    getOwnerChatIds().forEach((id) => ids.add(String(id)));
  } catch (_) {}

  /* Админы сайта: ищем по почте, как и просили. Связка «почта ↔ Telegram»
     появляется, когда человек привязал бота в своём профиле. */
  try {
    const { db } = require('./db');
    const { findLinkByUser } = require('./tg-users');
    const rows = db.prepare("SELECT id, email FROM users WHERE role = 'admin'").all();
    for (const r of rows) {
      const link = findLinkByUser(r.id, r.email);
      if (link && link.chatId) ids.add(String(link.chatId));
    }
  } catch (_) {
    /* нет таблицы или связок — обойдёмся админами бота */
  }

  return [...ids];
}

function messageText(stamp, url) {
  const when = new Date().toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const lines = [
    '✅ Приложение обновлено',
    '',
    'Магазин поднялся на новой версии — покупатели уже видят свежие правки.',
    `Версия: ${stamp}`,
    `Время: ${when}`
  ];
  if (url) lines.push('', url);
  return lines.join('\n');
}

/**
 * Сравнить отпечаток с прошлым запуском и, если он изменился, написать админам.
 * Ничего не бросает: упавшее уведомление не должно мешать магазину работать.
 */
async function run(opts = {}) {
  const stamp = fingerprint();
  if (!stamp) return { sent: 0, reason: 'нечего сверять' };

  const stored = readStored();
  if (stored.stamp === stamp) return { sent: 0, reason: 'версия та же' };

  /* Выкат на хостинге поднимает новый контейнер, не дожидаясь смерти старого,
     и оба успевают стартовать до того, как первый запишет отметку: версия для
     них одинаково новая, и админам прилетает два одинаковых сообщения подряд.
     Ровно это и случилось на первом же выкате. Минуты хватает, чтобы такие
     запуски разошлись, а два настоящих выката подряд за минуту не бывают. */
  const wasAt = stored.at ? Date.parse(stored.at) : 0;
  if (wasAt && Date.now() - wasAt < 60 * 1000) {
    return { sent: 0, reason: 'только что сообщали' };
  }

  /* Отметку ставим ДО отправки. Иначе бот, у которого нет сети, при каждом
     перезапуске пробовал бы заново и однажды прислал бы пачку одинаковых
     сообщений разом. Пропущенное уведомление дешевле стаи повторов. */
  writeStored({ stamp, at: new Date().toISOString() });

  let bot;
  try {
    bot = require('./telegram-bot');
  } catch (_) {
    return { sent: 0, reason: 'бот не подключён' };
  }
  if (!bot.configured || !bot.configured()) return { sent: 0, reason: 'бот не настроен' };

  const to = recipients();
  if (!to.length) return { sent: 0, reason: 'некому писать' };

  const text = messageText(stamp, opts.url || '');
  let sent = 0;
  for (const chatId of to) {
    try {
      await bot.sendText(chatId, text);
      sent += 1;
    } catch (e) {
      console.warn('deploy-notice: не доставлено в', chatId, '—', e.message);
    }
  }
  return { sent, of: to.length, stamp };
}

module.exports = { run, fingerprint, recipients, FILE };
