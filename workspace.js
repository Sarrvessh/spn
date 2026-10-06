(() => {
  "use strict";
  const host = document.getElementById("capsuleWorkspace");
  const keys = ["prompt-capsule-recent-pack", "capsule-secure-collections"];
  const read = (key) => {
    try { const data = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(data) ? data : []; }
    catch { return []; }
  };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let search = "", filter = "all";
  const entries = () => [
    ...read(keys[0]).map((record) => ({ record, type: "capsule", title: record.envelope?.title || "Untitled capsule", at: record.savedAt, expires: record.envelope?.expiresAt })),
    ...read(keys[1]).map((record) => ({ record, type: record.kind || "collection", title: record.localTitle || "Untitled collection", at: record.createdAt, expires: record.expiresAt })),
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  function lifecycle(entry) {
    if (entry.record.serverStatus) return entry.record.serverStatus;
    if (entry.expires && new Date(entry.expires).getTime() <= Date.now()) return "Expired";
    if (entry.type === "capsule" && localStorage.getItem(`prompt-capsule-burned:${entry.record.envelope?.id}`) === "true") return "Opened here";
    return entry.type === "capsule" && !entry.record.shareUrl ? "Portable only" : "Saved locally";
  }
  host.innerHTML = `<header class="desk-heading"><div><h1>My Capsules</h1><p>Private exchanges, in one place.</p></div><div class="desk-create"><button type="button" data-screen="prompt" class="primary">New prompt</button><button type="button" data-screen="file" class="secondary">Send files</button><button type="button" data-screen="collect" class="secondary">Collect replies</button></div></header>
    <h2 class="desk-local-heading">On this device</h2><div class="desk-toolbar"><label class="desk-search"><span class="desk-sr">Search exchanges</span><input type="search" id="deskSearch" placeholder="Search local exchanges" /></label><label><span class="desk-sr">Exchange type</span><select id="deskFilter"><option value="all">All exchanges</option><option value="capsule">Capsules</option><option value="collection">Collections</option><option value="expired">Expired</option></select></label><button type="button" id="deskRecovery" class="secondary" aria-expanded="false" aria-controls="deskBackup">Backup & restore</button></div>
    <section id="deskBackup" class="desk-backup" hidden><h2>Encrypted workspace backup</h2><p>Includes saved links and owner access. Keep the password separately; it cannot be recovered.</p><label>Backup password<input id="deskPassword" type="password" autocomplete="new-password" placeholder="At least 12 characters" /></label><div class="button-row"><button type="button" id="deskExport" class="primary">Download backup</button><label class="secondary desk-import">Restore backup<input id="deskImport" type="file" accept=".json,application/json" /></label></div></section>
    <p id="deskStatus" role="status" aria-live="polite"></p><div id="deskRows" class="desk-rows"></div><p class="desk-footnote">Saved on this device. Link availability is checked when opened.</p>`;
  function render() {
    const all = entries();
    const visible = all.filter((entry) => entry.title.toLowerCase().includes(search.toLowerCase()) && (filter === "all" || filter === "expired" && lifecycle(entry) === "Expired" || filter === "capsule" && entry.type === "capsule" || filter === "collection" && entry.type !== "capsule"));
    document.getElementById("deskRows").innerHTML = visible.length ? visible.map((entry) => {
      const index = all.indexOf(entry), date = new Date(entry.at || 0);
      const controls = entry.type === "capsule" ? `<button type="button" data-download="${index}" class="secondary">Download</button><button type="button" data-duplicate="${index}" class="secondary">Duplicate</button>${entry.record.ownerToken ? `<select data-owner="${index}" aria-label="Manage ${esc(entry.title)}"><option value="">Manage link</option><option value="status">Check status</option><option value="revoke">Revoke link</option><option value="delete">Delete hosted copy</option></select>` : ""}` : `<button type="button" data-manage="${index}" class="secondary">Responses</button>`;
      return `<article class="desk-row"><div class="desk-row-title"><strong>${esc(entry.title)}</strong><span>${esc(entry.type === "capsule" ? "Capsule" : "Collection")}${Number.isFinite(date.getTime()) && date.getTime() ? ` &middot; ${esc(date.toLocaleDateString())}` : ""}</span></div><span class="desk-state">${esc(lifecycle(entry))}</span><div class="desk-row-actions">${entry.record.shareUrl ? `<button type="button" data-copy="${index}" class="secondary">Copy link</button>` : ""}${controls}</div></article>`;
    }).join("") : `<div class="desk-empty"><img src="/favicon.svg" width="48" height="48" alt="" /><h2>${all.length ? "No matching exchanges" : "Your workspace is ready"}</h2><p>${all.length ? "Try a different search or filter." : "Create a prompt, send files, or request a private reply."}</p></div>`;
  }
  const status = (message, error = false) => { const target = document.getElementById("deskStatus"); target.textContent = message; target.classList.toggle("desk-error", error); };
  document.getElementById("deskSearch").addEventListener("input", (event) => { search = event.target.value; render(); });
  document.getElementById("deskFilter").addEventListener("change", (event) => { filter = event.target.value; render(); });
  document.getElementById("deskRecovery").addEventListener("click", (event) => { const panel = document.getElementById("deskBackup"); panel.hidden = !panel.hidden; event.target.setAttribute("aria-expanded", String(!panel.hidden)); });
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("button"); if (!button) return;
    try {
      if (button.dataset.screen) return;
      if (button.dataset.copy !== undefined) { await navigator.clipboard.writeText(entries()[Number(button.dataset.copy)].record.shareUrl); status("Link copied."); }
      if (button.dataset.download !== undefined) { const record = entries()[Number(button.dataset.download)].record; download(buildPortableCapsuleHtml(record.envelope, record.key), "capsule.capsule.html", "text/html"); status("Portable capsule downloaded."); }
      if (button.dataset.manage !== undefined) { const entry = entries()[Number(button.dataset.manage)]; await goScreen(entry.type === "request" ? "request" : "form"); }
      if (button.dataset.duplicate !== undefined) {
        const record = entries()[Number(button.dataset.duplicate)].record;
        const password = record.key ? "" : window.prompt("Enter the capsule password to duplicate it:");
        if (password === null) return;
        await window.duplicateCapsule(await decryptCapsule(record.envelope, record.key || "", password));
      }
    } catch (error) { status(error.message || "Could not complete this action.", true); }
  });
  host.addEventListener("change", async (event) => {
    const select = event.target;
    if (select.dataset.owner === undefined || !select.value) return;
    const entry = entries()[Number(select.dataset.owner)], action = select.value;
    select.disabled = true;
    try {
      if (action !== "status" && !window.confirm(`${action === "revoke" ? "Revoke this link" : "Delete this hosted capsule"}? Recipient downloads and your local copy will remain.`)) return;
      const response = await fetch("/api/c/manage", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.record.ownerToken}` }, body: JSON.stringify({ id: entry.record.hostedId, action }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not manage capsule.");
      const records = read(keys[0]), record = records.find((item) => item.envelope.id === entry.record.envelope.id);
      record.serverStatus = result.status; record.checkedAt = Date.now();
      localStorage.setItem(keys[0], JSON.stringify(records)); render(); status(`Hosted capsule: ${result.status}.`);
    } catch (error) { status(error.message, true); }
    finally { select.disabled = false; select.value = ""; }
  });
  function download(content, name, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function derive(password, salt) {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const encode = (bytes) => bytesToBase64Url(new Uint8Array(bytes));
  function password() { const value = document.getElementById("deskPassword").value; if (value.length < 12) throw new Error("Use a backup password of at least 12 characters."); return value; }
  document.getElementById("deskExport").addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await derive(password(), salt), data = Object.fromEntries(keys.map((name) => [name, read(name)]));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
      download(JSON.stringify({ format: "capsule-workspace", version: 1, salt: encode(salt), iv: encode(iv), ciphertext: encode(ciphertext) }), "capsule-workspace.json", "application/json");
      document.getElementById("deskPassword").value = ""; status("Encrypted backup downloaded.");
    } catch (error) { status(error.message, true); } finally { event.target.disabled = false; }
  });
  document.getElementById("deskImport").addEventListener("change", async (event) => {
    const file = event.target.files[0]; if (!file) return;
    event.target.disabled = true;
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error("Backup exceeds the 32 MB restore limit.");
      const backup = JSON.parse(await file.text());
      if (backup.format !== "capsule-workspace" || backup.version !== 1) throw new Error("Choose a Capsule workspace backup.");
      const key = await derive(password(), base64UrlToBytes(backup.salt));
      let plaintext;
      try { plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(backup.iv) }, key, base64UrlToBytes(backup.ciphertext)); }
      catch { throw new Error("Password is incorrect or the backup is damaged."); }
      const data = JSON.parse(new TextDecoder().decode(plaintext));
      for (const name of keys) if (!Array.isArray(data[name]) || data[name].some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Backup records are invalid.");
      const previous = keys.map((name) => localStorage.getItem(name));
      try {
        for (const name of keys) {
          const identity = (item) => name === keys[0] ? item.envelope?.id : item.token;
          const records = new Map(read(name).map((item) => [identity(item), item]));
          for (const item of data[name]) { if (!identity(item)) throw new Error("Backup record has no identity."); if (!records.has(identity(item))) records.set(identity(item), item); }
          if (records.size > (name === keys[0] ? 25 : 50)) throw new Error("Combined workspace exceeds saved-record capacity. No records were changed.");
          localStorage.setItem(name, JSON.stringify([...records.values()]));
        }
      } catch (error) { keys.forEach((name, index) => previous[index] === null ? localStorage.removeItem(name) : localStorage.setItem(name, previous[index])); throw error; }
      document.getElementById("deskPassword").value = ""; render(); status("Workspace restored. Existing records were preserved.");
    } catch (error) { status(error.message || "Could not restore the backup.", true); }
    finally { event.target.disabled = false; event.target.value = ""; }
  });
  new MutationObserver(() => { if (document.body.dataset.screen === "home") render(); }).observe(document.body, { attributes: true, attributeFilter: ["data-screen"] });
  window.addEventListener("storage", render);
  render();
  document.body.classList.add("workspace-ready");
})();
