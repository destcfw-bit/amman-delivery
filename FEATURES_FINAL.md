# AMMAN DELIVERY FINAL V6 — Signature OS

## الهوية والتجربة الجديدة
- تفاعلات هادئة عند الضغط والتنقل.
- Signature Ring: علامة AMMAN عند الدخول والانتقالات المهمة.
- Startup Animation خاص بـ AMMAN DELIVERY.
- Sound Identity بثلاث نغمات: تفاعل / نجاح / تنبيه مع زر إيقاف.
- Graphite + AMMAN Red + Silver، وبطاقات محددة وحدود واضحة.
- Loading Skeletons ودعم Reduce Motion.

## الكابتن
- 4 أقسام سفلية فقط: الرئيسية، الحركات، التسوية، حسابي.
- Captain Card رقمية وهوية AMMAN خاصة بالكابتن.
- Balance Orb يوضح إلك/عليك بصرياً مع الإنتاج مقابل الالتزامات.
- Smart Movement Timeline بدل قائمة الكروت التقليدية.
- Reaction Animation للرياكشنات وتعديلات العمولة.
- Weekly Close Scene كإيصال رسمي عند ظهور أسبوع مقفل جديد.
- الأرشيف والتنبيهات والأمان موجودة كأدوات ثانوية داخل التطبيق بدون ازدحام الـDock.
- قواعد الجرد والمحاسبة الحالية محفوظة دون تغيير.

## الإدارة
- Admin Command Center بتصميم أغمق وأنظف.
- Live Status Strip: WhatsApp / DB / Worker / Groups / Queue.
- Group Radar يعرض القروبات، الفعالين، الموقوفين، وغير المسجلين بصرياً.
- Runtime endpoint جديد مع فحص DB، Worker heartbeat، DropConnect state وعدد القروبات والطابور.

## البنية
- runtime_status table لنبض الـWorker.
- Worker heartbeat كل 15 ثانية.
- `/api/admin/runtime-status` للإدارة.
- لا تغيير على منطق الجرد أو التسويات أو قواعد المحاسبة الأساسية.

