# AMMAN DELIVERY FINAL V6 — Signature OS

## الهوية والتجربة الجديدة
- Click Pulse: نبضة أزرق → برتقالي من مكان الضغط.
- Signature Ring: علامة CP الدائرية عند الدخول والانتقالات المهمة.
- Startup Animation خاص بـ AMMAN DELIVERY.
- Sound Identity بثلاث نغمات: Click / Success / Warning مع زر إيقاف.
- Black Graphite + Electric Blue + Burnt Orange، مع Glass محدود وخطوط رفيعة.
- Loading Skeletons ودعم Reduce Motion.

## الكابتن
- 4 أقسام سفلية فقط: الرئيسية، الحركات، التسوية، حسابي.
- Captain Card رقمية وهوية CP خاصة بالكابتن.
- Balance Orb يوضح إلك/عليك بصرياً مع الإنتاج مقابل الالتزامات.
- Smart Movement Timeline بدل قائمة الكروت التقليدية.
- Reaction Animation للرياكشنات وتعديلات العمولة.
- Weekly Close Scene كإيصال رسمي عند ظهور أسبوع مقفل جديد.
- الأرشيف والتنبيهات والأمان موجودة كأدوات ثانوية داخل التطبيق بدون ازدحام الـDock.
- كل وظائف Tiger المحاسبية السابقة محفوظة.

## الإدارة
- Admin Command Center بتصميم أغمق وأنظف.
- Live Status Strip: WhatsApp / DB / Worker / Groups / Queue.
- Group Radar يعرض القروبات، الفعالين، الموقوفين، وغير المسجلين بصرياً.
- Runtime endpoint جديد مع فحص DB، Worker heartbeat، Green API state وعدد القروبات والطابور.

## البنية
- runtime_status table لنبض الـWorker.
- Worker heartbeat كل 15 ثانية.
- `/api/admin/runtime-status` للإدارة.
- لا تغيير على منطق الجرد أو التسويات أو قواعد المحاسبة الأساسية.

