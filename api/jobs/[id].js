// GET /api/jobs/<id> — الحالة والتقدم والنتيجة
// DELETE /api/jobs/<id> — حذف فوري شامل
const { getJob, deleteJob } = require("../../lib/database");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(data, null, 2));
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  const id = req.params?.id || req.query?.id;
  if (!id) return send(res, 400, { error: "معرّف المهمة مطلوب." });

  const job = await getJob(id);
  if (!job) return send(res, 404, { error: `المهمة غير موجودة: ${id}` });

  if (req.method === "DELETE") {
    await deleteJob(id);
    return send(res, 200, { ok: true, message: "تم حذف المهمة وكل ملفاتها." });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { error: "طريقة غير مدعومة. استخدم GET أو DELETE." });
  }

  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001";
  const base = `${proto}://${host}`;

  const payload = {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    ...(job.status === "done"
      ? {
          videoUrl: `${base}/api/jobs/${job.id}/video`,
          downloadUrl: `${base}/api/jobs/${job.id}/video?download=1`,
          size: job.resultSize,
          duration: job.resultDuration,
          resolution: job.resultResolution,
        }
      : {}),
    ...(job.status === "failed" ? { error: job.errorMessage || "فشل الدمج." } : {}),
  };

  return send(res, 200, payload);
};
