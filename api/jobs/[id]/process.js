// POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن)
const { getJob, updateJob } = require("../../../lib/database");
const { runMerge } = require("../../../lib/merger");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(data, null, 2));
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== "POST") {
    return send(res, 405, { error: "طريقة غير مدعومة. استخدم POST." });
  }

  const id = (req.params?.id || req.query?.id || "").split("/")[0];
  if (!id) return send(res, 400, { error: "معرّف المهمة مطلوب." });

  let job = await getJob(id);
  if (!job) return send(res, 404, { error: `المهمة غير موجودة: ${id}` });

  if (job.status === "processing") {
    return send(res, 202, { status: "processing", message: "المهمة قيد المعالجة بالفعل." });
  }
  if (job.status === "done") {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001";
    const base = `${proto}://${host}`;
    return send(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${id}/video`,
      downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
      size: job.resultSize,
      duration: job.resultDuration,
      resolution: job.resultResolution,
      expiresAt: job.expiresAt,
    });
  }

  // لا يمكن معالجة مهمة فاشلة إلا بمهمة جديدة
  if (job.status === "failed") {
    return send(res, 409, { error: `المهمة فاشلة: ${job.errorMessage || "فشل سابق"}. أنشئ مهمة جديدة.` });
  }

  // التحقق من اكتمال رفع الملفات قبل بدء المعالجة
  const pending = job.sources.filter((s) => s.kind === "file" && s.chunksStored === 0);
  if (pending.length) {
    return send(res, 409, {
      error: `لم تُرفع ${pending.length} من الملفات بالكامل بعد. أكمل الرفع ثم أعد المحاولة.`,
    });
  }

  try {
    job = await runMerge(id, job.sources);
  } catch (err) {
    await updateJob(id, { status: "failed", error_message: err.message }).catch(() => {});
    job = await getJob(id);
  }

  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001";
  const base = `${proto}://${host}`;

  if (!job || job.status !== "done") {
    return send(res, 500, { error: job?.errorMessage || "فشل الدمج." });
  }

  return send(res, 200, {
    status: "done",
    videoUrl: `${base}/api/jobs/${id}/video`,
    downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
    size: job.resultSize,
    duration: job.resultDuration,
    resolution: job.resultResolution,
    expiresAt: job.expiresAt,
  });
}

module.exports = handler;
// Vercel: مدة أقصى للدالة (يتطلب خطة تسمح بذلك)
module.exports.config = { maxDuration: 300 };
