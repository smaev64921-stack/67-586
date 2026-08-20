/**
 * Сжатие ответов без внешних зависимостей (пакета compression в проекте нет).
 *
 * Раньше index.html (~640 КБ текста) и JSON каталога/CMS уходили как есть —
 * это и был главный вклад в «сайт долго грузится». Здесь два узких места
 * закрыты точечно, без подмены res.write/res.end у стримов:
 *   - jsonCompression() — сжимает ответы res.json();
 *   - serveTextFile()   — отдаёт html/js/css из памяти сразу в br и gzip.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MIN_SIZE = 1024;
/* Тело крупнее этого сжимаем асинхронно: синхронный br/gzip на мегабайтах
   останавливает весь event loop, и сервер замирает для всех остальных. */
const ASYNC_OVER = 96 * 1024;

function brOpts(size) {
  return {
    params: {
      /* на больших телах качество 5 стоит десятки миллисекунд CPU,
         а выигрыш по байтам почти тот же, что у 4 */
      [zlib.constants.BROTLI_PARAM_QUALITY]: size > ASYNC_OVER ? 4 : 5,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size
    }
  };
}

/** Что примет браузер: brotli лучше, gzip — запасной. */
function pickEncoding(req) {
  const accept = String((req.headers && req.headers['accept-encoding']) || '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return '';
}

function compress(buf, encoding) {
  if (encoding === 'br') return zlib.brotliCompressSync(buf, brOpts(buf.length));
  if (encoding === 'gzip') return zlib.gzipSync(buf, { level: 6 });
  return buf;
}

/** То же самое, но не блокируя event loop (zlib считает в своём пуле потоков). */
function compressAsync(buf, encoding) {
  return new Promise((resolve, reject) => {
    const cb = (err, out) => (err ? reject(err) : resolve(out));
    if (encoding === 'br') zlib.brotliCompress(buf, brOpts(buf.length), cb);
    else if (encoding === 'gzip') zlib.gzip(buf, { level: 6 }, cb);
    else resolve(buf);
  });
}

function etagOf(buf) {
  return '"' + crypto.createHash('sha1').update(buf).digest('base64').slice(0, 27) + '"';
}

/** Сжимает тело res.json(). Мелочь (< 1 КБ) не трогаем — накладные расходы больше выгоды. */
function jsonCompression() {
  return function (req, res, next) {
    const json = res.json.bind(res);
    res.json = (body) => {
      let text;
      try {
        text = JSON.stringify(body);
      } catch (_) {
        return json(body);
      }
      if (text === undefined) return json(body);
      const raw = Buffer.from(text, 'utf8');
      const encoding = raw.length >= MIN_SIZE ? pickEncoding(req) : '';
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Vary', 'Accept-Encoding');
      if (!encoding) return res.end(raw);
      const send = (out) => {
        if (res.writableEnded) return;
        res.setHeader('Content-Encoding', encoding);
        res.setHeader('Content-Length', out.length);
        res.end(out);
      };
      if (raw.length <= ASYNC_OVER) return send(compress(raw, encoding));
      /* крупный ответ (админские заказы с фото) — жмём в фоне */
      compressAsync(raw, encoding).then(send).catch(() => {
        if (!res.writableEnded) res.end(raw);
      });
      return res;
    };
    next();
  };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Текстовый файл из памяти, заранее сжатый. Кэш сбрасывается по mtime,
 * так что правка index.html подхватывается без перезапуска сервера.
 */
function serveTextFile(filePath, { cacheControl = 'no-cache' } = {}) {
  const type = TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  let cache = null;

  const build = () => {
    const stat = fs.statSync(filePath);
    if (cache && cache.mtime === stat.mtimeMs) return cache;
    const raw = fs.readFileSync(filePath);
    cache = {
      mtime: stat.mtimeMs,
      etag: etagOf(raw),
      raw,
      br: raw.length >= MIN_SIZE ? compress(raw, 'br') : null,
      gzip: raw.length >= MIN_SIZE ? compress(raw, 'gzip') : null
    };
    return cache;
  };

  return function (req, res) {
    let c;
    try {
      c = build();
    } catch (e) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', c.etag);
    if (String(req.headers['if-none-match'] || '').includes(c.etag)) {
      res.status(304).end();
      return;
    }
    const encoding = pickEncoding(req);
    const body = (encoding === 'br' && c.br) || (encoding === 'gzip' && c.gzip) || null;
    if (body) {
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', body.length);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    res.setHeader('Content-Length', c.raw.length);
    res.end(req.method === 'HEAD' ? undefined : c.raw);
  };
}

module.exports = { jsonCompression, serveTextFile, pickEncoding, compress, compressAsync, etagOf };
