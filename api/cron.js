// GET /api/cron — تنظيف المهام المنتهية (مجدول يوميًا في vercel.json)
// إن ضُبط CRON_SECRET نتحقق من ترويسة Vercel القياسية.
const { cleanExpired } = require("../lib/database");

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers?.authorization || "";
    if (auth !== `Bearer ${secret}`) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
  }

  try {
    const removed = await cleanExpired();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, removed, message: "تم تنظيف المهام المنتهية." }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: err.message || "فشل التنظيف." }));
  }
};

module.exports.config = { maxDuration: 60 };
