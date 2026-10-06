(function (root) {
  const paths = { home: "/workspace", prompt: "/send/prompt", file: "/send/files", collect: "/collect", request: "/collect/request", form: "/collect/form", receive: "/open", login: "/login", signup: "/signup", forgot: "/forgot-password", reset: "/reset-password", confirm: "/auth/confirm", account: "/account" };
  const authScreens = ["login", "signup", "forgot", "reset", "confirm"];
  function resolve(value) {
    const url = new URL(value, "https://capsule.invalid");
    const path = url.pathname.replace(/\/$/, "") || "/";
    const transfer = url.searchParams.get("transfer");
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(transfer || "")) return { screen: "receive", recipient: true, transfer };
    const collection = path.match(/^\/([rf])\/([A-Za-z0-9_-]{20,80})$/);
    if (collection) return { screen: collection[1] === "r" ? "request" : "form", recipient: true, token: collection[2] };
    const capsule = path.match(/^\/c\/([A-Za-z0-9]{8})$/);
    const id = capsule?.[1] || url.searchParams.get("id");
    if (/^[A-Za-z0-9]{8}$/.test(id || "")) return { screen: "receive", recipient: true, id };
    if (new URLSearchParams(url.hash.slice(1)).has("data")) return { screen: "receive", recipient: true };
    const screen = Object.keys(paths).find((key) => paths[key] === path) || (Object.hasOwn(paths, url.searchParams.get("tab")) ? url.searchParams.get("tab") : "home");
    return { screen, recipient: false };
  }
  function safeReturn(value, origin = "https://capsule.invalid") {
    try {
      if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20]/.test(value)) return null;
      const url = new URL(value, origin), route = resolve(url.href);
      if (url.origin !== new URL(origin).origin || authScreens.includes(route.screen) || route.screen === "account") return null;
      if (!route.recipient && !["/", ...Object.values(paths)].includes(url.pathname)) return null;
      return `${url.pathname}${url.search}${url.hash}`;
    } catch { return null; }
  }
  const api = { paths, resolve, authScreens, safeReturn, group: (screen) => ["prompt", "file"].includes(screen) ? "send" : ["collect", "request", "form"].includes(screen) ? "collect" : screen };
  if (typeof module !== "undefined") module.exports = api;
  else root.CapsuleRoutes = api;
})(typeof window !== "undefined" ? window : globalThis);
