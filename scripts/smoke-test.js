/**
 * اختبار وحدات شامل لمحرك الدمج والتخزين — لا يحتاج شبكة خارجية.
 * يغطي: توليد فيديوهين مختلفَي الدقة (أحدهما بلا صوت) ← رفع أجزاء ← دمج ←
 * التحقق من الدقة/المدة/الصوت/faststart ← Range في التخزين ← حذف شامل ← تنظيف المنتهي.
 *
 * التشغيل: node scripts/smoke-test.js
 */
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  db,
  ensureSchema,
  createJob,
  getJob,
  storeChunk,
  updateJob,
  readOutputChunks,
  getOutputSize,
  cleanExpired,
  deleteJob,
  CHUNK_SIZE,
} = require("../lib/database");
const {
  runMerge,
  probe,
  assertPublicUrl,
  getFfmpegPath,
  MAX_SOURCES,
  SOURCE_MAX_MB,
  OUTPUT_MAX_MB,
  MAX_DURATION_SEC,
} = require("../lib/merger");

const TMP = path.join(os.tmpdir(), "video-merger-test-" + Date.now());
const results = [];
let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    results.push(`  ✓ ${label}`);
  } else {
    failed++;
    results.push(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function ffmpeg(args) {
  execFileSync(getFfmpegPath(), args, { stdio: "pipe", timeout: 60_000, windowsHide: true });
}

async function main() {
  console.log("🎬 اختبار وحدات Video Merger\n");
  fs.mkdirSync(TMP, { recursive: true });
  await ensureSchema();

  /* 1) توليد فيديوهين اختباريين */
  const v1 = path.join(TMP, "red-640x480-audio.mp4");
  const v2 = path.join(TMP, "blue-1280x720-silent.mp4");

  ffmpeg([
    "-f", "lavfi", "-i", "color=c=red:s=640x480:d=3:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-y", v1,
  ]);
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=blue:s=1280x720:d=3:r=30",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-an", "-y", v2,
  ]);

  const i1 = probe(v1);
  const i2 = probe(v2);
  check("فيديو 1: 640x480 مع صوت", i1.width === 640 && i1.height === 480 && i1.hasAudio, JSON.stringify(i1));
  check("فيديو 2: 1280x720 بلا صوت (لاختبار مسار الصمت)", i2.width === 1280 && i2.height === 720 && !i2.hasAudio, JSON.stringify(i2));

  /* 2) إنشاء مهمة ورفع الملفات كأجزاء (محاكاة /api/upload) */
  const jobId = "unit" + crypto.randomUUID().slice(0, 8);
  const files = [v1, v2];
  const job = await createJob(
    jobId,
    files.map((f) => ({ kind: "file", name: path.basename(f), size: fs.statSync(f).size, mime: "video/mp4" })),
  );
  check("إنشاء المهمة + المصادر", job && job.sources.length === 2 && job.status === "queued");

  for (let seq = 0; seq < files.length; seq++) {
    const buf = fs.readFileSync(files[seq]);
    // نقسّم إلى أجزاء صغيرة لإثبات أن الترتيب يعتمد على رقم الجزء لا حجمه
    const partSize = 300_000;
    let k = 0;
    for (let off = 0; off < buf.length; off += partSize) {
      await storeChunk(jobId, seq, k, buf.subarray(off, Math.min(off + partSize, buf.length)));
      k++;
    }
  }
  const afterUpload = await getJob(jobId);
  check("كل المصادر اكتمل رفعها", afterUpload.sources.every((s) => s.chunksStored > 0));

  /* 3) الدمج الفعلي */
  const t0 = Date.now();
  const merged = await runMerge(jobId, afterUpload.sources);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  check("حالة المهمة = done", merged.status === "done", merged.errorMessage || "");
  check("التقدم = 100", merged.progress === 100, `progress=${merged.progress}`);
  check("الدقة = أكبر دقة مدخل (1280x720)", merged.resultResolution === "1280x720", merged.resultResolution);
  check(
    "المدة ≈ مجموع المدد (6 ثوانٍ)",
    merged.resultDuration && Math.abs(merged.resultDuration - 6) < 1.2,
    `duration=${merged.resultDuration}`,
  );
  check("حجم الناتج > 0 وضمن الحد", merged.resultSize > 0 && merged.resultSize <= OUTPUT_MAX_MB * 1024 * 1024, `size=${merged.resultSize}`);
  console.log(`     (زمن الدمج الفعلي: ${elapsed}s)`);

  /* 4) التحقق من الملف المخزَّن فعليًا */
  const total = await getOutputSize(jobId);
  const full = await readOutputChunks(jobId, 0, total - 1);
  check("حجم التخزين يطابق result_size", full && full.length === merged.resultSize, `${full?.length} vs ${merged.resultSize}`);
  check("عدد الأجزاء = ceil(size/2MB)", full.length <= Math.ceil(total / CHUNK_SIZE) * CHUNK_SIZE);

  const restored = path.join(TMP, "restored.mp4");
  fs.writeFileSync(restored, full);
  const info = probe(restored);
  check("الناتج 1280x720", info.width === 1280 && info.height === 720, `${info.width}x${info.height}`);
  check("الناتج يحتوي مسار صوت (مصدر صامت حصل على صمت)", info.hasAudio === true);
  check("مدة الناتج ≈ 6 ثوانٍ", Math.abs(info.duration - 6) < 1.2, `duration=${info.duration}`);

  const head = full.subarray(0, 8192).toString("latin1");
  const moov = head.indexOf("moov");
  const mdat = head.indexOf("mdat");
  check("faststart: moov قبل mdat في بداية الملف", moov >= 0 && (mdat === -1 || moov < mdat), `moov=${moov} mdat=${mdat}`);

  /* 5) دقة Range في طبقة التخزين */
  const r1 = await readOutputChunks(jobId, 0, 99);
  check("Range [0,99] = 100 بايت ومطابق", r1.length === 100 && r1.equals(full.subarray(0, 100)));

  const midStart = Math.floor(total / 2);
  const r2 = await readOutputChunks(jobId, midStart, midStart + 999);
  check("Range في المنتصف مطابق", r2.length === 1000 && r2.equals(full.subarray(midStart, midStart + 1000)));

  const r3 = await readOutputChunks(jobId, total - 50, total - 1);
  check("Range الذيل [-50] مطابق", r3.length === 50 && r3.equals(full.subarray(total - 50)));

  const r4 = await readOutputChunks(jobId, total + 10, total + 20);
  check("Range خارج الحدود يعيد null", r4 === null);

  /* 6) تنظيف أجزاء المصادر بعد النجاح */
  const remaining = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM source_chunks WHERE job_id = ?`,
    args: [jobId],
  });
  check("حُذفت أجزاء المصادر بعد نجاح الدمج", Number(remaining.rows[0].c) === 0, `count=${remaining.rows[0].c}`);

  /* 7) الحذف الشامل */
  await deleteJob(jobId);
  const gone = await getJob(jobId);
  const leftovers = await db.execute({
    sql: `SELECT (SELECT COUNT(*) FROM jobs WHERE id = ?) + (SELECT COUNT(*) FROM sources WHERE job_id = ?) + (SELECT COUNT(*) FROM source_chunks WHERE job_id = ?) + (SELECT COUNT(*) FROM output_chunks WHERE job_id = ?) AS c`,
    args: [jobId, jobId, jobId, jobId],
  });
  check("الحذف الشامل أزال كل الصفوف", gone === null && Number(leftovers.rows[0].c) === 0);

  /* 8) التنظيف الكسول للمنتهي */
  const expiredId = "exp" + crypto.randomUUID().slice(0, 8);
  await createJob(expiredId, [
    { kind: "url", url: "https://example.com/a.mp4" },
    { kind: "url", url: "https://example.com/b.mp4" },
  ]);
  await updateJob(expiredId, {});
  await db.execute({
    sql: `UPDATE jobs SET expires_at = ? WHERE id = ?`,
    args: [new Date(Date.now() - 3600_000).toISOString(), expiredId],
  });
  const removed = await cleanExpired();
  check("cleanExpired يحذف المهام المنتهية", removed >= 1 && (await getJob(expiredId)) === null, `removed=${removed}`);

  /* 9) حماية SSRF والحدود */
  let blocked = false;
  try { assertPublicUrl("http://127.0.0.1:8080/a.mp4"); } catch { blocked = true; }
  check("رفض رابط محلي (SSRF)", blocked);

  let ftpBlocked = false;
  try { assertPublicUrl("ftp://example.com/a.mp4"); } catch { ftpBlocked = true; }
  check("رفض بروتوكول غير http/https", ftpBlocked);

  check("حد المصادر = 10", MAX_SOURCES === 10);
  check("حد المصدر = 200MB", SOURCE_MAX_MB === 200);
  check("حد الناتج = 150MB", OUTPUT_MAX_MB === 150);
  check("حد المدة = 600 ثانية", MAX_DURATION_SEC === 600);

  /* 10) مهمة أقل من مقطعين تُرفض من المحرك */
  const oneId = "one" + crypto.randomUUID().slice(0, 8);
  await createJob(oneId, [{ kind: "url", url: "https://example.com/a.mp4" }]);
  const oneJob = await getJob(oneId);
  const oneResult = await runMerge(oneId, oneJob.sources);
  check("المحرك يرفض أقل من مقطعين", oneResult.status === "failed" && /مقطع/.test(oneResult.errorMessage || ""), oneResult.errorMessage);
  await deleteJob(oneId);

  /* النتيجة */
  console.log(results.join("\n"));
  console.log(`\n📊 النتيجة: ${passed} نجاح — ${failed} فشل`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("\n✗ خطأ غير متوقع:", err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
