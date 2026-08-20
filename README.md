# Canvas — магазин с ЮKassa

Один сервис: Express раздаёт витрину (`public/`) и API (`/api/*`), данные в SQLite (`data/shop.db`) через встроенный `node:sqlite` (Node.js 22+).

## Быстрый старт (локально)

```bash
cd "сайт одежды"
copy .env.example .env
npm install
npm start
```

Открой http://localhost:3000

**Админ по умолчанию** (из `.env`):

- email: `admin@luxecanvas.ru`
- пароль: `ChangeMe123!`

Войди на сайте → **Профиль** → чёрная карточка **«Открыть админку»**.  
Или сохрани закладку: `http://localhost:3000/#admin` (откроет админку после входа).  
Права выдаёт только сервер по `ADMIN_EMAIL` — без секретов в HTML.

## Что умеет сервер

| Метод | Путь | Назначение |
|--------|------|------------|
| GET | `/api/health` | Статус + ЮKassa on/off |
| GET | `/api/catalog` | Товары витрины |
| GET/PUT | `/api/cms` | Контент/промо/ПВЗ (PUT — админ) |
| GET | `/api/cdek/cities` | Поиск городов СДЭК |
| GET | `/api/cdek/deliverypoints` | Реальные ПВЗ СДЭК |
| POST | `/api/auth/register\|login` | Регистрация / вход |
| POST | `/api/checkout` | Заказ + ссылка на оплату ЮKassa |
| POST | `/api/yookassa/webhook` | Webhook оплаты |
| GET | `/api/orders/mine` | Заказы покупателя |
| GET/PATCH | `/api/admin/orders` | Админ: заказы |

Без `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET` заказ создаётся со статусом «Ожидает оплаты», но редиректа на оплату нет — это защита от фейкового «оплачено».

## СДЭК ПВЗ

Выбор пункта выдачи в заказе работает через официальный CDEK API v2. Ключи лежат только на сервере:

- `CDEK_CLIENT_ID` — Client ID / Account из кабинета СДЭК
- `CDEK_CLIENT_SECRET` — Client Secret / Secure password

Также поддерживаются алиасы `CDEK_ACCOUNT` и `CDEK_SECURE_PASSWORD`, если в панели хостинга удобнее назвать переменные как в кабинете СДЭК.

Без этих переменных карта ПВЗ покажет понятную ошибку и не даст оформить заказ с тестовым адресом.

Те же ключи нужны, чтобы по трек-номеру (или ссылке СДЭК) магазин сам смотрел статус в API v2 — это тот же метод, что `orders()->get()` в [официальном SDK](https://github.com/cdek-it/sdk2.0). В репозитории SDK ключей нет: Account и Secure password выдаёт СДЭК по договору. Если ключи заданы, при сохранении трека и дальше раз в 5 минут статус заказа двигается только вперёд: «В обработке» → «Едет» → «Доставлен». «Отменён», «Возврат» и неоплаченные заказы не трогаются.

## ЮKassa

1. Зарегистрируй магазин на [yookassa.ru](https://yookassa.ru)
2. Возьми **shopId** и **Секретный ключ** (сначала тестовый магазин)
3. Впиши в `.env` / переменные Railway:
   - `YOOKASSA_SHOP_ID=`
   - `YOOKASSA_SECRET=`
   - `PUBLIC_URL=https://твой-домен` (обязательно HTTPS в бою)
4. В кабинете ЮKassa укажи HTTP-уведомления:  
   `https://твой-домен/api/yookassa/webhook`  
   события: `payment.succeeded`, `payment.canceled`
5. Проверь тестовой картой → потом боевой режим

## Деплой: GitHub → Railway

1. Создай репозиторий на GitHub и залей код:

```bash
git init
git add .
git commit -m "Canvas shop with API and YooKassa"
git branch -M main
git remote add origin https://github.com/YOU/luxe-canvas.git
git push -u origin main
```

2. [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Variables (как в `.env.example`): `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PUBLIC_URL`, ЮKassa
4. Добавь **Volume** на путь `/app/data` (или задай `DATA_DIR`), чтобы SQLite не обнулялся при редеплое
5. Start command: `npm start` (Railway подхватит `PORT` сам)
6. Привяжи домен → пропиши тот же URL в `PUBLIC_URL` и в return URL / webhook ЮKassa

Альтернатива: Render.com (Web Service + persistent disk) — та же схема.

## Чеклист «можно продавать»

- [ ] ИП/ООО и договор с ЮKassa (тест → бой)
- [ ] В админке → Контент: юрлицо, ИНН, адрес, email, телефон
- [ ] Telegram / контакты для клиентов
- [ ] Реальные фото, цены, остатки в Каталоге
- [ ] СДЭК: указать `CDEK_CLIENT_ID` и `CDEK_CLIENT_SECRET`, проверить выбор реального ПВЗ
- [ ] Тексты доставки и возврата без заглушек
- [ ] Сменить `ADMIN_PASSWORD` и `JWT_SECRET`
- [ ] Прогнать: регистрация → заказ → тест-оплата → статус в админке → «Едет»
- [ ] (Опционально) `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — пуш о новых заказах

## Структура

```
package.json
server/          # Express + SQLite + ЮKassa
public/
  index.html     # витрина
  api-bridge.js  # клиент API
data/shop.db     # создаётся при первом запуске
```

## Безопасность

- `.env` в `.gitignore` — секреты не в git
- Заказ по `GET /api/orders/:num` только владельцу, админу или с одноразовым токеном `?t=` (return URL ЮKassa)
- Ключи OpenAI / примерки (`OPENAI_API_KEY`, `TRYON_API_*`) только на сервере; клиент бьёт в `POST /api/tryon`
- GitHub Pages **недостаточно** для продаж — нужен этот Node-сервер

## Важно

- CDEK API требует действующие ключи интернет-магазина СДЭК
