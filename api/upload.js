// POST /api/upload?job=<id>&seq=<n>&chunk=<k>
// جسم ثنائي (application/octet-stream) بحد 4MB — يحفظ الجزء في Turso مباشرة.
const { getJob, storeChunk, updateJob, countUploadedSources } = require("../lib/database");

const MAX_CHUNK = 4_000_000; // أقل من حد Vercel ~4.5MB

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(data));
}

/** يقرأ الجسم الثنائي بأي شكل يصل به (Buffer أو stream أو string) */
async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body instanceof ArrayBuffer) return Buffer.from(req.body);
  if (typeof req.body === "string") return Buffer.from(req.body, "binary");
  if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body));

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_CHUNK + 1) {
        req.destroy();
        reject(new Error("TOO_LARGE"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== "POST") {
    return send(res, 405, { error: "طريقة غير مدعومة. استخدم POST." });
  }

  const jobId = req.query?.job;
  const seq = parseInt(req.query?.seq, 10);
  const chunk = parseInt(req.query?.chunk, 10);

  if (!jobId || !Number.isInteger(seq) || seq < 0) {
    return send(res, 400, { error: "معاملات مطلوبة: job (معرّف) و seq (رقم المصدر)." });
  }
  if (!Number.isInteger(chunk) || chunk < 0 || chunk > 2000) {
    return send(res, 400, { error: "chunk يجب أن يكون عددًا صحيحًا غير سالب." });
  }

  const job = await getJob(jobId);
  if (!job) return send(res, 404, { error: "المهمة غير موجودة." });
  if (job.status === "done") return send(res, 409, { error: "المهمة مكتملة — لا يمكن الرفع." });
  if (job.status === "processing") return send(res, 409, { error: "المهمة قيد المعالجة — لا يمكن الرفع." });

  const source = job.sources.find((s) => s.seq === seq);
  if (!source || source.kind !== "file") {
    return send(res, 400, { error: `المصدر رقم ${seq} ليس ملفًا مرفوعًا.` });
  }

  const declared = parseInt(req.headers?.["content-length"] || "0", 10);
  if (declared > MAX_CHUNK) {
    return send(res, 413, { error: `حجم الجزء (${declared} بايت) يتجاوز الحد ${MAX_CHUNK} بايت.` });
  }

  let buf;
  try {
    buf = await readRawBody(req);
  } catch (err) {
    if (err.message === "TOO_LARGE") {
      return send(res, 413, { error: `حجم الجزء يتجاوز الحد ${MAX_CHUNK} بايت.` });
    }
    return send(res, 400, { error: "تعذّرت قراءة جسم الطلب." });
  }

  if (!buf || buf.length === 0) {
    return send(res, 400, { error: "جسم الطلب فارغ." });
  }
  if (buf.length > MAX_CHUNK) {
    return send(res, 413, { error: `حجم الجزء يتجاوز الحد ${MAX_CHUNK} بايت.` });
  }

  await storeChunk(jobId, seq, chunk, buf);

  // إذا اكتمل رفع كل الملفات، جهّز المهمة للمعالجة
  const { uploaded, total } = await countUploadedSources(jobId);
  if (total > 0 && uploaded === total && job.status === "uploading") {
    await updateJob(jobId, { status: "queued" }).catch(() => {});
  }

  return send(res, 200, {
    ok: true,
    jobId,
    seq,
    chunk,
    bytes: buf.length,
    sourcesUploaded: uploaded,
    sourcesTotal: total,
  });
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
