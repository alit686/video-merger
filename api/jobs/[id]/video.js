// GET /api/jobs/<id>/video — بث الناتج بدعم Range (206) و?download=1
const { once } = require("events");
const { getJob, streamOutputChunks, getOutputSize } = require("../../../lib/database");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

/** يحل مدى البايتات: bytes=a-b | bytes=a- | bytes=-n */
function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // آخر n بايت
    const suffix = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }

  const start = parseInt(rawStart, 10);
  let end = rawEnd === "" ? total - 1 : parseInt(rawEnd, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  end = Math.min(end, total - 1);
  if (start > end || start >= total) return null;
  return { start, end };
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", ...CORS });
    return res.end(JSON.stringify({ error: "طريقة غير مدعومة. استخدم GET." }));
  }

  const id = (req.params?.id || req.query?.id || "").split("/")[0];
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", ...CORS });
    return res.end(JSON.stringify({ error: "معرّف المهمة مطلوب." }));
  }

  const job = await getJob(id);
  if (!job) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", ...CORS });
    return res.end(JSON.stringify({ error: `المهمة غير موجودة: ${id}` }));
  }
  if (job.status !== "done") {
    res.writeHead(409, { "Content-Type": "application/json; charset=utf-8", ...CORS });
    return res.end(JSON.stringify({ error: `المهمة لم تكتمل بعد (الحالة: ${job.status}).` }));
  }

  const total = await getOutputSize(id);
  if (!total) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", ...CORS });
    return res.end(JSON.stringify({ error: "ملف الناتج غير موجود." }));
  }

  const download = String(req.query?.download || "") === "1";
  const baseHeaders = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=86400",
    ...(download ? { "Content-Disposition": `attachment; filename="merge_${id}.mp4"` } : {}),
    ...CORS,
  };

  const range = req.headers?.range ? parseRange(req.headers.range, total) : null;

  if (req.headers?.range && !range) {
    res.writeHead(416, { "Content-Type": "application/json; charset=utf-8", "Content-Range": `bytes */${total}`, ...CORS });
    return res.end(JSON.stringify({ error: "مدى البايتات غير صالح." }));
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const length = end - start + 1;

  res.writeHead(range ? 206 : 200, {
    ...baseHeaders,
    "Content-Length": length,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
  });

  if (req.method === "HEAD") return res.end();

  try {
    for await (const part of streamOutputChunks(id, start, end)) {
      if (!res.write(part)) await once(res, "drain");
    }
    res.end();
  } catch (err) {
    // الرؤوس أُرسلت بالفعل — ننهي الاتصال فقط
    try { res.destroy(err); } catch {}
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
