/**
 * Разовое заведение товаров прямо из кода.
 *
 * Зачем это вообще. Обычно карточки заводит владелец в админке, и так и надо:
 * данные — его дело. Но иногда товар нужно поставить на витрину до того, как
 * у владельца дойдут руки, а доступа к его админскому входу у нас нет и быть
 * не должно. Тогда карточка едет тем же путём, что и код, — через выкат.
 *
 * ГЛАВНОЕ ПРАВИЛО: каждый посев применяется РОВНО ОДИН РАЗ и больше никогда.
 * Отметка о применении лежит отдельным файлом, а не проверяется по наличию
 * товара в базе. Разница принципиальная: если сверяться с базой, то владелец,
 * удаливший карточку, получит её обратно при первом же перезапуске — и не
 * поймёт, почему удалённое воскресает. С отметкой удаление окончательно, а
 * правки цены, фото и описания в админке живут своей жизнью и ничем отсюда
 * не перетираются.
 *
 * Фото лежат рядом обычными файлами и на старте превращаются в data:URL —
 * ровно то, что кладёт в базу форма товара. Дальше их подхватывает media.js
 * и раздаёт по /media/p/<id>/<хеш> с обычным кэшированием.
 */
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./db');
const { upsertProduct, listProducts } = require('./products');

const MARK = path.join(DATA_DIR, 'seeded.json');
const SEED_DIR = __dirname;

/** Файл картинки → data:URL. Пустая строка, если файла нет. */
function dataUrl(rel) {
  try {
    const buf = fs.readFileSync(path.join(SEED_DIR, rel));
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (e) {
    console.warn('seed: нет файла', rel, '—', e.message);
    return '';
  }
}

function readMarks() {
  try {
    const j = JSON.parse(fs.readFileSync(MARK, 'utf8'));
    return Array.isArray(j.applied) ? j.applied : [];
  } catch (_) {
    return [];
  }
}

function writeMarks(applied) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MARK, JSON.stringify({ applied }, null, 2));
    return true;
  } catch (e) {
    console.warn('seed: не смог записать отметку —', e.message);
    return false;
  }
}

/* --------------------------------------------------------------------------
   Сами посевы. Ключ — то, по чему считается «уже применён»; менять его нельзя,
   иначе товар заведётся второй раз.
   -------------------------------------------------------------------------- */
/** Фотографии косметички в порядке показа. */
function bagPhotos() {
  return [
    dataUrl('seed/bag/01-glavnoe.jpg'),
    dataUrl('seed/bag/02-vnutri.jpg'),
    dataUrl('seed/bag/03-razmery.jpg'),
    dataUrl('seed/bag/04-kachestvo.jpg'),
    dataUrl('seed/bag/05-korobka.jpg')
  ].filter(Boolean);
}

const SEEDS = [
  {
    key: 'bag-treeza-2026-09',
    title: 'косметичка-чехол TREEZA',
    sku: 'LC-BAG-TREEZA',
    build: () => {
      const photos = bagPhotos();
      /* Без фотографий карточку не заводим: пустая плитка на витрине хуже,
         чем отсутствующая. */
      if (!photos.length) return null;
      return {
        name: 'Косметичка-чехол',
        sku: 'LC-BAG-TREEZA',
        cat: 'Аксессуары',
        gender: 'u',
        price: 1290,
        old: 0,
        /* Размеров у неё не бывает — витрина такой товар понимает: подставляет
           служебный ONESIZE и нигде его не показывает. */
        sizes: [],
        stock: {},
        img: photos[0],
        gal: photos,
        desc: [
          'Чехол для стайлера и фена. Держит форму и не мнётся в сумке.',
          '',
          'Плотная джинсовая ткань, хлопковый подклад — не зацепляется.',
          'Внутри два глубоких кармана для насадок, стенки с уплотнителем.',
          'Крупная «собачка» на молнии — открывается одной рукой.',
          '',
          'Размеры: 31 × 13 × 13 см.'
        ].join('\n'),
        on: true
      };
    }
  },
  {
    /* Съёмка пришла в 3:4, а витрина показывает фото в рамке 2:3 и режет
       лишнее по бокам: у инфографики обрывался текст — «13 см» теряло букву,
       «для насадок» обрезалось, у коробки срезало края. Кадры дополнены до
       2:3 полями цвета студийного фона, у одного сняты впечатанные чёрные
       поля. Меняем только фотографии: название, цена и описание — дело
       владельца, их не трогаем. */
    key: 'bag-treeza-photos-2x3',
    title: 'фото косметички под рамку витрины',
    sku: 'LC-BAG-TREEZA',
    patch: (p) => {
      const photos = bagPhotos();
      if (!photos.length) return null;
      return { id: p.id, img: photos[0], gal: photos };
    }
  }
];

/**
 * Применить непринятые посевы. Ничего не бросает: упавший посев не должен
 * мешать магазину подняться.
 */
function run() {
  const applied = readMarks();
  const done = [];

  for (const seed of SEEDS) {
    if (applied.includes(seed.key)) continue;

    /* Подстраховка от повторного заведения, если отметка потерялась, а товар
       на месте: одинаковый артикул — почти наверняка он и есть. */
    let already = false;
    if (!seed.patch) {
      try {
        already = (listProducts({ all: true }) || []).some(
          (p) => String(p.sku || '').trim() === seed.sku
        );
      } catch (_) {}
    }

    try {
      if (seed.patch) {
        /* Правка существующей карточки. Нет её — значит владелец удалил;
           навязывать нечего, отмечаем как отработанный и идём дальше. */
        const cur = (listProducts({ all: true }) || [])
          .find((p) => String(p.sku || '').trim() === seed.sku);
        if (!cur) {
          console.log(`Посев «${seed.title}»: карточки нет, править нечего`);
        } else {
          const patch = seed.patch(cur);
          if (!patch) {
            console.warn(`Посев «${seed.title}»: нечем править, пропускаю`);
            continue;        /* отметку не ставим — попробуем в следующий раз */
          }
          upsertProduct({ ...cur, ...patch });
          console.log(`Посев «${seed.title}»: карточка #${cur.id} обновлена`);
        }
      } else if (already) {
        console.log(`Посев «${seed.title}»: уже есть в каталоге, пропускаю`);
      } else {
        const payload = seed.build();
        if (!payload) {
          console.warn(`Посев «${seed.title}»: нечего заводить, пропускаю`);
          continue;          /* отметку не ставим — попробуем в следующий раз */
        }
        const product = upsertProduct(payload);
        console.log(`Посев «${seed.title}»: карточка #${product.id} заведена`);
      }
      applied.push(seed.key);
      done.push(seed.key);
    } catch (e) {
      console.warn(`Посев «${seed.title}» не удался —`, e.message);
    }
  }

  if (done.length) writeMarks(applied);
  return done;
}

module.exports = { run, MARK };
