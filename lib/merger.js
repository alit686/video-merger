// محرك دمج الفيديو — ffmpeg داخل الدالة نفسها
// المبدأ: ffprobe لكل مصدر ← توحيد عبر filter_complex (scale+pad+fps+sar) ←
// concat مع مسار صوت صامت للمصادر بلا صوت ← libx264 CRF18 + AAC 192k + faststart.
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

const {
  updateJob,
  getJob,
  storeOutputChunk,
  getOutputSize,
  readChunks,
  deleteSourceChunks,
  CHUNK_SIZE,
} = require("./database");

/* ------------------------------ الإعدادات ------------------------------ */

const MAX_SOURCES = parseInt(process.env.MAX_SOURCES || "10", 10);
const SOURCE_MAX_MB = parseInt(process.env.SOURCE_MAX_MB || "200", 10);
const OUTPUT_MAX_MB = parseInt(process.env.OUTPUT_MAX_MB || "150", 10);
const MAX_DURATION_SEC = parseInt(process.env.MAX_TOTAL_DURATION_SEC || "600", 10);
const FFMPEG_PRESET = process.env.FFMPEG_PRESET || "medium";
const SOURCE_MAX_BYTES = SOURCE_MAX_MB * 1024 * 1024;
const OUTPUT_MAX_BYTES = OUTPUT_MAX_MB * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 270_000; // أقل من maxDuration=300

const TMP = path.join(os.tmpdir(), "video-merger-work");
try {
  fs.mkdirSync(TMP, { recursive: true });
} catch {}

/* ------------------------------ ثنائيات ffmpeg ------------------------------ */

function resolveFfmpeg() {
  if (typeof ffmpegStatic === "string") return ffmpegStatic;
  if (ffmpegStatic && ffmpegStatic.path) return ffmpegStatic.path;
  return process.env.FFMPEG_PATH || "ffmpeg";
}
function resolveFfprobe() {
  if (ffprobeStatic && ffprobeStatic.path) return ffprobeStatic.path;
  if (typeof ffprobeStatic === "string") return ffprobeStatic;
  return process.env.FFPROBE_PATH || "ffprobe";
}

/**
 * على بعض الاستضافات يفقد الثنائي صلاحية التنفيذ. ننسخه إلى /tmp بصلاحية 755.
 * على ويندوز لا نحتاج ذلك (الصلاحيات غير مطبّقة بنفس الشكل).
 */
function ensureExecutable(binPath) {
  if (!binPath) return binPath;
  if (process.platform === "win32") return binPath;
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    try {
      const target = path.join(TMP, path.basename(binPath));
      if (!fs.existsSync(target)) {
        fs.copyFileSync(binPath, target);
        fs.chmodSync(target, 0o755);
      }
      return target;
    } catch {
      return binPath;
    }
  }
}

function getFfmpegPath() {
  return ensureExecutable(resolveFfmpeg());
}
function getFfprobePath() {
  return ensureExecutable(resolveFfprobe());
}

/* ------------------------------ فحص المصادر ------------------------------ */

/** ffprobe: الدقة، fps، المدة، وجود الصوت */
function probe(input) {
  const ff = getFfprobePath();
  const res = spawnSync(
    ff,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  if (res.error) throw new Error(`تعذّر تشغيل ffprobe: ${res.error.message}`);
  if (res.status !== 0) {
    const msg = (res.stderr || Buffer.from("")).toString().trim().slice(0, 300);
    throw new Error(`تعذّر فحص المصدر${msg ? `: ${msg}` : ""}`);
  }
  const info = JSON.parse(res.stdout.toString() || "{}");
  const video = (info.streams || []).find((s) => s.codec_type === "video");
  const audio = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!video) throw new Error("المصدر لا يحتوي مسار فيديو صالحًا");
  const [fw, fh] = String(video.r_frame_rate || "30/1").split("/").map(Number);
  const fps = fh ? fw / fh : 30;
  const duration = parseFloat(info.format?.duration || video.duration || "0");
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    hasAudio: Boolean(audio),
    size: parseInt(info.format?.size || "0", 10) || 0,
  };
}

