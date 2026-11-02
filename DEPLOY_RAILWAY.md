# نشر AMMAN DELIVERY V6 على Railway

يفضل تشغيل 3 خدمات فقط:
1. Postgres
2. Admin service — `SITE_MODE=admin` — start: `npm start`
3. Captain service — `SITE_MODE=captain` — start: `npm start`

ولتشغيل معالجة واتساب شغّل Worker من نفس المستودع أو Service منفصلة بالأمر:
`npm run worker`

المتغيرات الأساسية: `DATABASE_URL`, `JWT_SECRET`, ومتغيرات Green API عند الربط.
الفحص: `/health`، وحالة الإدارة الداخلية: `/api/admin/runtime-status`.

