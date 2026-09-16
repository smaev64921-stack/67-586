/**
 * Что человек набрал → что понимает СДЭК.
 *
 * Зачем. Поиск города в оформлении отвечал «СДЭК не нашёл такой город» на
 * «екб», «г. Екатеринбург» и на любую опечатку, и покупатель упирался в
 * красную плашку: пунктов нет, выбрать нечего. Живой API СДЭК ищет строго
 * по началу названия, поэтому приводим запрос к нормальному виду здесь, а
 * в справочнике (server/cdek-open.js) дополнительно прощаем опечатку.
 */

/* «г.», «город», «пос.» и прочее в начале — для поиска это мусор. */
const PREFIX = /^(?:г|гор|город|пос|посёлок|поселок|пгт|рп|с|село|д|деревня|ст|станица|мкр)\.?\s+/i;

/* Народные сокращения. Слева — как пишут, справа — как в справочнике СДЭК. */
const SHORT = [
  [/^(?:мск|москва\s*сити)$/, 'Москва'],
  [/^(?:спб|сп6|питер|петербург|санкт\s*петербург|с\s*петербург)$/, 'Санкт-Петербург'],
  [/^(?:екб|екат|ебург|екатеринбур)$/, 'Екатеринбург'],
  [/^(?:нск|новосиб)$/, 'Новосибирск'],
  [/^(?:нн|н\s*новгород|нижний)$/, 'Нижний Новгород'],
  [/^(?:рнд|ростов\s*на\s*дону|ростов)$/, 'Ростов-на-Дону'],
  [/^(?:кзн)$/, 'Казань'],
  [/^(?:челяба|чел)$/, 'Челябинск'],
  [/^(?:нч|набережные\s*челны)$/, 'Набережные Челны'],
  [/^(?:влг|волга)$/, 'Волгоград'],
  [/^(?:крд|краснодар\s*край)$/, 'Краснодар'],
  [/^(?:влдвсток|владик)$/, 'Владивосток']
];

/** Ключ для сравнения: без ё, без знаков, одним пробелом. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Запрос, пригодный для поиска: без «г.», с развёрнутым сокращением. */
function cityQuery(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  /* «г. Екатеринбург» и «Екатеринбург, Свердловская обл.» — берём город. */
  s = s.replace(PREFIX, '').split(',')[0].trim();
  const key = norm(s);
  for (const [re, full] of SHORT) {
    if (re.test(key)) return full;
  }
  return s;
}

/** Расстояние Левенштейна, но дальше cap не считаем — незачем. */
function editDistance(a, b, cap = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Похоже ли на опечатку в названии: чем длиннее слово, тем щедрее. */
function looksLikeCity(needle, city) {
  const a = norm(needle);
  const b = norm(city);
  if (!a || !b) return false;
  if (b.includes(a)) return true;
  const cap = a.length >= 8 ? 2 : a.length >= 4 ? 1 : 0;
  if (!cap) return false;
  if (editDistance(a, b, cap) <= cap) return true;
  /* «нижний новгрод» — опечатка в одном слове составного названия. */
  const words = b.split(/[\s-]+/);
  return words.some((w) => w.length >= 5 && editDistance(a, w, cap) <= cap);
}

module.exports = { cityQuery, norm, looksLikeCity, editDistance };
