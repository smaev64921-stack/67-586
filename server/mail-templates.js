/**
 * HTML-письма магазина.
 *
 * Почтовые клиенты — это браузеры из нулевых: flex, grid, внешние стили и
 * <style> в <head> частью из них выбрасываются. Поэтому здесь только
 * таблицы и инлайновые стили, ширина 600 px. Единственная картинка —
 * логотип, и он прикреплён к самому письму (cid:), а не подгружается по
 * ссылке: внешние картинки Gmail и Outlook по умолчанию не показывают,
 * и шапка письма оставалась бы пустой. Если логотипа нет — на его месте
 * рисуется текстовая надпись, письмо не ломается.
 */

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Веб-шрифты в письмах не работают: Gmail вырезает @font-face, а Outlook
   не понимает его вовсе. Поэтому системный стек — тот же, что на сайте,
   только без Inter: Apple Mail возьмёт San Francisco, Windows — Segoe UI,
   Android — Roboto. Arial в самом конце как последний запасной вариант,
   иначе старый Outlook уходит в Times New Roman. */
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const INK = '#0b0b0b';
const MUTED = '#8a8a8a';
const SOFT = '#555555';
const LINE = '#ececec';
const PAGE = '#f2f2f2';
const CHIP = '#f7f7f7';
/* Знак в шапке письма: 238x400 ужимаем до аккуратного размера. Ширину и
   высоту обязательно дублируем атрибутами — Outlook игнорирует CSS. */
const LOGO_H = 76;
const LOGO_W = 45;

