# Что осталось сделать вам (по порядку)

Сайт и API уже задеплоены на Vercel (`https://drivefx.vercel.app`), база Upstash Redis (Free) подключена. Платежи выключены, пока нет ключей Stripe: окно оплаты просто не показывает кнопку, как и раньше.

## 1. Пароль админки (1 минута)
```
node tools/set-password.mjs
```
Введите длинный случайный пароль (32+ символа). Затем: `npx vercel deploy --prod --yes`.

## 2. Stripe (1–2 минуты, когда появится доступ)
1. Stripe Dashboard → Developers → API keys → **Create restricted key** с названием DriveFX. Права: Checkout Sessions (Write), Customers (Read), Subscriptions (Write), Payment Intents (Read), Charges (Read), Prices (Read), Billing Portal Configurations (Read). Скопируйте ключ `rk_live_...`.
2. В терминале: `stripe login`, затем
   ```
   node tools/finish-stripe.mjs --live
   ```
   Скрипт спросит ключ (ввод скрыт), создаст три товара с ценами в USD/EUR/GBP, billing portal и вебхук `https://drivefx.pro/stripe-webhook`, сам запишет `STRIPE_KEY` и `STRIPE_WEBHOOK_SECRET` в Vercel Production и задеплоит.
3. Stripe Dashboard → Settings → Public details: укажите ссылку на условия `https://drivefx.pro/terms.html` (нужна для галочки согласия).
4. Для теста без реальных денег: то же без `--live` с тестовым ключом `rk_test_...` (ключи попадут в Preview/Development). Тестовые данные хранятся отдельно (`DATA_PREFIX=sandbox`).

## 3. DNS в One.com (переключение домена)
Зайдите в One.com → Domains → drivefx.pro → DNS settings. Менять только две записи сайта:

| Запись | Было (сохраните для отката) | Стало |
|---|---|---|
| `drivefx.pro` (A) | 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153 | **216.198.79.1** и **64.29.17.1** |
| `www` (CNAME) | slamby-xt.github.io. | **92f2b06ead3f3988.vercel-dns-017.com.** |

Остальные записи (почта/MX, TXT и прочие) не трогайте. Nameservers One.com оставьте. Через 5–60 минут Vercel сам выпустит HTTPS. Проверка: `npx vercel domains verify drivefx.pro`.

Откройте сайт после переключения и проверьте, что в окне оплаты нет ошибок. `www.drivefx.pro` автоматически перенаправляется на `https://drivefx.pro` с сохранением пути и параметров.

## Откат
* DNS: вернуть записи из колонки «Было».
* Деплой: Vercel → Deployments → предыдущий → Promote to Production (или `npx vercel rollback`).
* Старый Cloudflare Worker и GitHub Pages продолжают работать, их никто не отключал.

## Перед merge в main
Ветка `vercel-migration` не отправлена на GitHub. Отправляйте и сливайте в `main` только после переключения DNS: `paywall.js` обращается к API на том же домене, а на GitHub Pages этого API нет.