/* ------------------------------ تحميل المصادر ------------------------------ */

const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$|172\.(1[6-9]|2\d|3[01])\.)/i;

/** منع SSRF: نقبل فقط http/https لعناوين عامة */
function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error("رابط مصدر غير صالح");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("روابط المصادر يجب أن تكون http/https مباشرة");
  }
  const host = u.hostname.toLowerCase();
  // الاستثناء مخصص للاختبارات المحلية فقط (ALLOW_PRIVATE_SOURCES=1) — الإنتاج يبقى صارمًا
  const allowPrivate = process.env.ALLOW_PRIVATE_SOURCES === "1";
  if (!allowPrivate && (PRIVATE_HOST_RE.test(host) || host.endsWith(".local") || host.endsWith(".internal"))) {
    throw new Error("لا يُسمح بروابط داخلية/خاصة كمصدر");
  }
  return u;
}

/** تنزيل مصدر إلى /tmp مع فرض الحد الأقصى للحجم أثناء التنزيل */
function downloadToFile(url, dest, maxBytes, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      } else resolve(dest);
    };

    let target;
    try {
      target = assertPublicUrl(url);
    } catch (err) {
      return done(err);
    }

    const lib = target.protocol === "https:" ? https : http;
    const req = lib.get(
      target,
      { headers: { "user-agent": "Mozilla/5.0 (compatible; VideoMerger/2.0)", accept: "*/*" }, timeout: 60_000 },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return done(new Error("عدد تحويلات الرابط كبير جدًا"));
          const next = new URL(res.headers.location, target).toString();
          return downloadToFile(next, dest, maxBytes, redirectsLeft - 1).then(done, done);
        }
        if (code !== 200) {
          res.resume();
          return done(new Error(`تعذّر تنزيل المصدر (HTTP ${code})`));
        }
        const declared = Number(res.headers["content-length"] || 0);
        if (declared && declared > maxBytes) {
          res.resume();
          return done(new Error(`حجم المصدر ${(declared / 1048576).toFixed(1)}MB يتجاوز الحد ${SOURCE_MAX_MB}MB`));
        }
        const out = fs.createWriteStream(dest);
        let received = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy();
            out.destroy();
            done(new Error(`حجم المصدر تجاوز الحد ${SOURCE_MAX_MB}MB`));
          }
        });
        res.on("error", done);
        out.on("error", done);
        out.on("finish", () => out.close(() => done(null)));
        res.pipe(out);
      },
    );
    req.on("timeout", () => req.destroy(new Error("انتهت مهلة تنزيل المصدر")));
    req.on("error", (err) => done(new Error(`تعذّر تنزيل المصدر: ${err.message}`)));
  });
}

/* ------------------------------ بناء فلتر الدمج ------------------------------ */

/** أبعاد زوجية داخل حدود 1080p */
function evenClamp(n, max) {
  const v = Math.min(Math.max(2, Math.round(n)), max);
  return v % 2 === 0 ? v : v - 1;
}

/**
 * يبني filter_complex يوحّد كل المصادر إلى targetW×targetH بنفس fps/sar/pixel format،
 * ويضمن لكل مقطع مسار صوت ستيريو 44.1kHz بطول الفيديو نفسه (صمت عند الحاجة).
 */
