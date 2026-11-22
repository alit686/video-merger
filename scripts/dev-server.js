// خادم تطوير محلي يحاكي بيئة Vercel
// يقرأ .env ويوزّع المسارات الديناميكية ويضعها في req.query/params

const http = require("http");
const fs = require("fs");
const path = require("path");

// تحميل .env (إن وجد)
try {
  const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.trim().match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const PORT = process.env.PORT || 3001;

/** مطابقة المسارات الديناميكية (مثل /api/jobs/:id/video) */
const STATIC_API_ROUTES = [
  { pattern: /^\/api\/config$/, handler: "../api/config" },
  { pattern: /^\/api\/cron$/, handler: "../api/cron" },
  { pattern: /^\/api\/upload$/, handler: "../api/upload" },
  { pattern: /^\/api\/jobs$/, handler: "../api/jobs" },
];

const DYNAMIC_API_PATTERNS = [
  { pattern: /^\/api\/jobs\/([a-z0-9-]+)\/process$/, handler: "../api/jobs/[id]/process", param: "id" },
  { pattern: /^\/api\/jobs\/([a-z0-9-]+)\/video$/, handler: "../api/jobs/[id]/video", param: "id" },
  { pattern: /^\/api\/jobs\/([a-z0-9-]+)$/, handler: "../api/jobs/[id]", param: "id" },
];

/** جمع كامل الجسم (بما في ذلك ثنائي) */
function collectBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const full = Buffer.concat(chunks);
      if (req.headers["content-type"] === "application/octet-stream") {
        resolve(full);
      } else if (full.length === 0) {
        resolve(null);
      } else {
        resolve(full.toString("utf8"));
      }
    });
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // واجهة API
  for (const route of STATIC_API_ROUTES) {
    if (route.pattern.test(pathname)) {
      const handler = require(route.handler);
      const body = await collectBody(req);
      req.body = body;
      req.query = Object.fromEntries(url.searchParams);
      const result = await handler(req, res);
      // handler يكتب مباشرة إلى res
      return;
    }
  }

  for (const route of DYNAMIC_API_PATTERNS) {
    const m = pathname.match(route.pattern);
    if (m) {
      const handler = require(route.handler);
      const body = await collectBody(req);
      req.body = body;
      req.params = {};
      req.params[route.param] = m[1];
      req.query = Object.fromEntries(url.searchParams);
      await handler(req, res);
      return;
    }
  }

  // الملفات الثابتة
  let filePath = path.join(__dirname, "..", "public", pathname === "/" ? "index.html" : pathname);
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".mp4": "video/mp4",
      }[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(content);
      return;
    }
  } catch {}

  // 404
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "غير موجود" }));
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`🎬 Video Merger dev server running at http://localhost:${PORT}`);
  console.log(`   API base: http://localhost:${PORT}/api`);
});

module.exports = server;