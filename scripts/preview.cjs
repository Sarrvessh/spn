const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { paths } = require("../routes");
const root = path.resolve(__dirname, "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const endpoints = {
  "/api/account": "account", "/api/session": "session", "/api/transfers": "transfers", "/api/health": "health", "/api/erase-account": "erase-account",
  "/api/upload-token": "upload-token", "/api/c": "c/index", "/api/c/init": "c/init", "/api/c/complete": "c/complete", "/api/c/manage": "c/manage",
  "/api/collections": "collections/index", "/api/cron/cleanup-blobs": "cron/cleanup-blobs", "/api/cron/cleanup-transfers": "cron/cleanup-transfers"
};
function resolveEndpoint(pathname) {
  if (endpoints[pathname]) return { file: endpoints[pathname], params: {} };
  const capsule = pathname.match(/^\/api\/c\/([A-Za-z0-9]{8})$/);
  if (capsule) return { file: "c/[id]", params: { id: capsule[1] } };
  const collection = pathname.match(/^\/api\/collections\/([A-Za-z0-9_-]{20,80})$/);
  return collection ? { file: "collections/[token]", params: { token: collection[1] } } : null;
}
function createServer() {
  return http.createServer(async (req, res) => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(data)); return res; };
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return res.status(400).json({ error: "Invalid URL." }); }
    const pathname = url.pathname;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const endpoint = resolveEndpoint(pathname);
    if (endpoint) {
      req.query = { ...Object.fromEntries(url.searchParams), ...endpoint.params };
      const chunks = []; let bytes = 0;
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 9 * 1024 * 1024) return res.status(413).json({ error: "Request too large." });
          chunks.push(chunk);
        }
        req.body = Buffer.concat(chunks).toString("utf8") || "{}";
        await require(path.join(root, "api", `${endpoint.file}.js`))(req, res);
      } catch { if (!res.writableEnded) res.status(503).json({ error: "Service temporarily unavailable." }); }
      return;
    }
    if (pathname.startsWith("/api/")) return res.status(404).json({ error: "Endpoint not found." });
    if (!["GET", "HEAD"].includes(req.method)) return res.status(405).json({ error: "Use GET." });
    const appRoute = pathname === "/" || Object.values(paths).includes(pathname.replace(/\/$/, "")) || /^\/[crf]\/[A-Za-z0-9_-]+\/?$/.test(pathname);
    const file = path.resolve(root, `.${appRoute ? "/index.html" : pathname}`);
    // Never serve source directories or configuration files.
    if (!file.startsWith(root + path.sep) || path.dirname(file) !== root || !types[path.extname(file)]) return res.status(404).json({ error: "Page not found." });
    fs.readFile(file, (error, data) => { if (error) return res.status(404).json({ error: "Page not found." }); res.writeHead(200, { "Content-Type": types[path.extname(file)] }); res.end(req.method === "HEAD" ? undefined : data); });
  });
}
if (require.main === module) {
  const envFile = path.join(root, ".env.local");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.argv[2]) || 4174;
  createServer().listen(port, "127.0.0.1", () => console.log(`Capsule: http://127.0.0.1:${port}/workspace (real API handlers)`));
}
module.exports = { createServer, resolveEndpoint };
