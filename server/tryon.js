const { tryonServerConfigured } = require('./cms-safe');

/**
 * Примерка только на сервере.
 * Нужен TRYON_API_URL (+ опционально TRYON_API_KEY / OPENAI_API_KEY как Bearer).
 * Один OPENAI Images API не принимает person+garment — поэтому без URL не запускаем.
 */
function assertImagePayload(label, value) {
  const s = String(value || '');
  if (!s) {
    const err = new Error(`Нужен ${label}`);
    err.status = 400;
    throw err;
  }
  /* ~4MB base64 / data-URL — защита от злоупотребления памятью */
  if (s.length > 5_500_000) {
    const err = new Error(`${label}: слишком большой файл`);
    err.status = 413;
    throw err;
  }
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(s) && !/^https?:\/\//i.test(s)) {
    const err = new Error(`${label}: допустимы только изображения`);
    err.status = 400;
    throw err;
  }
}

async function runTryon({ personImage, garmentImage, productId, productName, brand }) {
  assertImagePayload('personImage', personImage);
  assertImagePayload('garmentImage', garmentImage);

  const customUrl = String(process.env.TRYON_API_URL || '').trim();
  const bearer = String(process.env.TRYON_API_KEY || process.env.OPENAI_API_KEY || '').trim();

  if (!customUrl) {
    const err = new Error('Примерка не настроена: укажите TRYON_API_URL в .env');
    err.status = 503;
    err.code = 'TRYON_NOT_CONFIGURED';
    throw err;
  }

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const res = await fetch(customUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      personImage,
      garmentImage,
      productId,
      productName,
      brand
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || ('Сервис примерки: ' + res.status));
    err.status = 502;
    throw err;
  }
  const out = data.image || data.imageUrl || data.result || data.url;
  if (!out) {
    const err = new Error('В ответе сервиса нет изображения');
    err.status = 502;
    throw err;
  }
  return { image: out };
}

module.exports = { runTryon, tryonServerConfigured };