function buildFilterGraph(sources, targetW, targetH) {
  const chains = [];
  const concatInputs = [];

  sources.forEach((s, i) => {
    const dur = s.duration.toFixed(3);
    chains.push(
      `[${i}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,` +
        `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `setsar=1,fps=30,format=yuv420p[v${i}]`,
    );

    if (s.hasAudio) {
      chains.push(
        `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
          `apad,atrim=duration=${dur},asetpts=PTS-STARTPTS[a${i}]`,
      );
    } else {
      // مصدر بلا صوت: نولّد صمتًا بنفس المدة بدل أن يفشل الدمج
      chains.push(
        `anullsrc=r=44100:cl=stereo,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
          `atrim=duration=${dur},asetpts=PTS-STARTPTS[a${i}]`,
      );
    }
    concatInputs.push(`[v${i}][a${i}]`);
  });

  chains.push(
    `${concatInputs.join("")}concat=n=${sources.length}:v=1:a=1[outv][outa]`,
  );
  return { graph: chains.join(";"), targetW, targetH };
}

/* ------------------------------ تنفيذ ffmpeg ------------------------------ */

function runFfmpeg(args, totalDuration, jobId) {
  const ff = getFfmpegPath();
  return new Promise((resolve, reject) => {
    const proc = spawn(ff, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let settled = false;
    let stderrTail = "";
    let pendingLine = "";

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      fail(new Error("تجاوزت المعالجة المهلة المسموحة"));
    }, PROCESS_TIMEOUT_MS);

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }

    // تقدم الترميز: out_time_us من -progress pipe:1 (40% → 90%)
    let lastUpdate = 0;
    proc.stdout.on("data", (buf) => {
      pendingLine += buf.toString();
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() || "";
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && totalDuration > 0) {
          const seconds = Number(m[1]) / 1_000_000;
          const pct = Math.min(90, 40 + Math.round((seconds / totalDuration) * 50));
          const now = Date.now();
          if (now - lastUpdate > 900) {
            lastUpdate = now;
            // نحدّث دون انتظار حتى لا نعطّل قراءة التقدم
            updateJob(jobId, { progress: pct, status: "processing" }).catch(() => {});
          }
        }
      }
    });

    proc.stderr.on("data", (buf) => {
      stderrTail = (stderrTail + buf.toString()).slice(-2000);
    });

    proc.on("error", (err) => fail(new Error(`تعذّر تشغيل ffmpeg: ${err.message}`)));
    proc.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const msg = stderrTail.trim().split("\n").slice(-3).join(" | ").slice(0, 500);
        return fail(new Error(`فشل الترميز (ffmpeg code ${code})${msg ? `: ${msg}` : ""}`));
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

/* ------------------------------ تخزين الناتج ------------------------------ */

async function storeOutput(jobId, filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const totalSize = fs.fstatSync(fd).size;
    let offset = 0;
    let index = 0;
    while (offset < totalSize) {
      const size = Math.min(CHUNK_SIZE, totalSize - offset);
      const buf = Buffer.allocUnsafe(size);
      fs.readSync(fd, buf, 0, size, offset);
      await storeOutputChunk(jobId, index, buf);
      offset += size;
      index += 1;
      const pct = 90 + Math.min(9, Math.round((offset / totalSize) * 9));
      await updateJob(jobId, { progress: pct }).catch(() => {});
    }
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(filePath); } catch {}
  }
}

/* ------------------------------ التدفق الرئيسي ------------------------------ */

/**
 * ينفّذ الدمج كاملًا لمهمة قائمة: سحب 0–40، ترميز 40–90، تخزين 90–100.
 * يعيد المهمة المحدّثة. أي خطأ يُسجَّل على المهمة كحالة failed برسالة عربية.
 */
async function runMerge(jobId, sources) {
  const tmpFiles = [];
  try {
    // التحقق من العدد قبل أي تنزيل/معالجة
    if (sources.length < 2) {
      throw new Error("❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.");
    }
    if (sources.length > MAX_SOURCES) {
      throw new Error(`❌ أقصى عدد مقاطع للدمج هو ${MAX_SOURCES} (خدمة الدمج تقبل ${MAX_SOURCES} مقاطع كحد أقصى).`);
    }

    await updateJob(jobId, { status: "processing", progress: 3, error_message: null });

    const prepared = [];
    let totalDuration = 0;

    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      await updateJob(jobId, {
        progress: 3 + Math.round((i / sources.length) * 32),
      });

      let tmpFile;
      if (s.kind === "url") {
        tmpFile = path.join(TMP, `src_${jobId}_${i}_${Date.now()}.bin`);
        tmpFiles.push(tmpFile);
        await downloadToFile(s.url, tmpFile, SOURCE_MAX_BYTES);
      } else {
        const buf = await readChunks(jobId, s.seq);
        if (!buf || !buf.length) {
          throw new Error(`ملف المصدر رقم ${i + 1} لم يُرفع بالكامل`);
        }
        tmpFile = path.join(TMP, `src_${jobId}_${i}_${Date.now()}.bin`);
        tmpFiles.push(tmpFile);
        fs.writeFileSync(tmpFile, buf);
      }

      const info = probe(tmpFile);
      if (!info.duration) throw new Error(`المصدر رقم ${i + 1} بلا مدة صالحة`);
      totalDuration += info.duration;

      if (totalDuration > MAX_DURATION_SEC) {
        throw new Error(
          `المدة الإجمالية للمقاطع تتجاوز الحد ${MAX_DURATION_SEC} ثانية (${Math.round(totalDuration)}ث)`,
        );
      }
      if (info.size > SOURCE_MAX_BYTES) {
        throw new Error(
          `حجم المصدر رقم ${i + 1} (${(info.size / 1048576).toFixed(1)}MB) يتجاوز الحد ${SOURCE_MAX_MB}MB`,
        );
      }

      prepared.push({ ...s, tmpFile, ...info });
    }

    if (prepared.length < 2) throw new Error("الدمج يحتاج مقطعين على الأقل");
    if (prepared.length > MAX_SOURCES) {
      throw new Error(`أقصى عدد مقاطع للدمج هو ${MAX_SOURCES}`);
    }

    await updateJob(jobId, { progress: 40 });

    // الدقة النهائية = أكبر عرض × أكبر ارتفاع بين المدخلات، بحد 1080p وأبعاد زوجية
    const targetW = evenClamp(Math.max(...prepared.map((s) => s.width)), 1920);
    const targetH = evenClamp(Math.max(...prepared.map((s) => s.height)), 1080);
    const { graph } = buildFilterGraph(prepared, targetW, targetH);

    const outputTmp = path.join(TMP, `out_${jobId}_${Date.now()}.mp4`);
    tmpFiles.push(outputTmp);

    const args = [];
    for (const s of prepared) args.push("-i", s.tmpFile);
    args.push(
      "-filter_complex", graph,
      "-map", "[outv]",
      "-map", "[outa]",
      "-c:v", "libx264",
      "-preset", FFMPEG_PRESET,
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      "-progress", "pipe:1",
      "-nostats",
      "-loglevel", "error",
      "-y",
      outputTmp,
    );

    await runFfmpeg(args, totalDuration, jobId);

    const outStat = fs.statSync(outputTmp);
    if (outStat.size === 0) throw new Error("الناتج فارغ — فشل الترميز");
    if (outStat.size > OUTPUT_MAX_BYTES) {
      throw new Error(
        `حجم الناتج (${(outStat.size / 1048576).toFixed(1)}MB) يتجاوز الحد ${OUTPUT_MAX_MB}MB`,
      );
    }

    await updateJob(jobId, { progress: 90 });
    await storeOutput(jobId, outputTmp);

    const finalSize = await getOutputSize(jobId);
    await updateJob(jobId, {
      status: "done",
      progress: 100,
      completed_at: new Date().toISOString(),
      result_size: finalSize,
      result_duration: Number(totalDuration.toFixed(3)),
      result_resolution: `${targetW}x${targetH}`,
    });

    // الناتج فقط هو المطلوب — نحذف أجزاء المصادر بعد النجاح
    await deleteSourceChunks(jobId).catch(() => {});
    return await getJob(jobId);
  } catch (err) {
    await updateJob(jobId, {
      status: "failed",
      error_message: err && err.message ? err.message : "فشل الدمج",
    }).catch(() => {});
    return await getJob(jobId);
  } finally {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

module.exports = {
  probe,
  runMerge,
  assertPublicUrl,
  getFfmpegPath,
  getFfprobePath,
  buildFilterGraph,
  MAX_SOURCES,
  SOURCE_MAX_MB,
  OUTPUT_MAX_MB,
  MAX_DURATION_SEC,
  CHUNK_SIZE,
};
