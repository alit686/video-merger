// Video Merger — طبقة Turso: المهام + المصادر + أجزاء Blob
// كل Blob يُقسَّم إلى صفوف بحجم ثابت 2MB، والقراءة تتم بصفحات (8 صفوف) لتفادي
// تجاوز حدود الاستجابة وتقليل استهلاك الذاكرة على Vercel.
const { createClient } = require("@libsql/client");
const fs = require("fs");
const path = require("path");

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
const isRemote = Boolean(url && token);

// على Vercel لا يوجد نظام ملفات دائم — لذا نستخدم /tmp فقط للتطوير هناك.
// محليًا (وعند غياب متغيرات Turso) نستخدم ملف libSQL في .data لتسهيل التجربة.
let db;
if (isRemote) {
  db = createClient({ url, authToken: token });
} else {
  if (process.env.VERCEL) {
    console.warn("⚠️  TURSO_DATABASE_URL/TURSO_AUTH_TOKEN غير مضبوطة على Vercel — التخزين المحلي غير دائم.");
  }
  const dir = process.env.VERCEL ? "/tmp/video-merger" : path.join(__dirname, "..", ".data");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  db = createClient({ url: `file:${path.join(dir, "local.db")}` });
}

// حجم الجزء الواحد (حد Turso ~2MB لكل Blob)
const CHUNK_SIZE = 2 * 1024 * 1024;
const PAGE = 8;

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued',
        progress INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT DEFAULT (datetime('now', '+24 hours')),
        completed_at TEXT,
        num_sources INTEGER DEFAULT 0,
        result_size INTEGER,
        result_duration REAL,
        result_resolution TEXT,
        error_message TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS sources (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'url',
        url TEXT,
        file_name TEXT,
        file_size INTEGER,
        file_mime TEXT,
        chunks_stored INTEGER DEFAULT 0,
        PRIMARY KEY (job_id, seq)
      )`,
      `CREATE TABLE IF NOT EXISTS source_chunks (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, seq, chunk)
      )`,
      `CREATE TABLE IF NOT EXISTS output_chunks (
        job_id TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, chunk)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_expires ON jobs (expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status)`,
    ],
    "write",
  );
  schemaEnsured = true;
}

/** إنشاء مهمة + مصادرها. تنتهي صلاحيتها بعد 24 ساعة (ISO للعرض في الواجهة). */
async function createJob(id, sources) {
  await ensureSchema();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  await db.execute({
    sql: `INSERT INTO jobs (id, status, num_sources, created_at, expires_at) VALUES (?, 'queued', ?, ?, ?)`,
    args: [id, sources.length, now.toISOString(), expiresAt],
  });
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.kind === "url") {
      await db.execute({
        sql: `INSERT INTO sources (job_id, seq, kind, url) VALUES (?, ?, 'url', ?)`,
        args: [id, i, s.url],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO sources (job_id, seq, kind, file_name, file_size, file_mime) VALUES (?, ?, 'file', ?, ?, ?)`,
        args: [id, i, s.name || "", s.size || 0, s.mime || "video/mp4"],
      });
    }
  }
  return getJob(id);
}

/** استرجاع مهمة مع مصادرها */
async function getJob(id) {
  await ensureSchema();
  const [jobs, sources] = await Promise.all([
    db.execute({ sql: `SELECT * FROM jobs WHERE id = ?`, args: [id] }),
    db.execute({ sql: `SELECT * FROM sources WHERE job_id = ? ORDER BY seq`, args: [id] }),
  ]);
  if (!jobs.rows.length) return null;
  return rowToJob(jobs.rows[0], sources.rows);
}

function rowToJob(row, sourceRows) {
  const r = row;
  const sources = (sourceRows || []).map((s) => ({
    seq: Number(s.seq),
    kind: String(s.kind),
    url: s.url ? String(s.url) : null,
    fileName: s.file_name ? String(s.file_name) : null,
    fileSize: s.file_size ? Number(s.file_size) : null,
    fileMime: s.file_mime ? String(s.file_mime) : null,
    chunksStored: Number(s.chunks_stored || 0),
  }));
  return {
    id: String(r.id),
    status: String(r.status),
    progress: Number(r.progress || 0),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
    numSources: Number(r.num_sources || 0),
    resultSize: r.result_size ? Number(r.result_size) : null,
    resultDuration: r.result_duration ? Number(r.result_duration) : null,
    resultResolution: r.result_resolution ? String(r.result_resolution) : null,
    errorMessage: r.error_message ? String(r.error_message) : null,
    sources,
  };
}

/** الأعمدة المسموح تعديلها (حماية من أي مفتاح غريب) */
const JOB_FIELDS = new Set([
  "status",
  "progress",
  "completed_at",
  "result_size",
  "result_duration",
  "result_resolution",
  "error_message",
]);

/** تعديل جزئي للمهمة */
async function updateJob(id, fields) {
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!JOB_FIELDS.has(k)) continue;
    sets.push(`${k} = ?`);
    args.push(v === undefined ? null : v);
  }
  if (!sets.length) return getJob(id);
  args.push(id);
  await db.execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
  return getJob(id);
}

