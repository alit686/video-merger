// POST /api/jobs — إنشاء مهمة دمج (روابط مباشرة و/أو ملفات للرفع)
const crypto = require("crypto");
const { createJob } = require("../lib/database");
const { MAX_SOURCES, assertPublicUrl } = require("../lib/merger");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(data, null, 2));
}

/** تنظيف كسول — لا نعطّل الطلب إن فشل */
async function lazyCleanup() {
  try {
    const { cleanExpired } = require("../lib/database");
    await cleanExpired();
  } catch {}
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== "POST") {
    return send(res, 405, { error: "طريقة غير مدعومة. استخدم POST." });
  }

  await lazyCleanup();

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return send(res, 400, { error: "يُرجى إرسال JSON صحيح." });
  }

  const sources = [];

  // صيغة مختصرة: {"videos": ["https://…", "https://…"]}
  if (Array.isArray(body.videos)) {
    for (const v of body.videos) {
      if (typeof v !== "string" || !v.trim()) {
        return send(res, 400, { error: "كل عناصر videos يجب أن تكون روابط نصية غير فارغة." });
      }
      try {
        assertPublicUrl(v.trim());
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      sources.push({ kind: "url", url: v.trim() });
    }
  }

  // صيغة موسّعة: {"sources": [{kind:"url",url}, {kind:"file",name,size,mime}]}
  if (Array.isArray(body.sources)) {
    for (const s of body.sources) {
      if (!s || typeof s !== "object") {
        return send(res, 400, { error: "عنصر sources غير صالح." });
      }
      if (s.kind === "url") {
        if (typeof s.url !== "string" || !s.url.trim()) {
          return send(res, 400, { error: "مصدر الرابط يحتاج url نصيًا." });
        }
        try {
          assertPublicUrl(s.url.trim());
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
        sources.push({ kind: "url", url: s.url.trim() });
      } else if (s.kind === "file") {
        if (typeof s.name !== "string" || !s.name.trim()) {
          return send(res, 400, { error: "مصدر الملف يحتاج name." });
        }
        const size = Math.max(0, parseInt(s.size, 10) || 0);
        if (size > 200 * 1024 * 1024) {
          return send(res, 413, { error: "حجم أحد الملفات يتجاوز الحد 200MB." });
        }
        sources.push({
          kind: "file",
          name: s.name.trim(),
          size,
          mime: typeof s.mime === "string" && s.mime ? s.mime : "video/mp4",
        });
      } else {
        return send(res, 400, { error: "نوع المصدر يجب أن يكون url أو file." });
      }
    }
  }

  if (sources.length < 2) {
    return send(res, 400, { error: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو ملفات." });
  }
  if (sources.length > MAX_SOURCES) {
    return send(res, 400, { error: `❌ أقصى عدد مقاطع للدمج هو ${MAX_SOURCES} (خدمة الدمج تقبل ${MAX_SOURCES} مقاطع كحد أقصى).` });
  }

  const id = crypto.randomUUID().slice(0, 12);
  const job = await createJob(id, sources);

  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001";
  const base = `${proto}://${host}`;

  const hasFiles = sources.some((s) => s.kind === "file");
  const uploads = hasFiles
    ? sources
        .map((s, seq) => ({ s, seq }))
        .filter(({ s }) => s.kind === "file")
        .map(({ s, seq }) => ({
          seq,
          name: s.name,
          size: s.size,
          url: `${base}/api/upload?job=${id}&seq=${seq}`,
        }))
    : undefined;

  return send(res, 201, {
    jobId: id,
    status: hasFiles ? "uploading" : "queued",
    statusUrl: `${base}/api/jobs/${id}`,
    processUrl: `${base}/api/jobs/${id}/process`,
    expiresAt: job.expiresAt,
    ...(uploads ? { uploads, uploadChunkBytes: 4_000_000 } : {}),
  });
};
