// GET /api/config — الحدود العامة + إصدار الخدمة (نقطة فحص الجهوزية)
const { MAX_SOURCES, SOURCE_MAX_MB, OUTPUT_MAX_MB, MAX_DURATION_SEC } = require("../lib/merger");

module.exports = async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      version: "2.0.0",
      maxSources: MAX_SOURCES,
      sourceMaxMB: SOURCE_MAX_MB,
      outputMaxMB: OUTPUT_MAX_MB,
      maxTotalDurationSec: MAX_DURATION_SEC,
      maxChunkBytes: 4_000_000,
      outputCodec: "H.264 + AAC (CRF 18, 192k, 44100Hz)",
      outputMaxResolution: "1920x1080",
      outputFps: 30,
      ttlHours: 24,
      features: ["url-sources", "file-upload-chunks", "range-support", "auto-cleanup-24h"],
    }),
  );
};