/** تخزين جزء من مصدر مرفوع */
async function storeChunk(jobId, seq, chunkIndex, data) {
  await ensureSchema();
  await db.execute({
    sql: `INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)`,
    args: [jobId, seq, chunkIndex, data],
  });
  // العدد التراكمي = أعلى فهرس + 1 (أرخص من COUNT(*) في كل جزء)
  await db.execute({
    sql: `UPDATE sources SET chunks_stored = ? WHERE job_id = ? AND seq = ? AND chunks_stored < ?`,
    args: [chunkIndex + 1, jobId, seq, chunkIndex + 1],
  });
}

/** قراءة كل أجزاء مصدر مرفوع في Buffer واحد (للكتابة إلى /tmp قبل ffmpeg) */
async function readChunks(jobId, seq) {
  const rows = [];
  let cursor = 0;
  while (true) {
    const result = await db.execute({
      sql: `SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk >= ? ORDER BY chunk LIMIT ?`,
      args: [jobId, seq, cursor, PAGE],
    });
    if (!result.rows.length) break;
    rows.push(...result.rows);
    cursor = Number(result.rows[result.rows.length - 1].chunk) + 1;
  }
  if (!rows.length) return null;
  return Buffer.concat(rows.map((r) => toBuffer(r.data)));
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
}

/** تخزين جزء من الناتج */
async function storeOutputChunk(jobId, chunkIndex, data) {
  await ensureSchema();
  await db.execute({
    sql: `INSERT OR REPLACE INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)`,
    args: [jobId, chunkIndex, data],
  });
}

/**
 * بث أجزاء الناتج ضمن مدى بايتات [start, end] كـ AsyncGenerator.
 * الأجزاء ذوات حجم ثابت (2MB) ما عدا الأخير، لذا موضع الجزء معروف رياضيًا.
 */
async function* streamOutputChunks(jobId, start = 0, end = Infinity) {
  const firstChunk = Math.max(0, Math.floor(start / CHUNK_SIZE));
  let cursor = firstChunk;
  while (true) {
    const result = await db.execute({
      sql: `SELECT chunk, data FROM output_chunks WHERE job_id = ? AND chunk >= ? ORDER BY chunk LIMIT ?`,
      args: [jobId, cursor, PAGE],
    });
    if (!result.rows.length) return;
    for (const row of result.rows) {
      const ci = Number(row.chunk);
      const chunkStart = ci * CHUNK_SIZE;
      if (chunkStart > end) return;
      const buf = toBuffer(row.data);
      const from = Math.max(0, start - chunkStart);
      const to = Math.min(buf.length, end - chunkStart + 1);
      if (from < to) yield buf.subarray(from, to);
    }
    cursor = Number(result.rows[result.rows.length - 1].chunk) + 1;
  }
}

/** جمع مدى من الناتج في Buffer (للاختبارات فقط — البث يستخدم streamOutputChunks) */
async function readOutputChunks(jobId, start = 0, end = Infinity) {
  const parts = [];
  for await (const part of streamOutputChunks(jobId, start, end)) parts.push(part);
  return parts.length ? Buffer.concat(parts) : null;
}

/** حجم الناتج الإجمالي */
async function getOutputSize(jobId) {
  const result = await db.execute({
    sql: `SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM output_chunks WHERE job_id = ?`,
    args: [jobId],
  });
  return Number(result.rows[0]?.total || 0);
}

/** حذف أجزاء المصادر بعد نجاح الدمج (الناتج فقط هو المطلوب) */
async function deleteSourceChunks(jobId) {
  await db.execute({ sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] });
}

/**
 * تنظيف كسول: يحذف المهام المنتهية وكل صفوفها (مصادر + أجزاء + ناتج).
 * نستخدم datetime(expires_at) لأن expires_at مخزّن بصيغة ISO.
 */
async function cleanExpired() {
  await ensureSchema();
  const ids = await db.execute({
    sql: `SELECT id FROM jobs WHERE datetime(expires_at) < datetime('now')`,
  });
  if (!ids.rows.length) return 0;
  const jobIds = ids.rows.map((r) => String(r.id));
  for (const id of jobIds) await deleteJob(id);
  return jobIds.length;
}

/** حذف شامل لمهمة في دفعة واحدة */
async function deleteJob(id) {
  await ensureSchema();
  await db.batch(
    [
      { sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM sources WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM jobs WHERE id = ?`, args: [id] },
    ],
    "write",
  );
}

/** كم مصدرًا مكتمل الرفع؟ (لتحديد جاهزية المهمة) */
async function countUploadedSources(jobId) {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM sources WHERE job_id = ? AND kind = 'file' AND chunks_stored > 0`,
    args: [jobId],
  });
  const total = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM sources WHERE job_id = ? AND kind = 'file'`,
    args: [jobId],
  });
  return { uploaded: Number(res.rows[0]?.c || 0), total: Number(total.rows[0]?.c || 0) };
}

module.exports = {
  db,
  CHUNK_SIZE,
  ensureSchema,
  createJob,
  getJob,
  updateJob,
  storeChunk,
  readChunks,
  storeOutputChunk,
  streamOutputChunks,
  readOutputChunks,
  getOutputSize,
  deleteSourceChunks,
  countUploadedSources,
  cleanExpired,
  deleteJob,
};
