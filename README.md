# 🎬 Video Merger — موقع دمج الفيديوهات على Vercel

موقع كامل لدمج الفيديوهات بواجهة عربية داعمة لسحب الملفات وإفلاتها وإعادة ترتيبها، وواجهة برمجية API عامة للمطورين.

## 🚀 النشر على Vercel (خطوة بخطوة)

### 1. إنشاء قاعدة Turso مجانية

```bash
# ثبّت Turso CLI
npm install -g turso

# سجّل الدخول
turso auth login

# أنشئ قاعدة بيانات
turso db create video-merger

# احصل على URL
turso db show video-merger --url
# → turso://video-merger-<org>.turso.io

# أنشئ توكن
turso db tokens create video-merger
# → eyJ… (انسخه فورًا — لن يظهر مجددًا)
```

### 2. اربط المستودع بـ Vercel

1. ارفع المشروع إلى GitHub (أو GitLab/Bitbucket).
2. في [Vercel Dashboard](https://vercel.com), اضغط **Add New → Project** واستورد المستودع.
3. ⚠️ **Root Directory** = `video-merger` (المستودع يضم مشروعين).
4. **Framework Preset** = `Other`، و**Build Command**: اتركه فارغًا (لا يوجد بناء — `public/` ثابت و`api/` دوال).
5. في **Environment Variables** أضف:

| المتغير | القيمة | مطلوب |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://<db>-<org>.turso.io` | ✅ |
| `TURSO_AUTH_TOKEN` | توكن Turso | ✅ |
| `CRON_SECRET` | نص عشوائي طويل (يحمي `/api/cron`) | مستحسن |
| `MAX_SOURCES` | `3` | مستحسن (انظر الحدود أدناه) |
| `SOURCE_MAX_MB` | `100` | مستحسن |
| `OUTPUT_MAX_MB` | `120` | مستحسن |

6. اضغط **Deploy** (أول نشر ~1–2 دقيقة بسبب رفع ثنائيات ffmpeg).

> `vercel.json` يضمّن `ffmpeg` و`ffprobe` (نسخة linux-x64) داخل حزمة الدوال عبر `includeFiles`،
> ويضبط `maxDuration: 300` و`memory: 2048`.

### 3. جرّب API بـ curl بعد النشر

```bash
# إنشاء مهمة دمج
curl -X POST https://<your-domain>.vercel.app/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'

# تنفيذ الدمج (يحوي jobId من الاستجابة السابقة)
curl -X POST https://<your-domain>.vercel.app/api/jobs/<jobId>/process

# التحقق من الحالة
curl https://<your-domain>.vercel.app/api/jobs/<jobId>

# تحميل الناتج
curl https://<your-domain>.vercel.app/api/jobs/<jobId>/video?download=1 -o merge.mp4
```

### 4. الحدود التي يجب معرفتها

| الحد | القيمة |
|---|---|
| **مدة الدالة** (Hobby مع Fluid Compute) | 300 ثانية — يكفي `maxDuration: 300` |
| **مدة الدالة** (Pro) | 300s افتراضيًا، وحتى 800s |
| **حجم الطلب** | 4.5MB لكل طلب ← لذلك الرفع مقسّم إلى أجزاء 4MB |
| **قرص `/tmp`** | ~512MB لكل دالة ← **أهم قيد عملي** |
| **حجم الحزمة** (غير مضغوط) | 250MB (ffmpeg + ffprobe ≈ 152MB) |
| **حجم قاعدة Turso** (مجاني) | 500MB قاعدة بيانات + 500MB تخزين Blob |
| **عدد المقاطع** | 10 افتراضيًا (اضبطه على 3 على Vercel) |
| **حجم المصدر** | 200MB لكل مقطع (اضبطه على 100 على Vercel) |
| **حجم الناتج** | 150MB (اضبطه على 120 على Vercel) |
| **إجمالي المدة** | 600 ثانية (10 دقائق) |
| **صلاحية الملفات** | 24 ساعة (حذف تلقائي عبر cron) |

> ⚠️ **قيد `/tmp`:** تُنزَّل كل المصادر إلى `/tmp` قبل الدمج. مجموع المصادر + ملف الناتج يجب أن يبقى
> تحت ~450MB. على Vercel استخدم `MAX_SOURCES=3` و`SOURCE_MAX_MB=100` و`OUTPUT_MAX_MB=120`
> (300 + 120 = 420MB). القيم الافتراضية الكبيرة مناسبة للتشغيل المحلي فقط.

**ملاحظة Vercel:** `maxDuration: 300` يعمل على Hobby عند تفعيل Fluid Compute (الافتراضي للمشاريع الجديدة).

## 📡 توثيق API

### POST /api/jobs

إنشاء مهمة دمج جديدة.

```
POST /api/jobs
Content-Type: application/json

{"videos":["https://url1.mp4","https://url2.mp4"]}
```

أو مع رفع ملفات:

```json
{"sources":[{"kind":"url","url":"https://..."},{"kind":"file","name":"clip.mp4","size":1234567,"mime":"video/mp4"}]}
```

**استجابة (201):**
```json
{
  "jobId": "abc123def456",
  "status": "queued",
  "statusUrl": "https://.../api/jobs/abc123def456",
  "processUrl": "https://.../api/jobs/abc123def456/process",
  "expiresAt": "2025-01-01T00:00:00Z"
}
```

إذا وُجدت ملفات، ترجع `uploadChunkBytes` وروابط رفع لكل مصدر.

### POST /api/upload?job=<id>&seq=<n>&chunk=<k>

رفع جزء من ملف (Content-Type: application/octet-stream، ≤4MB).

### POST /api/jobs/<id>/process

تنفيذ الدمج. متزامن: يستغرق ~10-30 ثانية، يرجع رابط الفيديو.

### GET /api/jobs/<id>

الحالة والتقدم.

### GET /api/jobs/<id>/video

بث الفيديو النهائي (يدعم Range للترجيع في المشغل). استخدم `?download=1` للتحميل.

### DELETE /api/jobs/<id>

حذف فوري شامل (يحذف المهمة وكل المصادر والناتج).

### GET /api/config

الحدود العامة و version.

### GET /api/cron

تنظيف المهام المنتهية (مجَدول يوميًا).

## 🧪 الاختبارات

```bash
# كل الاختبارات (وحدة + HTTP) — 80 فحصًا
npm test

# اختبار الوحدة فقط (29 فحصًا: دمج حقيقي + Blob + Range + حذف)
npm run test:unit

# اختبار HTTP فقط (51 فحصًا: تدفق كامل عبر خادم محلي)
npm run test:http
```

اختبار HTTP يشغّل خادم تطوير على المنفذ `3101` وخادم ملفات على `3102` تلقائيًا، ثم يوقفهما بعد الانتهاء.

## 📦 هيكل المشروع

```
api/                    ← دوال Vercel Serverless
  jobs.js               ← POST /api/jobs
  upload.js             ← POST /api/upload
  config.js             ← GET /api/config
  cron.js               ← GET /api/cron
  jobs/
    [id].js             ← GET/DELETE /api/jobs/<id>
    [id]/
      process.js        ← POST /api/jobs/<id>/process
      video.js          ← GET /api/jobs/<id>/video
lib/
  database.js           ← قاعدة Turso + Blob (§5)
  merger.js             ← محرك ffmpeg (§4)
public/
  index.html            ← الواجهة الأمامية (RTL عربي)
scripts/
  dev-server.js         ← خادم تطوير محلي
  smoke-test.js         ← اختبار وحدة الدمج
vercel.json             ← تكوين النشر
.env.example            ← قالب متغيرات البيئة
```

## ⚙️ متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | — | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | ✅ | — | توكن قاعدة Turso |
| `MAX_SOURCES` | لا | `10` | أقصى عدد مقاطع — استخدم `3` على Vercel (قيد `/tmp`) |
| `SOURCE_MAX_MB` | لا | `200` | أقصى حجم للمصدر (MB) — استخدم `100` على Vercel |
| `OUTPUT_MAX_MB` | لا | `150` | أقصى حجم للناتج (MB) — استخدم `120` على Vercel |
| `MAX_TOTAL_DURATION_SEC` | لا | `600` | أقصى مدة إجمالية (ثوانٍ) |
| `FFMPEG_PRESET` | لا | `medium` | preset ffmpeg |
| `CRON_SECRET` | لا | — | إن ضُبط، يتطلب `Authorization: Bearer <secret>` على `/api/cron` |
| `ALLOW_PRIVATE_SOURCES` | لا | — | للاختبارات المحلية فقط: `1` يسمح بمصادر على localhost/شبكات خاصة. **لا تضبطه في الإنتاج.** |

## 🔒 ملاحظات أمنية

- لا تضع `.env` أو أي سر في Git — `.gitignore` يشملهم.
- المفاتيح لا تُطبع في السجلات.
- التنظيف التلقائي يمنع تراكم الملفات منتهية الصلاحية.
- حماية SSRF مفعّلة افتراضيًا: تُرفض الروابط الداخلية والبروتوكولات غير http/https.
- `ALLOW_PRIVATE_SOURCES` موجود لاختبارات التطوير فقط ولا يجب استخدامه على Vercel.
- ملفات الرفع والناتج تُحذف بعد 24 ساعة عبر `/api/cron` (مجدول يوميًا) وفحص كسول عند إنشاء مهمة.