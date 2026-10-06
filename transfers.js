(() => {
  "use strict";
  const T = window.CapsuleTransfer, recovery = window.CapsuleRecovery, account = window.CapsuleAccount;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const icon = (name) => `<svg class="transfer-icon" aria-hidden="true"><use href="/transfer-icons.svg#${name}"></use></svg>`;
  const format = (n) => n >= 1e9 ? `${(n/1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n/1e6).toFixed(1)} MB` : `${(n/1e3).toFixed(1)} KB`;
  let config = { available: false }, selected = [], recipients = [], session = null, controller = null, busy = false, privateKey = null, profile = null, folder = "received", cursor = null, current = null, sendTask = null, accountVersion = 0, inboxVersion = 0, downloadController = null, activeAccountId = null;
  async function api(action, body = {}) {
    await account.ready;
    const token = account.identity() ? await account.token() : "";
    const response = await fetch("/api/transfers", { method: "POST", signal: AbortSignal.timeout(30000), headers: { "Content-Type":"application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ action, ...body }) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || "Transfer service unavailable."), { status: response.status });
    return result;
  }
  function message(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle("transfer-error", error); }
  async function run(button, operation, status = "transferStatus") {
    button.disabled = true;
    try { await operation(); } catch (error) { message(status, error.name === "AbortError" ? status === "transferReceiveStatus" ? "Download stopped. Choose a destination again to retry." : "Paused. Reselect the same files to resume after a refresh." : error.message, error.name !== "AbortError"); }
    finally { button.disabled = false; }
  }
  const composer = document.createElement("section"); composer.id = "transferComposer"; composer.className = "transfer-composer";
  composer.innerHTML = `<div class="transfer-main"><form id="transferForm"><section class="transfer-section"><h3>Files</h3><p class="transfer-muted">Up to 5 GB per capsule · 64 files</p><label class="transfer-drop" id="transferDrop">${icon("Upload")}<strong>Choose files or drop them here</strong><span id="transferSelection">No files selected</span><input id="transferFiles" type="file" multiple></label><div id="transferFileList"></div><label id="transferRecoveryLabel" hidden>Resume an upload<select id="transferRecovery"><option value="">New transfer</option></select></label></section><section class="transfer-section"><h3>Delivery</h3><fieldset class="transfer-modes"><legend class="desk-sr">Delivery method</legend><label><input type="radio" name="delivery" value="link" checked>${icon("Link")} Secure link</label><label><input type="radio" name="delivery" value="direct">${icon("UserRound")} Capsule user</label></fieldset><div id="transferRecipients" hidden><label for="transferHandle">Recipient handle</label><div class="transfer-input-row"><input id="transferHandle" placeholder="@username" autocomplete="off" spellcheck="false"><button id="transferFind" class="secondary" type="button">Find recipient</button></div><div id="transferMatch"></div><div id="transferRecipientList"></div></div></section><details class="transfer-section" id="transferProtection"><summary>Protection</summary><div class="transfer-fields"><label>Expires after<select id="transferExpiry"><option value="86400000">24 hours</option><option value="604800000">7 days</option><option value="2592000000">30 days</option></select></label><label>Scheduled unlock<input type="datetime-local" id="transferUnlock"></label><label id="transferPasswordLabel">Password (optional)<input type="password" id="transferPassword" minlength="12" autocomplete="new-password" placeholder="At least 12 characters"></label><label class="transfer-check"><input type="checkbox" id="transferBurn">One completed download</label></div></details><div class="transfer-actions"><button id="transferSend" type="submit" class="primary">${icon("LockKeyhole")} Encrypt & send</button><button id="transferAccount" type="button" class="secondary">Account</button><button id="transferLegacy" type="button" class="text-button">Small anonymous capsule</button></div></form></div><aside class="transfer-side" aria-label="Transfer status"><h3>Your transfer</h3><p id="transferAvailability" class="transfer-muted">Checking service availability...</p><div id="transferProgress" hidden><div class="transfer-progress-label"><strong id="transferStage">Preparing</strong><span id="transferPercent">0%</span></div><progress id="transferMeter" max="100" value="0" aria-label="Transfer progress"></progress><p id="transferBytes" class="transfer-muted"></p><div class="transfer-actions"><button id="transferPause" type="button" class="secondary" title="Pause upload">${icon("Pause")} Pause</button><button id="transferResume" type="button" class="secondary" hidden>${icon("Play")} Resume</button><button id="transferCancel" type="button" class="secondary">${icon("X")} Cancel</button></div></div><p id="transferStatus" role="status" aria-live="polite"></p><div id="transferReady" hidden><label>Secure link<input id="transferLink" readonly></label><button id="transferCopy" type="button" class="secondary">${icon("Copy")} Copy link</button><a id="transferOpen" class="text-button" href="/open">Open capsule</a></div><div class="transfer-security">${icon("ShieldCheck")}<span>Encrypted on this device</span></div></aside>`;
  $("filePanel").before(composer); $("filePanel").hidden = true;
  const returnButton = document.createElement("button"); returnButton.type = "button"; returnButton.className = "text-button"; returnButton.textContent = "Back to file transfers";
  $("filePanel").prepend(returnButton);
  returnButton.onclick = () => { $("filePanel").hidden = true; composer.hidden = false; };
  $("transferLegacy").onclick = () => { if (!busy) { composer.hidden = true; $("filePanel").hidden = false; } };
  $("transferAccount").onclick = () => account.show();
  function renderFiles() {
    const bytes = selected.reduce((n,f) => n + f.size,0);
    $("transferSelection").textContent = selected.length ? `${selected.length} ${selected.length === 1 ? "file" : "files"} · ${format(bytes)}` : "No files selected";
    $("transferFileList").innerHTML = selected.map((f,i) => `<div class="transfer-file-row">${icon("File")}<span>${esc(f.name)}<small>${format(f.size)}</small></span><button type="button" data-remove="${i}" class="transfer-icon-button" aria-label="Remove ${esc(f.name)}" title="Remove file" ${busy || session ? "disabled" : ""}>${icon("X")}</button></div>`).join("");
  }
  function addFiles(files) {
    if (busy) return;
    const incoming = Array.from(files || []), next = session ? incoming : [...selected,...incoming];
    if (next.length > T.MAX_FILES || next.reduce((n,f) => n + f.size,0) > T.MAX_BYTES) { message("transferStatus","Choose up to 64 files totalling at most 5 GB.",true); return; }
    selected = next; renderFiles();
  }
  $("transferFiles").onchange = (event) => { addFiles(event.target.files); event.target.value = ""; };
  $("transferFileList").onclick = (event) => { const button = event.target.closest("[data-remove]"); if (button && !busy && !session) { selected.splice(Number(button.dataset.remove),1); renderFiles(); } };
  for (const type of ["dragenter","dragover"]) $("transferDrop").addEventListener(type,(event) => { event.preventDefault(); $("transferDrop").classList.add("dragging"); });
  for (const type of ["dragleave","drop"]) $("transferDrop").addEventListener(type,(event) => { event.preventDefault(); $("transferDrop").classList.remove("dragging"); });
  $("transferDrop").addEventListener("drop",(event) => addFiles(event.dataTransfer.files));
  document.addEventListener("paste",(event) => { if (document.body.dataset.screen === "file" && !composer.hidden && event.clipboardData?.files.length) { event.preventDefault(); event.stopImmediatePropagation(); addFiles(event.clipboardData.files); } },true);
  $("transferForm").onchange = () => { const direct = mode() === "direct"; $("transferRecipients").hidden = !direct; $("transferPasswordLabel").hidden = direct; $("transferPassword").disabled = direct || busy; };
  const mode = () => document.querySelector('input[name="delivery"]:checked').value;
  function renderRecipients() {
    $("transferRecipientList").innerHTML = recipients.map((r,i) => `<div class="transfer-file-row"><span>${esc(r.displayName)} <small>@${esc(r.handle)}</small></span><button class="transfer-icon-button" type="button" data-recipient-remove="${i}" title="Remove recipient" aria-label="Remove ${esc(r.handle)}">${icon("X")}</button></div>`).join("");
  }
  $("transferRecipientList").onclick = (event) => { const b = event.target.closest("[data-recipient-remove]"); if (b && !busy && !session) { recipients.splice(Number(b.dataset.recipientRemove),1); renderRecipients(); } };
  $("transferFind").onclick = (event) => run(event.currentTarget,async () => {
    if (!account.identity()) throw new Error("Sign in before choosing recipients.");
    const found = await api("discover",{handle:$("transferHandle").value.trim().replace(/^@/,"").toLowerCase()});
    const fingerprint = await T.hash(new TextEncoder().encode(found.publicKey.n));
    $("transferMatch").innerHTML = `<div class="transfer-match"><strong>${esc(found.displayName)}</strong><span>@${esc(found.handle)}</span><small>Key fingerprint: ${esc(fingerprint.slice(0,20))}</small><button class="secondary" type="button">Add recipient</button></div>`;
    $("transferMatch").querySelector("button").onclick = () => { if (!recipients.some((r) => r.userId === found.userId) && recipients.length < 16 && found.userId !== account.identity()?.id) recipients.push(found); renderRecipients(); $("transferMatch").replaceChildren(); };
  });
  function progress(value) {
    $("transferProgress").hidden = false; $("transferStage").textContent = value.stage;
    const percent = value.total ? Math.floor(value.completed/value.total*100) : 100;
    $("transferMeter").value = percent; $("transferPercent").textContent = `${percent}%`; $("transferBytes").textContent = `${format(value.completed)} / ${format(value.total)}`;
  }
  function setBusy(value) {
    busy = value;
    $("transferSend").disabled = value; $("transferPause").hidden = !value; $("transferResume").hidden = value || !session || session.ready;
    for (const el of $("transferForm").elements) if (el.id !== "transferAccount") el.disabled = value || Boolean(session && !session.ready && !["transferFiles","transferRecovery"].includes(el.id));
    $("transferSend").disabled = value || Boolean(session && !session.ready);
    $("transferPassword").disabled = value || mode() === "direct" || Boolean(session && !session.ready);
    renderFiles();
  }
  async function refreshRecovery() {
    const items = (await recovery.list()).filter((s) => s.owner === account.identity()?.id && !s.ready);
    $("transferRecoveryLabel").hidden = !items.length;
    $("transferRecovery").replaceChildren(new Option("New transfer",""));
    for (const s of items) $("transferRecovery").add(new Option(`${s.files[0].name} · ${format(s.bytes)}`,s.id));
    if (session) $("transferRecovery").value = session.id;
  }
  $("transferRecovery").onchange = async () => {
    if (busy) return;
    session = (await recovery.list()).find((s) => s.id === $("transferRecovery").value && s.owner === account.identity()?.id) || null;
    selected = []; setBusy(false);
    if (session) message("transferStatus","Reselect the original files in the same order, then resume.");
  };
  async function send(resume = false) {
    if (!config.available) throw new Error("Large transfers need private storage and database configuration.");
    if (!account.identity()) { await account.show(); throw new Error("Sign in to send a large file capsule."); }
    if (!profile?.public_key) { await account.show(); throw new Error("Create your encryption identity before sending a file capsule."); }
    if (!selected.length) throw new Error("Choose files first.");
    if (busy) return;
    controller = new AbortController(); setBusy(true); $("transferReady").hidden = true; $("transferCancel").hidden = false;
    try {
      if (!resume || !session) {
        if (mode() === "direct" && !recipients.length) throw new Error("Add at least one recipient.");
        const expires = new Date(Date.now() + Number($("transferExpiry").value) - 5000).toISOString();
        const unlock = $("transferUnlock").value ? new Date($("transferUnlock").value).toISOString() : null;
        if (unlock && unlock >= expires) throw new Error("Scheduled unlock must be before expiry.");
        const prepared = await T.prepare(selected, { expires, unlock, burn:$("transferBurn").checked, mode:mode(), signal:controller.signal, progress });
        prepared.owner = account.identity().id;
        const raw = T.decode(prepared.key), grants = [];
        if (profile?.public_key) grants.push({ userId:profile.user_id, keyVersion:1, wrappedKey:await T.wrap(raw,profile.public_key) });
        if (mode() === "direct") for (const recipient of recipients) grants.push({ userId:recipient.userId, keyVersion:1, wrappedKey:await T.wrap(raw,recipient.publicKey) });
        prepared.grants = grants;
        prepared.passwordBox = mode() === "link" && $("transferPassword").value ? await T.protectKey(raw,$("transferPassword").value) : null;
        $("transferPassword").value = "";
        await recovery.save(prepared); session = prepared;
      } else {
        if (session.owner !== account.identity().id) throw new Error("Sign in with the account that started this transfer.");
        progress({stage:"Checking original files",completed:0,total:session.bytes});
        await T.validateFiles(selected,session,controller.signal);
      }
      await T.retry(() => api("create",{ id:session.id, bytes:session.bytes, sizes:session.parts.map((p) => p.size), access:session.access, grants:session.grants, passwordBox:session.passwordBox, ...session.options }),controller.signal);
      await T.upload(selected,session,{api,save:(s) => recovery.save(s),progress,signal:controller.signal});
      session.ready = true; await recovery.save(session);
      if (session.options.mode === "link") {
        const url = new URL("/open",location.origin); url.searchParams.set("transfer",session.id);
        url.hash = new URLSearchParams({access:session.access,...(!session.passwordBox ? {key:session.key} : {})}).toString();
        $("transferLink").value = url.href; $("transferOpen").href = url.href; $("transferReady").hidden = false;
      }
      message("transferStatus",session.options.mode === "direct" ? "Delivered to your recipients' inboxes." : "Your encrypted capsule is ready.");
      $("transferCancel").hidden = true; selected = []; await refreshRecovery();
    } finally { setBusy(false); }
  }
  function start(resume) { sendTask = send(resume); return sendTask; }
  $("transferForm").onsubmit = (event) => { event.preventDefault(); run($("transferSend"),() => start(false)); };
  $("transferResume").onclick = (event) => run(event.currentTarget,() => start(true));
  $("transferPause").onclick = () => controller?.abort();
  $("transferCancel").onclick = (event) => run(event.currentTarget,async () => {
    if (!confirm("Cancel this transfer and delete its uploaded chunks?")) return;
    controller?.abort();
    await sendTask?.catch(() => {});
    if (session) { await api("delete",{id:session.id}); await recovery.remove(session.id); }
    session = null; selected = []; setBusy(false); $("transferProgress").hidden = true; message("transferStatus","Transfer cancelled. Hosted chunks are queued for deletion."); await refreshRecovery();
  });
  $("transferCopy").onclick = (event) => run(event.currentTarget,async () => { await navigator.clipboard.writeText($("transferLink").value); message("transferStatus","Link copied. Keep its password separate, if set."); });
  window.addEventListener("beforeunload",(event) => { if (busy) { event.preventDefault(); event.returnValue = ""; } });
  window.clearTransferRecovery = async () => {
    controller?.abort(); downloadController?.abort(); await sendTask?.catch(() => {});
    await recovery.clear(); session = null; selected = []; privateKey = null; current = null;
  };

  const vault = document.createElement("section"); vault.className = "transfer-vault";
  vault.innerHTML = `<h3>Capsule identity</h3><form id="vaultForm"><div class="transfer-fields"><label>Handle<input id="vaultHandle" pattern="[a-z][a-z0-9_]{2,29}" minlength="3" maxlength="30" autocomplete="off" required placeholder="username"></label><label>Display name<input id="vaultName" maxlength="80" required autocomplete="name"></label></div><label class="transfer-check"><input type="checkbox" id="vaultDiscoverable">Allow people with my exact handle to find me</label><label>Encryption-vault password<input id="vaultPassword" type="password" minlength="12" autocomplete="off" placeholder="Separate from your account password"></label><p>Keep this password in your password manager. Account recovery cannot recover this encryption key.</p><div class="transfer-actions"><button class="primary" type="submit" id="vaultSave">Create identity</button><button class="secondary" type="button" id="vaultUnlock">Unlock vault</button><button class="secondary" type="button" id="vaultLock">Lock vault</button></div></form><p id="vaultStatus" role="status"></p>`;
  $("accountVaultSlot").append(vault);
  const emails = document.createElement("label"); emails.className = "transfer-check";
  emails.innerHTML = '<input type="checkbox" id="vaultEmails">Email me when a capsule arrives';
  $("vaultForm").querySelector(".transfer-actions").before(emails);
  $("vaultForm").onsubmit = (event) => { event.preventDefault(); run($("vaultSave"),async () => {
    let keys = {};
    if (!profile?.user_id) keys = await T.createVault($("vaultPassword").value);
    await api("profile-save",{handle:$("vaultHandle").value.trim().toLowerCase(),displayName:$("vaultName").value,discoverable:$("vaultDiscoverable").checked,emailNotifications:$("vaultEmails").checked,...keys});
    profile = await api("profile");
    if ($("vaultPassword").value) privateKey = await T.unlockVault(profile.private_key,$("vaultPassword").value);
    $("vaultPassword").value = ""; $("vaultSave").textContent = "Save profile"; message("vaultStatus","Identity saved. Your key is encrypted before it leaves this browser.");
  },"vaultStatus"); };
  $("vaultUnlock").onclick = (event) => run(event.currentTarget,async () => { if (!profile?.private_key) throw new Error("Create your identity first."); privateKey = await T.unlockVault(profile.private_key,$("vaultPassword").value); $("vaultPassword").value = ""; message("vaultStatus","Vault unlocked on this tab."); },"vaultStatus");
  $("vaultLock").onclick = () => { privateKey = null; current = null; downloadController?.abort(); contentView.replaceChildren(); $("transferReceiveFiles").replaceChildren(); $("transferReceivePassword").value = ""; $("vaultPassword").value = ""; message("vaultStatus","Vault locked."); };

  const inbox = document.createElement("section"); inbox.className = "transfer-inbox";
  inbox.innerHTML = `<div class="transfer-inbox-heading"><h2>Account capsules</h2><button id="transferRefresh" class="transfer-icon-button" type="button" title="Refresh inbox" aria-label="Refresh inbox">${icon("RefreshCw")}</button></div><div class="transfer-folder-tabs" role="tablist" aria-label="Account folders"><button type="button" role="tab" aria-selected="true" data-folder="received">Received</button><button type="button" role="tab" aria-selected="false" data-folder="sent">Sent</button><button type="button" role="tab" aria-selected="false" data-folder="drafts">Drafts</button></div><p id="inboxStatus" role="status">Sign in to view your account capsules.</p><div id="inboxRows"></div><button id="inboxMore" class="secondary" type="button" hidden>Load more</button>`;
  $("capsuleWorkspace").querySelector(".desk-heading").after(inbox);
  async function loadInbox(more = false) {
    if (!config.available || !account.identity()) return;
    const version = ++inboxVersion, owner = account.identity().id;
    if (!more) { $("inboxRows").replaceChildren(); cursor = null; }
    message("inboxStatus", "Loading capsules...");
    const result = await api("list",{folder,...(more && cursor ? {before:cursor.created_at,beforeId:cursor.id} : {})});
    if (version !== inboxVersion || owner !== account.identity()?.id) return;
    const savedItems = (await recovery.list()).filter((s) => s.owner === owner);
    if (version !== inboxVersion || owner !== account.identity()?.id) return;
    for (const item of result.items) {
      const row = document.createElement("article"); row.className = "transfer-inbox-row";
      const expired = Date.parse(item.expires_at) <= Date.now(), status = expired && ["available","claimed","uploading"].includes(item.status) ? "expired" : item.status;
      const saved = savedItems.find((s) => s.id === item.id);
      row.innerHTML = `${icon("File")}<div><strong>${item.owned ? esc(saved?.files[0]?.name || "Encrypted file capsule") : `From @${esc(item.sender || "sender")}`}</strong><span>${format(item.bytes)} · ${esc(new Date(item.created_at).toLocaleDateString())}</span></div><span class="transfer-state">${esc(status)}</span><div class="transfer-actions">${status === "available" || status === "claimed" ? '<button class="secondary" type="button" data-open>Open</button>' : ""}${status === "uploading" && saved ? '<button class="secondary" type="button" data-resume>Resume</button>' : ""}${item.owned ? '<select aria-label="Manage capsule"><option value="">Manage</option><option value="revoke">Revoke</option><option value="delete">Delete hosted data</option></select>' : ""}</div>`;
      row.querySelector("[data-resume]")?.addEventListener("click", async () => { await goScreen("file"); session = saved; selected = []; setBusy(false); await refreshRecovery(); message("transferStatus", "Reselect the original files in the same order, then resume."); });
      row.querySelector("[data-open]")?.addEventListener("click",async () => {
        const saved = item.owned ? (await recovery.list()).find((s) => s.id === item.id && s.owner === account.identity()?.id) : null;
        const fragment = saved?.options.mode === "link" ? `#${new URLSearchParams({access:saved.access,...(!saved.passwordBox ? {key:saved.key} : {})})}` : "";
        history.pushState(null,"",`/open?transfer=${item.id}${fragment}`); await bootApp();
      });
      row.querySelector("select")?.addEventListener("change",async (event) => {
        const action = event.target.value; if (!action) return;
        await run(event.target,async () => { if (!confirm(`${action === "delete" ? "Delete" : "Revoke"} this capsule? Previously downloaded copies cannot be removed.`)) return; await api(action,{id:item.id}); await loadInbox(); },"inboxStatus"); event.target.value = "";
      });
      $("inboxRows").append(row);
    }
    cursor = result.items.at(-1); $("inboxMore").hidden = result.items.length < 30;
    message("inboxStatus",$("inboxRows").children.length ? "" : folder === "received" ? "No received capsules yet." : folder === "drafts" ? "No incomplete uploads." : "No sent capsules yet.");
  }
  inbox.querySelectorAll("[data-folder]").forEach((button) => { button.onclick = () => { folder = button.dataset.folder; inbox.querySelectorAll("[data-folder]").forEach((b) => b.setAttribute("aria-selected",String(b === button))); run(button,() => loadInbox(),"inboxStatus"); }; });
  $("transferRefresh").onclick = (event) => run(event.currentTarget,() => loadInbox(),"inboxStatus");
  $("inboxMore").onclick = (event) => run(event.currentTarget,() => loadInbox(true),"inboxStatus");
  async function accountChanged() {
    const version = ++accountVersion;
    const next = account.identity()?.id || null, changed = next !== activeAccountId, previous = activeAccountId;
    activeAccountId = next; inboxVersion++;
    if (changed) {
      controller?.abort(); downloadController?.abort(); privateKey = null; current = null;
      $("vaultPassword").value = ""; $("vaultHandle").value = ""; $("vaultName").value = "";
      // Preserve guest selections during first sign-in, but never across account switches.
      if (previous) { session = null; selected = []; recipients = []; renderRecipients(); renderFiles(); }
      $("transferReady").hidden = true; $("transferLink").value = ""; $("transferOpen").href = "/open";
      $("transferReceiveFiles").replaceChildren(); contentView.replaceChildren(); $("transferReceivePassword").value = "";
    }
    profile = null;
    $("inboxRows").replaceChildren(); $("inboxMore").hidden = true;
    if (!account.identity()) { message("inboxStatus","Sign in to view your account capsules."); return; }
    if (!config.available) return;
    try {
      const loaded = await api("profile");
      if (version !== accountVersion) return;
      profile = loaded;
      $("vaultEmails").checked = Boolean(profile.email_notifications);
      $("vaultHandle").value = profile.handle || ""; $("vaultName").value = profile.display_name || ""; $("vaultDiscoverable").checked = Boolean(profile.discoverable); $("vaultSave").textContent = profile.user_id ? "Save profile" : "Create identity";
      await refreshRecovery(); await loadInbox();
    } catch (error) { if (version === accountVersion) message("inboxStatus",error.message,true); }
  }
  window.addEventListener("capsule-account",accountChanged);

  const viewer = document.createElement("section"); viewer.id = "transferViewer"; viewer.className = "transfer-viewer"; viewer.hidden = true;
  viewer.innerHTML = `<h3>Encrypted files</h3><div id="transferReceiveFiles"></div><label id="transferReceivePasswordLabel" hidden>Password<input type="password" id="transferReceivePassword" autocomplete="off"></label><div class="transfer-actions"><button id="transferDecrypt" type="button" class="primary">${icon("LockKeyhole")} Unlock files</button><button id="transferDownload" type="button" class="primary" hidden>${icon("Download")} Download files</button><button id="transferReceiveAccount" type="button" class="secondary">Account & vault</button></div><progress id="transferDownloadMeter" value="0" max="100" hidden aria-label="Download progress"></progress><p id="transferReceiveStatus" role="status"></p>`;
  $("receivePanel").before(viewer);
  const contentButton = document.createElement("button"); contentButton.type = "button"; contentButton.className = "secondary"; contentButton.hidden = true; contentButton.textContent = "Read capsule";
  $("transferDownload").after(contentButton);
  const contentView = document.createElement("div"); contentView.className = "transfer-content"; viewer.append(contentView);
  const stopDownload = document.createElement("button"); stopDownload.type = "button"; stopDownload.className = "secondary"; stopDownload.hidden = true; stopDownload.innerHTML = `${icon("X")} Stop download`;
  $("transferDownload").after(stopDownload); stopDownload.onclick = () => downloadController?.abort();
  let receiveId = "", access = "", raw = "", linkLease = "", receiveVersion = 0;
  window.openTransferRoute = async (id) => {
    downloadController?.abort();
    contentButton.hidden = true; contentView.replaceChildren();
    receiveVersion++; current = null; receiveId = id;
    const fragment = new URLSearchParams(location.hash.slice(1)); access = fragment.get("access") || ""; raw = fragment.get("key") || "";
    linkLease = sessionStorage.getItem(`capsule-lease:${id}`) || T.encode(T.random(32));
    viewer.hidden = false; $("receivePanel").hidden = true;
    $("transferReceiveFiles").replaceChildren(); $("transferDownload").hidden = true; $("transferDecrypt").hidden = false; $("transferReceivePasswordLabel").hidden = Boolean(raw) || !access;
    message("transferReceiveStatus",access ? "Unlock to view this capsule's files." : "Sign in and unlock your encryption vault to open this capsule.");
  };
  window.addEventListener("capsule-screen",() => { if (!CapsuleRoutes.resolve(location.href).transfer) { downloadController?.abort(); viewer.hidden = true; contentView.replaceChildren(); $("transferReceiveFiles").replaceChildren(); $("transferReceivePassword").value = ""; $("receivePanel").hidden = false; receiveVersion++; current = null; } });
  $("transferReceiveAccount").onclick = () => account.show();
  $("transferDecrypt").onclick = (event) => run(event.currentTarget,async () => {
    const version = receiveVersion, id = receiveId, permission = access;
    const record = await api("open",{id,access:permission}); let key;
    if (raw) key = await T.importKey(T.decode(raw));
    else if (record.wrappedKey && privateKey) key = await T.unwrap(record.wrappedKey,privateKey);
    else if (record.passwordBox && permission) key = await T.importKey(await T.recoverKey(record.passwordBox,$("transferReceivePassword").value));
    else throw new Error("Unlock your account vault, then return to this capsule.");
    const manifest = await T.readManifest(key,record.manifest,id);
    if (version !== receiveVersion) return;
    $("transferReceivePassword").value = "";
    current = {key,manifest,permission,id,lease:linkLease};
    contentButton.hidden = !(manifest.files.length === 1 && manifest.bytes <= 1000000 && manifest.files[0].type === "application/x-capsule+json");
    $("transferReceiveFiles").innerHTML = manifest.files.map((f) => `<div class="transfer-file-row">${icon("File")}<span>${esc(f.name)}<small>${format(f.size)}</small></span></div>`).join("");
    $("transferDecrypt").hidden = true; $("transferReceivePasswordLabel").hidden = true; $("transferDownload").hidden = false;
    message("transferReceiveStatus",record.burn ? "One-time download. The download slot is reserved when you choose a save destination; you can retry in this tab for up to 24 hours." : "Ready to download.");
  },"transferReceiveStatus");
  const filename = (name,index) => `${index === undefined ? "" : `${index + 1}-`}${name.replace(/[\\/:*?"<>|\x00-\x1f]/g,"_").replace(/^\.+$/, "file").slice(0,180) || "file"}`;
  contentButton.onclick = (event) => run(event.currentTarget,async () => {
    const opened = current; if (!opened || opened.manifest.bytes > 1000000) throw new Error("Unlock this capsule first.");
    const version = receiveVersion;
    const chunks = [];
    sessionStorage.setItem(`capsule-lease:${opened.id}`,opened.lease);
    await api("claim",{id:opened.id,access:opened.permission,lease:opened.lease});
    await T.download(opened.manifest,opened.key,{api:(action,body) => api(action,{...body,lease:opened.lease}),sinks:[{write:async (chunk) => {chunks.push(chunk);},close:async () => {},abort:async () => {chunks.length=0;}}]});
    const payload = JSON.parse(await new Blob(chunks).text());
    if (version !== receiveVersion || current !== opened) return;
    contentView.replaceChildren();
    if (payload.version !== 1) throw new Error("Unsupported capsule content format.");
    if (payload.kind === "collection") {
      const url = new URL(payload.url); if (url.origin !== location.origin || !CapsuleRoutes.resolve(url.href).token) throw new Error("This is not a collection link from this Capsule site.");
      const link = document.createElement("a"); link.href = url.href; link.className = "primary"; link.textContent = "Open private request"; contentView.append(link);
    } else if (payload.kind === "prompt") {
      const heading = document.createElement("h3"); heading.textContent = payload.capsule?.title || "Prompt";
      const pre = document.createElement("pre"); pre.textContent = JSON.stringify(payload.capsule,null,2); contentView.append(heading,pre);
    } else throw new Error("Unsupported capsule content.");
    message("transferReceiveStatus","Opened and integrity verified. Previously saved copies are not affected by revocation.");
  },"transferReceiveStatus");
  $("transferDownload").onclick = (event) => run(event.currentTarget,async () => {
    const opened = current; if (!opened) throw new Error("Unlock this capsule first.");
    const {manifest,key,id,permission,lease} = opened; let sinks = [];
    const version = receiveVersion;
    downloadController = new AbortController(); const signal = downloadController.signal;
    try {
    // Destination selection happens before a network call to preserve user activation.
    if (manifest.files.length === 1 && window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({suggestedName:filename(manifest.files[0].name)}); sinks = [await handle.createWritable()];
    } else if (window.showDirectoryPicker) {
      const directory = await window.showDirectoryPicker({mode:"readwrite"});
      for (let i = 0; i < manifest.files.length; i++) { const handle = await directory.getFileHandle(filename(manifest.files[i].name,i),{create:true}); sinks.push(await handle.createWritable()); }
    } else {
      if (manifest.bytes > 32 * 1024 * 1024 || manifest.files.length !== 1) throw new Error("This browser cannot save a large download progressively. Open this link in a desktop browser with File System Access, such as Chrome or Edge.");
      const chunks = [];
      sinks = [{write:async (chunk) => { chunks.push(chunk); },abort:async () => { chunks.length = 0; },close:async () => { const url = URL.createObjectURL(new Blob(chunks,{type:"application/octet-stream"})); const a = document.createElement("a"); a.href = url; a.download = filename(manifest.files[0].name); a.click(); setTimeout(() => URL.revokeObjectURL(url),60000); chunks.length = 0; }}];
    }
      if (signal.aborted) throw new DOMException("Download cancelled", "AbortError");
      sessionStorage.setItem(`capsule-lease:${id}`,lease);
      await api("claim",{id,access:permission,lease});
      $("transferDownloadMeter").hidden = false; stopDownload.hidden = false; contentButton.disabled = true; $("transferDecrypt").disabled = true;
      await T.download(manifest,key,{sinks,signal,api:(action,body) => api(action,{...body,lease}),progress:({completed,total}) => { if (version !== receiveVersion) return; $("transferDownloadMeter").value = total ? completed/total*100 : 100; message("transferReceiveStatus",`${format(completed)} / ${format(total)}`); }});
      sessionStorage.removeItem(`capsule-lease:${id}`); if (version === receiveVersion) message("transferReceiveStatus","Files saved and integrity verified.");
    } catch (error) { await Promise.allSettled(sinks.map((s) => s.abort?.())); throw error; }
    finally { stopDownload.hidden = true; contentButton.disabled = false; $("transferDecrypt").disabled = false; downloadController = null; }
  },"transferReceiveStatus");
  fetch("/api/transfers").then((r) => r.ok ? r.json() : Promise.reject(new Error())).then(async (value) => {
    config = value; $("transferAvailability").textContent = config.available ? "Private transfers are available." : "Large transfers await server setup. Small anonymous capsules are still available.";
    await accountChanged();
  }).catch(() => { $("transferAvailability").textContent = "Large-transfer service unavailable. Small anonymous capsules remain available."; });
  async function stageContent(payload,name) {
    if (busy) throw new Error("Pause or finish the current transfer first.");
    const file = new File([JSON.stringify(payload)],name,{type:"application/x-capsule+json"});
    if (file.size > 1000000) throw new Error("This prompt exceeds the 1 MB account-delivery limit.");
    session = null; selected = [file]; recipients = []; renderFiles(); renderRecipients(); setBusy(false);
    document.querySelector('input[name="delivery"][value="direct"]').checked = true; $("transferForm").dispatchEvent(new Event("change"));
    composer.hidden = false; $("filePanel").hidden = true; await goScreen("file");
    message("transferStatus","Choose recipients and protection, then send.");
  }
  const promptDirect = document.createElement("button"); promptDirect.type = "button"; promptDirect.className = "secondary"; promptDirect.textContent = "Send to Capsule user";
  $("capsuleForm").querySelector(".actions").append(promptDirect);
  promptDirect.onclick = (event) => run(event.currentTarget,async () => { if (!$("capsuleForm").reportValidity()) return; await stageContent({version:1,kind:"prompt",capsule:buildCapsule()},"prompt.capsule.json"); },"createStatus");
  function collectionDelivery() {
    for (const kind of ["request","form"]) {
      const copy = $(`${kind}CopyLink`); if (!copy || $(`${kind}DirectSend`)) continue;
      const button = document.createElement("button"); button.id = `${kind}DirectSend`; button.type = "button"; button.className = "secondary"; button.textContent = "Send to Capsule user"; copy.after(button);
      button.onclick = (event) => run(event.currentTarget,async () => { const url = $(`${kind}ShareLink`).value; if (!url) throw new Error("Create the collection link first."); await stageContent({version:1,kind:"collection",url},`${kind}.capsule.json`); },`${kind}Status`);
    }
  }
  window.addEventListener("capsule-screen",collectionDelivery); collectionDelivery();
  const route = CapsuleRoutes.resolve(location.href); if (route.transfer) window.openTransferRoute(route.transfer);
})();