/** Невидимая строка: её показывает список писем рядом с темой. */
function preheader(text) {
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;font-size:1px;line-height:1px">${esc(text)}
    ${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>`;
}

/** Кнопка, которая переживает Outlook: цвет держит <td>, а не <a>. */
function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto">
    <tr><td align="center" bgcolor="${INK}" style="border-radius:8px">
      <a href="${esc(href)}" target="_blank" rel="noopener"
        style="display:inline-block;padding:17px 40px;font-family:${FONT};
        font-size:15px;font-weight:bold;line-height:1;color:#ffffff;text-decoration:none;border-radius:8px">${esc(label)}</a>
    </td></tr>
  </table>`;
}

function step(n, title, text) {
  return `<tr>
    <td width="30" valign="top" style="padding:0 12px 14px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td width="24" height="24" align="center" valign="middle" bgcolor="${INK}"
          style="border-radius:12px;font-family:${FONT};font-size:12px;
          font-weight:bold;color:#ffffff;line-height:24px">${n}</td></tr>
      </table>
    </td>
    <td valign="top" style="padding:0 0 14px;font-family:${FONT}">
      <div style="font-size:14px;font-weight:bold;color:${INK};line-height:1.4">${esc(title)}</div>
      <div style="font-size:13px;color:${SOFT};line-height:1.5;padding-top:2px">${esc(text)}</div>
    </td>
  </tr>`;
}

function shell({ brand, title, body, siteUrl, pre, logoCid }) {
  const home = siteUrl
    ? `<a href="${esc(siteUrl)}" target="_blank" rel="noopener" style="color:${MUTED};text-decoration:underline">${esc(
        String(siteUrl).replace(/^https?:\/\//i, '')
      )}</a>`
    : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-text-size-adjust:100%">
${preheader(pre || title)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE}">
  <tr><td align="center" style="padding:28px 12px 40px">

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
      style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:14px;overflow:hidden">

      <tr><td bgcolor="${INK}" align="center" style="background:${INK};padding:${logoCid ? '20px' : '22px'} 24px">
        ${logoCid
          ? `<img src="cid:${esc(logoCid)}" width="${LOGO_W}" height="${LOGO_H}" alt="${esc(brand)}"
              style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;
              width:${LOGO_W}px;height:${LOGO_H}px">`
          : `<span style="font-family:${FONT};font-size:15px;font-weight:bold;
              letter-spacing:3px;text-transform:uppercase;color:#ffffff">${esc(brand)}</span>`}
      </td></tr>

      <tr><td style="padding:34px 32px 32px">${body}</td></tr>
    </table>

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
      <tr><td align="center" style="padding:18px 16px 0;font-family:${FONT};
        font-size:12px;line-height:1.6;color:${MUTED}">
        Письмо отправлено автоматически — на него не нужно отвечать.${home ? `<br>${home}` : ''}
      </td></tr>
    </table>

  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Письмо со сбросом пароля.
 * Кода в письме нет: он открывается на странице по ссылке — так утёкший
 * предпросмотр письма в чужих руках ничего не даёт. Если публичного HTTPS
 * адреса у магазина нет, ссылка бесполезна — тогда шлём сам код.
 */
function resetEmail({ brand = 'Canvas', link = '', code = '', ttlMin = 20, siteUrl = '', logoCid = '' } = {}) {
  const h1 = `<h1 style="margin:0 0 12px;font-family:${FONT};font-size:25px;
    line-height:1.25;font-weight:bold;color:${INK};letter-spacing:-0.4px">Смена пароля</h1>`;
  const p = (t, extra = '') => `<p style="margin:0 0 ${extra || '18px'};font-family:${FONT};
    font-size:15px;line-height:1.6;color:${SOFT}">${t}</p>`;

  const note = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="padding:26px 0 0;border-top:1px solid ${LINE}">
        <p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED}">
          Если смену пароля запрашивали не вы — просто закройте письмо, пароль останется прежним.
          Никому не пересылайте ${link ? 'эту ссылку' : 'этот код'}: тот, у кого ${
    link ? 'она' : 'он'
  } окажется, сможет войти в ваш аккаунт.
        </p>
      </td></tr>
    </table>`;

  let body;
  let text;

  if (link) {
    body = `
      ${h1}
      ${p('Вы попросили сменить пароль в магазине. Откройте страницу — на ней можно получить код или сразу перейти на сайт: там мы всё проверим сами.')}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding:6px 0 22px">${button(link, 'Открыть')}</td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="background:${CHIP};border-radius:10px">
        <tr><td style="padding:20px 20px 6px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${step(1, 'Открыть страницу', 'Кнопка выше — она откроется в браузере.')}
            ${step(2, 'Получить код или перейти на сайт', 'Код вводится вручную, а по кнопке «Перейти на сайт» проверка пройдёт сама.')}
            ${step(3, 'Придумать новый пароль', 'Минимум 6 символов. После сохранения вы сразу войдёте.')}
          </table>
        </td></tr>
      </table>
      <p style="margin:20px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED}">
        Ссылка действует ${ttlMin} минут. Кнопка не сработала — скопируйте адрес:<br>
        <span style="color:${SOFT};word-break:break-all">${esc(link)}</span>
      </p>
      ${note}`;
    text = [
      `${brand} — смена пароля`,
      '',
      'Вы попросили сменить пароль. Откройте страницу:',
      link,
      '',
      'На ней можно получить код или сразу перейти на сайт — проверка пройдёт автоматически.',
      `Ссылка действует ${ttlMin} минут.`,
      '',
      'Если это были не вы — просто игнорируйте письмо, пароль останется прежним.'
    ].join('\n');
  } else {
    body = `
      ${h1}
      ${p('Вы попросили сменить пароль в магазине. Введите этот код на сайте вместе с новым паролем.')}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="background:${CHIP};border:1px solid ${LINE};border-radius:10px">
        <tr><td align="center" style="padding:24px 16px">
          <div style="font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:bold;
            letter-spacing:9px;color:${INK};line-height:1">${esc(code)}</div>
          <div style="font-family:${FONT};font-size:12px;color:${MUTED};padding-top:10px">
            действует ${ttlMin} минут</div>
        </td></tr>
      </table>
      <div style="height:22px;line-height:22px">&nbsp;</div>
      ${note}`;
    text = [
      `${brand} — смена пароля`,
      '',
      `Код: ${code}`,
      '',
      `Действует ${ttlMin} минут. Введите его на сайте вместе с новым паролем.`,
      'Если это были не вы — просто игнорируйте письмо.'
    ].join('\n');
  }

  return {
    subject: `Смена пароля · ${brand}`,
    text,
    html: shell({
      brand,
      title: `Смена пароля · ${brand}`,
      logoCid,
      pre: link
        ? `Ссылка для смены пароля — действует ${ttlMin} минут`
        : `Код для смены пароля — действует ${ttlMin} минут`,
      body,
      siteUrl
    })
  };
}

module.exports = { resetEmail, esc };
