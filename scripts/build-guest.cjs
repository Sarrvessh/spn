const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "guest-release", "dist");
const scripts = ["routes.js", "app.js", "workspace.js", "features.js", "guest-ui.js"];
const styles = ["styles.css", "workspace.css", "guest.css"];
function build() {
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(path.join(root, "vercel.guest.json"), path.join(root, "guest-release", "vercel.json"));
  for (const file of [...scripts, ...styles, "favicon.svg"]) fs.copyFileSync(path.join(root, file), path.join(output, file));
  let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  html = html.replace(/  <script src="\/[^"]+" defer><\/script>\r?\n/g, "");
  html = html.replace(/  <link rel="stylesheet" href="\/[^"]+" \/>\r?\n/g, "");
  html = html.replace("</head>", `${styles.map((file) => `  <link rel="stylesheet" href="/${file}" />`).join("\n")}\n</head>`);
  const tags = ["guest-config.js", ...scripts].map((file) => `  <script src="/${file}" defer></script>`).join("\n");
  html = html.replace("</body>", `${tags}\n</body>`);
  fs.writeFileSync(path.join(output, "index.html"), html);
  fs.writeFileSync(path.join(output, "guest-config.js"), 'window.CapsuleRelease = Object.freeze({ accountFree: true });\n');
  fs.writeFileSync(path.join(output, "_headers"), "/*\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n");
  fs.writeFileSync(path.join(output, "_redirects"), "/workspace /index.html 200\n/send/prompt /index.html 200\n/send/files /index.html 200\n/open /index.html 200\n/* /index.html 200\n");
  console.log("Account-free release built in guest-release/dist (web assets only).");
}
if (require.main === module) build();
module.exports = { build, output };
