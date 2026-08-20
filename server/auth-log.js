/**
 * Единый лог входа: запрос кода / выдача / вход / PUBLIC_URL.
 * Пишет в консоль и data/auth.log
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const LOG_FILE = path.join(DATA_DIR, 'auth.log');
const MAX_BYTES = 2 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size < MAX_BYTES) return;
    const bak = LOG_FILE + '.1';
    try { fs.unlinkSync(bak); } catch (_) {}
    fs.renameSync(LOG_FILE, bak);
  } catch (_) {}
}

function authLog(event, meta = {}) {
  const row = {
    t: new Date().toISOString(),
    event: String(event || 'event'),
    ...meta
  };
  const line = JSON.stringify(row);
  console.log('[AUTH]', row.event, meta && Object.keys(meta).length ? meta : '');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    console.warn('[AUTH] write fail:', e.message);
  }
  return row;
}

module.exports = { authLog, LOG_FILE };
