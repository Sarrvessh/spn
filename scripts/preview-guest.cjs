const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { output } = require("./build-guest.cjs");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
function createServer() {
  return http.createServer((req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); return res.end(); }
    const url = new URL(req.url, "http://localhost");
    const route = ["/", "/workspace", "/send/prompt", "/send/files", "/open"].includes(url.pathname);
    const file = path.resolve(output, `.${route ? "/index.html" : url.pathname}`);
    if (path.dirname(file) !== output || !types[path.extname(file)]) { res.writeHead(404); return res.end(); }
    fs.readFile(file, (error, bytes) => {
      if (error) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": types[path.extname(file)], "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" });
      res.end(req.method === "HEAD" ? undefined : bytes);
    });
  });
}
if (require.main === module) createServer().listen(Number(process.argv[2]) || 4176, "127.0.0.1", () => console.log("Account-free Capsule preview ready."));
module.exports = { createServer };
