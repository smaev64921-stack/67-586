/**
 * Telegram Gateway — официальные Verification codes.
 * Docs: https://core.telegram.org/gateway/api
 * ~$0.01 за доставленный код (на свой номер — бесплатно после верификации в кабинете).
 */
function gatewayToken() {
  return String(
    process.env.TELEGRAM_GATEWAY_TOKEN ||
    process.env.GATEWAY_ACCESS_TOKEN ||
    process.env.TG_GATEWAY_TOKEN ||
    ''
  ).trim();
}

function configured() {
  const t = gatewayToken();
  return !!(t && t.length > 20 && !/^change/i.test(t));
}

function toE164(digits7) {
  const d = String(digits7 || '').replace(/\D/g, '');
  if (!/^7\d{10}$/.test(d)) return '';
  return `+${d}`;
}

function gatewayErrorCode(data, fallback) {
  if (data && data.error) return String(data.error);
  return String(fallback || 'GATEWAY_ERROR');
}

async function gatewayCall(method, body) {
  const token = gatewayToken();
  if (!token) throw Object.assign(new Error('TELEGRAM_GATEWAY_TOKEN не задан'), { status: 503 });

  const r = await fetch(`https://gatewayapi.telegram.org/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body || {})
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) {
    const err = gatewayErrorCode(data, `Gateway ${method} failed`);
    throw Object.assign(new Error(err), { status: 502, gateway: data, code: err });
  }
  return data.result;
}

async function checkSendAbility(phoneDigits) {
  const phone_number = toE164(phoneDigits);
  if (!phone_number) throw Object.assign(new Error('Некорректный номер'), { status: 400 });
  return gatewayCall('checkSendAbility', { phone_number });
}

/**
 * Отправить официальный verification code.
 * @param {string} phoneDigits — 7900…
 * @param {string} code — 4–8 цифр
 */
async function sendVerificationCode(phoneDigits, code) {
  const phone_number = toE164(phoneDigits);
  if (!phone_number) throw Object.assign(new Error('Некорректный номер'), { status: 400 });
  const codeStr = String(code || '').replace(/\D/g, '');
  if (codeStr.length < 4 || codeStr.length > 8) {
    throw Object.assign(new Error('Код 4–8 цифр'), { status: 400 });
  }

  let request_id;
  try {
    const ability = await checkSendAbility(phoneDigits);
    request_id = ability && ability.request_id;
  } catch (e) {
    const codeUp = String((e && (e.code || e.message)) || '').toUpperCase();
    /* Баланс / токен / номер — не маскируем повторным send с другой ошибкой */
    if (/BALANCE|ACCESS_TOKEN|UNAUTHORIZED|PHONE_NUMBER_INVALID|PHONE_NUMBER_NOT_AVAILABLE|FLOOD/i.test(codeUp)) {
      throw e;
    }
    console.warn('Gateway checkSendAbility:', e.message);
  }

  const payload = {
    phone_number,
    code: codeStr,
    ttl: 300
  };
  if (request_id) payload.request_id = request_id;

  const result = await gatewayCall('sendVerificationMessage', payload);
  return {
    ok: true,
    requestId: result.request_id || request_id || null,
    cost: result.request_cost,
    remaining: result.remaining_balance,
    delivery: result.delivery_status || null,
    raw: result
  };
}

async function reportCodeEntered(requestId, code) {
  if (!requestId) return null;
  try {
    return await gatewayCall('checkVerificationStatus', {
      request_id: requestId,
      code: String(code || '')
    });
  } catch (e) {
    console.warn('Gateway checkVerificationStatus:', e.message);
    return null;
  }
}

module.exports = {
  configured,
  gatewayToken,
  checkSendAbility,
  sendVerificationCode,
  reportCodeEntered,
  toE164
};
