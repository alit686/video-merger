/**
 * اختبار HTTP متكامل ضد خادم التطوير (يحاكي Vercel):
 * إنشاء مهمة ← دمج ← بث Range/206 ← مهمة مختلطة (رابط + ملف مرفوع) ←
 * أخطاء (JSON تالف، عدد خاطئ، 413، 404، 405) ← حذف شامل.
 *
 * التشغيل: node scripts/http-test.js
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const APP_PORT = 3101;
const FILES_PORT = 3102;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const TMP = path.join(os.tmpdir(), "video-merger-http-" + Date.now());

let passed = 0;
let failed = 0;
const log = [];

function check(label, cond, detail) {
  if (cond) { passed++; log.push(`  ✓ ${label}`); }
  else { failed++; log.push(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

/** يقدّم ملفات الفيديو عبر HTTP لعمل روابط مصادر حقيقية */
function startFileServer() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || "/").split("?")[0].replace(/^\//, ""));
    const file = path.join(TMP, name);
    if (!fs.existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }
    const stat = fs.statSync(file);
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": stat.size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(FILES_PORT, "127.0.0.1", () => resolve(server)));
}

async function main() {
  console.log("🌐 اختبار HTTP متكامل — Video Merger\n");
  fs.mkdirSync(TMP, { recursive: true });

  const ffmpeg = require("ffmpeg-static");
  const ff = typeof ffmpeg === "string" ? ffmpeg : ffmpeg.path;
  const gen = (args) => execFileSync(ff, args, { stdio: "pipe", timeout: 60_000, windowsHide: true });

  const v1 = path.join(TMP, "a-640x480.mp4");
  const v2 = path.join(TMP, "b-1280x720.mp4");
  gen(["-f", "lavfi", "-i", "color=c=red:s=640x480:d=3:r=30", "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", v1]);
  gen(["-f", "lavfi", "-i", "color=c=green:s=1280x720:d=3:r=30",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", "-y", v2]);

  const fileServer = await startFileServer();

  // خادم التطبيق — ALLOW_PRIVATE_SOURCES=1 للسماح بمصادر الاختبار المحلية فقط
  const app = spawn(process.execPath, [path.join(__dirname, "dev-server.js")], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(APP_PORT), ALLOW_PRIVATE_SOURCES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  app.stdout.on("data", () => {});
  app.stderr.on("data", () => {});

  const up = await waitFor(`${BASE}/api/config`);
  check("خادم التطوير يعمل", up);
  if (!up) {
    app.kill("SIGKILL");
    fileServer.close();
    console.log(log.join("\n"));
    process.exit(1);
  }

  const createdJobs = [];

  try {
    /* ---------- 1) الإعدادات ---------- */
    const cfgRes = await fetch(`${BASE}/api/config`);
    const cfg = await cfgRes.json();
    check("GET /api/config → 200 + version", cfgRes.status === 200 && cfg.version === "2.0.0");
    check("الحدود في config مطابقة للمواصفة",
      cfg.maxSources === 10 && cfg.sourceMaxMB === 200 && cfg.outputMaxMB === 150 && cfg.maxTotalDurationSec === 600);

    /* ---------- 2) مهمة من رابطين ---------- */
    const u1 = `http://127.0.0.1:${FILES_PORT}/${path.basename(v1)}`;
    const u2 = `http://127.0.0.1:${FILES_PORT}/${path.basename(v2)}`;

    const createRes = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: [u1, u2] }),
    });
    const created = await createRes.json();
    check("POST /api/jobs → 201 + queued", createRes.status === 201 && created.status === "queued", JSON.stringify(created));
    check("الاستجابة تحتوي jobId/statusUrl/processUrl/expiresAt",
      Boolean(created.jobId && created.statusUrl && created.processUrl && created.expiresAt));
    check("Access-Control-Allow-Origin مفتوح", createRes.headers.get("access-control-allow-origin") === "*");
    createdJobs.push(created.jobId);

    const processRes = await fetch(`${BASE}/api/jobs/${created.jobId}/process`, { method: "POST" });
    const processed = await processRes.json();
    check("POST process → 200 + done", processRes.status === 200 && processed.status === "done", JSON.stringify(processed));
    check("النتيجة 1280x720 (أكبر دقة مدخل)", processed.resolution === "1280x720", processed.resolution);
    check("المدة ≈ 6 ثوانٍ", Math.abs((processed.duration || 0) - 6) < 1.2, `duration=${processed.duration}`);
    check("حجم الناتج > 0", processed.size > 0, `size=${processed.size}`);
    check("videoUrl على نفس الدومين", String(processed.videoUrl || "").startsWith(BASE), processed.videoUrl);
    check("downloadUrl يحتوي ?download=1", String(processed.downloadUrl || "").includes("download=1"));

    const jobRes = await fetch(`${BASE}/api/jobs/${created.jobId}`);
    const jobView = await jobRes.json();
    check("GET /api/jobs/<id> → done + progress=100",
      jobRes.status === 200 && jobView.status === "done" && jobView.progress === 100,
      JSON.stringify(jobView));

    /* ---------- 3) البث وRange ---------- */
    const fullRes = await fetch(`${BASE}/api/jobs/${created.jobId}/video`);
    const fullBuf = Buffer.from(await fullRes.arrayBuffer());
    check("GET video (كامل) → 200", fullRes.status === 200);
    check("Content-Type = video/mp4", String(fullRes.headers.get("content-type")).includes("video/mp4"));
    check("Accept-Ranges = bytes", fullRes.headers.get("accept-ranges") === "bytes");
    check("Content-Length يطابق المدة المخزنة", Number(fullRes.headers.get("content-length")) === fullBuf.length);
    check("الملف يبدأ بـ ftyp (MP4 صالح)", fullBuf.subarray(4, 8).toString("latin1") === "ftyp");

    const rangeRes = await fetch(`${BASE}/api/jobs/${created.jobId}/video`, { headers: { Range: "bytes=0-99" } });
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
    check("Range 0-99 → 206", rangeRes.status === 206, `status=${rangeRes.status}`);
    check("Content-Range صحيح", rangeRes.headers.get("content-range") === `bytes 0-99/${fullBuf.length}`, rangeRes.headers.get("content-range"));
    check("Length = 100", rangeBuf.length === 100);
    check("بايتات Range مطابقة للملف الكامل", rangeBuf.equals(fullBuf.subarray(0, 100)));

    const openRange = await fetch(`${BASE}/api/jobs/${created.jobId}/video`, { headers: { Range: "bytes=100-" } });
    const openLen = Number(openRange.headers.get("content-length"));
    check("Range مفتوح → 206 + طول صحيح", openRange.status === 206 && openLen === fullBuf.length - 100, `${openRange.status}/${openLen}`);

    const suffix = await fetch(`${BASE}/api/jobs/${created.jobId}/video`, { headers: { Range: "bytes=-50" } });
    check("Range لاحقة -50 → 206 + 50 بايت", suffix.status === 206 && Number(suffix.headers.get("content-length")) === 50);

    const badRange = await fetch(`${BASE}/api/jobs/${created.jobId}/video`, { headers: { Range: "bytes=999999999-" } });
    check("Range خارج الحدود → 416", badRange.status === 416, `status=${badRange.status}`);

    const headRes = await fetch(`${BASE}/api/jobs/${created.jobId}/video`, { method: "HEAD" });
    check("HEAD video → 200 + Content-Length", headRes.status === 200 && Number(headRes.headers.get("content-length")) === fullBuf.length);

    /* ---------- 4) مهمة مختلطة: رابط + ملف مرفوع ---------- */
    const fileBuf = fs.readFileSync(v2);
    const mixedRes = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [
          { kind: "url", url: u1 },
          { kind: "file", name: "uploaded.mp4", size: fileBuf.length, mime: "video/mp4" },
        ],
      }),
    });
    const mixed = await mixedRes.json();
    check("مهمة مختلطة → 201 + uploading", mixedRes.status === 201 && mixed.status === "uploading", JSON.stringify(mixed));
    check("uploads تحتوي seq=1 الصحيح", Array.isArray(mixed.uploads) && mixed.uploads.length === 1 && mixed.uploads[0].seq === 1, JSON.stringify(mixed.uploads));
    createdJobs.push(mixed.jobId);

    // رفع 3 أجزاء بأحجام فعلية متساوية تقريبًا (يثبت أن التجميع يعتمد على ترتيب رقم الجزء)
    const third = Math.floor(fileBuf.length / 3);
    const splitAt = [0, third, third * 2, fileBuf.length];
    for (let k = 0; k < 3; k++) {
      const part = fileBuf.subarray(splitAt[k], splitAt[k + 1]);
      check(`حجم الجزء ${k} > 0`, part.length > 0, `len=${part.length}`);
      const upRes = await fetch(`${BASE}/api/upload?job=${mixed.jobId}&seq=1&chunk=${k}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: part,
      });
      check(`رفع الجزء ${k} → 200`, upRes.status === 200, `status=${upRes.status} ${await upRes.clone().text().catch(() => "")}`);
    }

    const processedMixed = await (await fetch(`${BASE}/api/jobs/${mixed.jobId}/process`, { method: "POST" })).json();
    check("دمج المختلط اكتمل", processedMixed.status === "done", JSON.stringify(processedMixed));
    check("مدة المختلط ≈ 6 ثوانٍ", Math.abs((processedMixed.duration || 0) - 6) < 1.2, `duration=${processedMixed.duration}`);

    /* ---------- 5) حالات الخطأ ---------- */
    const badJson = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    check("JSON تالف → 400", badJson.status === 400);

    const oneSrc = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: [u1] }),
    });
    const oneJson = await oneSrc.json();
    check("مقطع واحد → 400 برسالة عربية", oneSrc.status === 400 && /مقطعين|مقطعَين/.test(oneJson.error || ""), oneJson.error);

    const many = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.mp4`) }),
    });
    const manyJson = await many.json();
    check("أكثر من 10 → 400 يذكر الحد 10", many.status === 400 && /10/.test(manyJson.error || ""), manyJson.error);

    const ftp = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: ["ftp://example.com/a.mp4", u1] }),
    });
    check("بروتوكول ftp → 400", ftp.status === 400);

    // جزء أكبر من 4MB على مهمة مستقلة (المهمات المنتهية ترفض الرفع بـ409)
    const bigJobRes = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [
          { kind: "file", name: "big.mp4", size: 5_000_000, mime: "video/mp4" },
          { kind: "file", name: "small.mp4", size: 1_000, mime: "video/mp4" },
        ],
      }),
    });
    const bigJob = await bigJobRes.json();
    createdJobs.push(bigJob.jobId);
    const bigPart = Buffer.alloc(4_200_000, 1);
    const tooBig = await fetch(`${BASE}/api/upload?job=${bigJob.jobId}&seq=0&chunk=0`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bigPart,
    });
    check("رفع جزء >4MB → 413", tooBig.status === 413, `status=${tooBig.status}`);

    const uploadMissing = await fetch(`${BASE}/api/upload?job=nope123&seq=0&chunk=0`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("x"),
    });
    check("رفع لمهمة غير موجودة → 404", uploadMissing.status === 404);

    const getMissing = await fetch(`${BASE}/api/jobs/nope123`);
    check("GET مهمة غير موجودة → 404", getMissing.status === 404);

    const delMissing = await fetch(`${BASE}/api/jobs/nope123`, { method: "DELETE" });
    check("DELETE مهمة غير موجودة → 404", delMissing.status === 404);

    const wrongMethod = await fetch(`${BASE}/api/jobs`);
    check("GET /api/jobs → 405", wrongMethod.status === 405, `status=${wrongMethod.status}`);

    const cronRes = await fetch(`${BASE}/api/cron`);
    check("GET /api/cron → 200", cronRes.status === 200);

    /* ---------- 6) الحذف الشامل ---------- */
    const delRes = await fetch(`${BASE}/api/jobs/${created.jobId}`, { method: "DELETE" });
    check("DELETE المهمة → 200", delRes.status === 200);
    const afterDelete = await fetch(`${BASE}/api/jobs/${created.jobId}`);
    check("بعد الحذف → GET 404", afterDelete.status === 404);
    const videoAfter = await fetch(`${BASE}/api/jobs/${created.jobId}/video`);
    check("بعد الحذف → video 404", videoAfter.status === 404);

    /* ---------- 7) الواجهة ---------- */
    const pageRes = await fetch(`${BASE}/`);
    const html = await pageRes.text();
    check("الواجهة تُقدَّم وتحتوي RTL", pageRes.status === 200 && html.includes('dir="rtl"'));
    check("الواجهة تحتوي توثيق API", html.includes("توثيق API"));
  } finally {
    for (const id of createdJobs) {
      try { await fetch(`${BASE}/api/jobs/${id}`, { method: "DELETE" }); } catch {}
    }
    try { app.kill("SIGKILL"); } catch {}
    fileServer.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }

  console.log(log.join("\n"));
  console.log(`\n📊 النتيجة: ${passed} نجاح — ${failed} فشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("✗ خطأ غير متوقع:", err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
