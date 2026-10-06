(() => {
  "use strict";
  let token = "", revision = 0, expires = 0, refreshTask = null, identity = null, available = false, generation = 0;
  const storage = ["prompt-capsule-recent-pack", "capsule-secure-collections"];
  const icon = (name) => `<svg class="transfer-icon" aria-hidden="true"><use href="/transfer-icons.svg#${name}"></use></svg>`;
  const authPage = document.createElement("section"); authPage.id = "authScreen"; authPage.className = "screen is-hidden";
  authPage.innerHTML = `<div class="auth-surface"><img src="/favicon.svg" width="44" height="44" alt=""><h1 id="authTitle" tabindex="-1">Welcome back</h1><p id="authIntro">Sign in to your private workspace.</p><div class="auth-switch" id="authSwitch"><a href="/login" data-screen="login">Sign in</a><a href="/signup" data-screen="signup">Create account</a></div><form id="accountLogin"><label>Email<input id="accountEmail" name="email" type="email" maxlength="254" autocomplete="email" required placeholder="you@example.com"></label><label>Password<div class="auth-password"><input id="accountPassword" name="password" type="password" autocomplete="current-password" minlength="12" maxlength="256" required placeholder="At least 12 characters"><button type="button" id="accountPasswordReveal" class="transfer-icon-button" aria-label="Show password" title="Show password">${icon("Eye")}</button></div></label><p class="auth-password-hint" id="signupHint" hidden>Use at least 12 characters. Your encryption-vault password is set separately.</p><button class="primary auth-submit" id="accountSubmit" type="submit">Sign in</button><a href="/forgot-password" data-screen="forgot" id="authForgot" class="auth-link">Forgot your password?</a></form><form id="recoveryForm" hidden><label>Email<input id="recoveryEmail" name="email" type="email" maxlength="254" autocomplete="email" required placeholder="you@example.com"></label><button type="submit" class="primary auth-submit" id="recoverySend">Send recovery email</button><a href="/reset-password" data-screen="reset" class="auth-link">Already have a recovery code?</a></form><form id="resetForm" hidden><div id="recoveryCodeFields"><label>Email<input id="resetEmail" type="email" maxlength="254" autocomplete="email" required></label><label>Recovery code<input id="recoveryCode" inputmode="numeric" pattern="[0-9]{6,10}" autocomplete="one-time-code" required placeholder="Code from your email"></label></div><label>New account password<input id="recoveryPassword" type="password" minlength="12" maxlength="256" autocomplete="new-password" required placeholder="At least 12 characters"></label><button type="submit" class="primary auth-submit" id="recoveryReset">Reset password</button><p class="auth-password-hint">Your encryption-vault password will not change.</p></form><div id="confirmationPanel" hidden><p id="confirmationCopy">Open the link in your email to confirm your address.</p><button type="button" id="confirmationContinue" class="primary" hidden>Confirm email</button><label>Email<input id="confirmationEmail" type="email" autocomplete="email" maxlength="254"></label><button type="button" id="confirmationResend" class="secondary">Resend confirmation</button></div><p id="authStatus" role="status" aria-live="polite"></p><div class="auth-availability"><p id="accountAvailability">Checking sign-in availability...</p><button id="accountRetry" class="text-button" type="button" hidden>Try again</button></div><a href="/workspace" data-screen="home" class="auth-guest">Continue without an account</a></div>`;
  const panel = document.createElement("section"); panel.id = "accountScreen"; panel.className = "screen is-hidden account-page";
  panel.innerHTML = `<header class="desk-heading"><div><h1 tabindex="-1">Account settings</h1><p id="accountIdentity">Sign in to manage your account.</p></div><div class="transfer-actions"><button type="button" id="accountReturn" class="secondary" hidden>Return to capsule</button><button type="button" class="secondary" id="accountLogout" hidden>${icon("LogOut")} Sign out</button></div></header><div id="accountGate"><h2>Your private workspace</h2><p>Sign in to manage your identity, encrypted backups, and notifications.</p><button class="primary" type="button" data-screen="login">Sign in</button></div><section id="accountSync" hidden><div id="accountVaultSlot"></div><section class="account-section"><h2>Encrypted cloud backup</h2><label>Backup encryption password<input id="cloudPassword" type="password" minlength="12" autocomplete="off" placeholder="At least 12 characters"></label><p>Separate from your account password. Keep it safe: it cannot be recovered. Cloud copies expire after 90 days.</p><div class="button-row"><button type="button" class="primary" id="cloudSave">Save to cloud</button><button type="button" class="secondary" id="cloudLoad">Restore from cloud</button></div></section><section class="account-section"><h2>Collection notifications</h2><label>Collection<select id="notificationCollection"><option value="">Choose a collection</option></select></label><div class="button-row"><button type="button" class="secondary" id="notificationEnable">Enable emails</button><button type="button" class="secondary" id="notificationDisable">Disable emails</button></div></section><section class="account-section"><h2>Device privacy</h2><p>Signing out locks your vault. Local links and drafts remain on this browser until you remove them.</p><button class="secondary" type="button" id="accountClearLocal">Remove local history and drafts</button></section></section><p id="accountStatus" role="status" aria-live="polite"></p>`;
  document.querySelector("main.shell").append(authPage, panel);
  const nav = document.createElement("button"); nav.id = "accountNav"; nav.type = "button"; nav.className = "account-nav";
  nav.innerHTML = `${icon("UserRound")}<span>Sign in</span>`; document.querySelector(".nav-inner").append(nav);
  const field = (id) => document.getElementById(id);
  field("accountPassword").setAttribute("aria-label", "Password");
  const erasure = document.createElement("section"); erasure.className = "account-section";
  erasure.innerHTML = `<h2>Delete account</h2><p>Revokes your account capsules immediately. Hosted files, your encrypted cloud backup, and your identity are removed by scheduled cleanup. Download your backups first. Anonymous links and recipient copies are not removed. Disable collection email subscriptions above before deleting.</p><form id="accountEraseForm"><label>Current account password<input id="accountErasePassword" type="password" autocomplete="current-password" maxlength="256" required></label><label>Type DELETE to confirm<input id="accountEraseConfirmation" autocomplete="off" pattern="DELETE" required></label><button type="submit" class="secondary account-danger" id="accountEraseSubmit">Delete account and hosted files</button></form><p id="accountEraseStatus" role="status"></p>`;
  field("accountSync").append(erasure);
  const signedIn = document.createElement("div"); signedIn.id = "authSignedIn"; signedIn.hidden = true;
  signedIn.innerHTML = `<p>Signed in as <strong id="authSignedEmail"></strong></p><div class="button-row"><button type="button" id="authContinue" class="primary">Continue to workspace</button><button type="button" data-screen="account" class="secondary">Account settings</button></div>`;
  field("accountLogin").before(signedIn);
  const security = document.createElement("section"); security.className = "account-section";
  security.innerHTML = `<h2>Sign-in security</h2><p>Reset your account password by email. This does not change the encryption password for your vault or backups.</p><button type="button" id="accountPasswordReset" class="secondary">Send password reset email</button>`;
  field("accountVaultSlot").after(security);
  field("accountPasswordReset").onclick = (event) => run(event.currentTarget, async () => { if (!identity) throw new Error("Sign in first."); const result = await sessionRequest({action:"recover",email:identity.email}); message(result.message); });
  const message = (text, error = false) => { const target = field(CapsuleRoutes.authScreens.includes(state.screen) ? "authStatus" : "accountStatus"); target.textContent = text; target.classList.toggle("account-error", error); };
  const local = (name) => { try { const data = JSON.parse(localStorage.getItem(name) || "[]"); return Array.isArray(data) ? data : []; } catch { return []; } };
  const returnKey = "capsule-auth-return";
  let callback = null, recoverySession = false, confirmationType = "signup";
  function pendingReturn() {
    try { const item = JSON.parse(sessionStorage.getItem(returnKey) || "null"); return item?.expires > Date.now() ? CapsuleRoutes.safeReturn(item.path, location.origin) : null; } catch { return null; }
  }
  function rememberReturn() {
    const path = CapsuleRoutes.safeReturn(`${location.pathname}${location.search}${location.hash}`, location.origin);
    if (path) try { sessionStorage.setItem(returnKey, JSON.stringify({ path, expires: Date.now() + 15 * 60000 })); } catch {}
  }
  async function returnToWorkspace() {
    const path = pendingReturn() || "/workspace"; sessionStorage.removeItem(returnKey);
    history.replaceState(null, "", path); await bootApp();
  }
  function render() {
    const screen = state.screen, isAuth = CapsuleRoutes.authScreens.includes(screen), signup = screen === "signup";
    authPage.classList.toggle("is-hidden", !isAuth); panel.classList.toggle("is-hidden", screen !== "account");
    document.body.classList.toggle("auth-route", isAuth);
    field("accountLogin").hidden = !["login", "signup"].includes(screen) || Boolean(identity);
    signedIn.hidden = !identity || !["login", "signup"].includes(screen); field("authSignedEmail").textContent = identity?.email || "";
    field("recoveryForm").hidden = screen !== "forgot"; field("resetForm").hidden = screen !== "reset";
    field("confirmationPanel").hidden = screen !== "confirm"; field("authSwitch").hidden = !["login", "signup"].includes(screen);
    field("authTitle").textContent = ({login:"Welcome back",signup:"Create your account",forgot:"Recover your account",reset:"Set a new password",confirm:"Confirm your email"})[screen] || "Welcome back";
    field("authIntro").textContent = ({login:"Sign in to your private workspace.",signup:"A private inbox for your prompts and files.",forgot:"We will email you a secure recovery link.",reset:"Choose a new password for your account.",confirm:"One last step before your workspace is ready."})[screen] || "";
    field("accountSubmit").textContent = signup ? "Create account" : "Sign in";
    field("accountPassword").autocomplete = signup ? "new-password" : "current-password";
    field("accountPassword").minLength = signup ? 12 : 1;
    field("accountPassword").placeholder = signup ? "At least 12 characters" : "Your account password";
    field("authForgot").hidden = signup; field("signupHint").hidden = !signup;
    field("authSwitch").querySelectorAll("a").forEach((a) => { if (a.dataset.screen === screen) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    field("accountSync").hidden = !identity; field("accountGate").hidden = Boolean(identity); field("accountLogout").hidden = !identity;
    field("accountIdentity").textContent = identity?.email || "Sign in to manage your account.";
    field("accountReturn").hidden = !identity;
    field("accountReturn").textContent = pendingReturn() && CapsuleRoutes.resolve(pendingReturn()).recipient ? "Return to capsule" : "Go to workspace";
    field("recoveryCodeFields").hidden = recoverySession;
    for (const id of ["resetEmail", "recoveryCode"]) field(id).disabled = recoverySession;
    field("confirmationContinue").hidden = !callback;
    field("confirmationContinue").textContent = callback?.type === "recovery" ? "Continue to password reset" : "Confirm email";
    if (screen === "confirm" && confirmationType === "recovery") field("authTitle").textContent = "Verify recovery email";
    field("confirmationCopy").textContent = confirmationType === "recovery" ? "Continue with your email link to reset your password, or request a new recovery email." : "Open the link in your email to confirm your address.";
    field("confirmationResend").textContent = confirmationType === "recovery" ? "Request recovery email" : "Resend confirmation";
    nav.querySelector("span").textContent = identity ? "Account" : "Sign in";
    nav.title = identity?.email || "Sign in";
    nav.setAttribute("aria-current", screen === "account" || isAuth ? "page" : "false");
    const options = field("notificationCollection"), selected = options.value;
    options.replaceChildren(new Option("Choose a collection", ""));
    for (const item of local(storage[1])) options.add(new Option(item.localTitle || "Collection", item.token));
    options.value = selected;
  }
  async function jsonRequest(url, body, bearer = "") {
    let response;
    try { response = await fetch(url, { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }); }
    catch { throw new Error(navigator.onLine === false ? "You are offline. Reconnect and try again." : "The account service did not respond. Try again."); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || "Account service unavailable. Try again."), { status: response.status });
    return result;
  }
  async function sessionRequest(body) {
    return jsonRequest("/api/session", body, token);
  }
  function acceptSession(result) {
    const previousId = identity?.id;
    token = result.access_token || ""; expires = (result.expires_at || 0) * 1000;
    identity = token ? { id: result.userId, email: result.email } : null;
    if (previousId !== identity?.id) revision = 0;
    render();
    if (previousId !== identity?.id) window.dispatchEvent(new CustomEvent("capsule-account", { detail: identity }));
  }
  async function accessToken() {
    if (token && Date.now() < expires - 60000) return token;
    const version = generation;
    const refresh = () => sessionRequest({ action: "refresh" }).then((result) => { if (version === generation) acceptSession(result); return token; });
    if (!refreshTask) refreshTask = (navigator.locks ? navigator.locks.request("capsule-session-refresh", refresh) : refresh()).catch((error) => { if (error.status === 401 && version === generation) acceptSession({}); throw error; }).finally(() => { refreshTask = null; });
    return refreshTask;
  }
  window.CapsuleAccount = { token: accessToken, identity: () => identity, show: async () => { rememberReturn(); await goScreen(identity ? "account" : "login"); }, return: returnToWorkspace };
  nav.onclick = () => window.CapsuleAccount.show();
  field("accountReturn").onclick = returnToWorkspace;
  field("authContinue").onclick = returnToWorkspace;
  async function request(body) {
    await accessToken();
    if (!token) throw new Error("Your session has ended. Sign in again.");
    return jsonRequest("/api/account", body, token);
  }
  async function run(button, operation) { if (button.disabled) return; button.disabled = true; try { await operation(); } catch (error) { message(error.message, true); } finally { button.disabled = false; } }
  async function signin(action) {
    const result = await sessionRequest({ action, email: field("accountEmail").value, password: field("accountPassword").value });
    field("accountPassword").value = "";
    if (!result.access_token) { confirmationType = "signup"; callback = null; field("confirmationEmail").value = field("accountEmail").value; await goScreen("confirm"); message("Check your email for a confirmation link. It may take a few minutes to arrive."); return; }
    generation++; sessionStorage.removeItem("capsule-session-signed-out"); acceptSession(result); revision = 0;
    await goScreen("account"); message("Signed in. Create or unlock your encryption vault, then continue to your workspace or pending capsule.");
  }
  field("accountLogin").addEventListener("submit", (event) => { event.preventDefault(); run(field("accountSubmit"), () => signin(state.screen === "signup" ? "signup" : "login")); });
  field("accountPasswordReveal").onclick = () => { const password = field("accountPassword"), show = password.type === "password"; password.type = show ? "text" : "password"; field("accountPasswordReveal").setAttribute("aria-label", show ? "Hide password" : "Show password"); field("accountPasswordReveal").title = show ? "Hide password" : "Show password"; };
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("capsule-account") : null;
  function clearSecrets() { generation++; acceptSession({}); recoverySession = false; sessionStorage.removeItem(returnKey); for (const id of ["cloudPassword", "accountPassword", "recoveryPassword", "recoveryCode", "vaultPassword", "accountErasePassword", "accountEraseConfirmation"]) if (field(id)) field(id).value = ""; }
  if (channel) channel.onmessage = (event) => { if (event.data === "logout") { clearSecrets(); sessionStorage.setItem("capsule-session-signed-out", "true"); message("Signed out in another tab."); } };
  field("accountEraseForm").onsubmit = (event) => { event.preventDefault(); run(field("accountEraseSubmit"), async () => {
    if (!confirm("Permanently delete your account and its hosted file capsules? This cannot be undone. Anonymous links and downloaded copies remain.")) return;
    const bearer = await accessToken();
    const result = await jsonRequest("/api/erase-account", { action:"request", password:field("accountErasePassword").value, confirmation:field("accountEraseConfirmation").value }, bearer);
    field("accountErasePassword").value = ""; field("accountEraseConfirmation").value = "";
    clearSecrets(); channel?.postMessage("logout"); await goScreen("login"); message(result.message);
  }); };
  field("accountLogout").addEventListener("click", (event) => run(event.currentTarget, async () => {
    const bearer = token;
    clearSecrets(); channel?.postMessage("logout"); sessionStorage.setItem("capsule-session-signed-out", "true");
    await goScreen("login");
    const logout = () => jsonRequest("/api/session", { action: "logout" }, bearer);
    await (navigator.locks ? navigator.locks.request("capsule-session-refresh", logout) : logout());
    sessionStorage.removeItem("capsule-session-signed-out");
    message("Signed out. Your vault is locked.");
  }));
  field("recoveryForm").onsubmit = (event) => { event.preventDefault(); run(field("recoverySend"), async () => { const result = await sessionRequest({ action: "recover", email: field("recoveryEmail").value.trim() }); field("resetEmail").value = field("recoveryEmail").value; message(result.message); }); };
  field("resetForm").onsubmit = (event) => { event.preventDefault(); run(field("recoveryReset"), async () => { const result = await sessionRequest(recoverySession ? { action: "update-password", password: field("recoveryPassword").value } : { action: "reset", email: field("resetEmail").value.trim(), password: field("recoveryPassword").value, code: field("recoveryCode").value }); field("recoveryPassword").value = ""; field("recoveryCode").value = ""; if (result.access_token) acceptSession(result); recoverySession = false; await goScreen("account"); message("Account password updated. Your encryption vault has not changed."); }); };
  field("confirmationResend").onclick = (event) => run(event.currentTarget, async () => { if (!field("confirmationEmail").reportValidity() || !field("confirmationEmail").value) throw new Error("Enter your email address first."); const result = await sessionRequest({ action: confirmationType === "recovery" ? "recover" : "resend", email: field("confirmationEmail").value.trim() }); message(result.message); });
  field("confirmationContinue").onclick = (event) => run(event.currentTarget, async () => { const data = callback; if (!data) throw new Error("Open the confirmation link from your email."); const result = await sessionRequest(data.refresh ? { action: "exchange", refreshToken: data.refresh } : { action: "verify", tokenHash: data.tokenHash, type: data.type }); callback = null; acceptSession(result); recoverySession = data.type === "recovery"; await goScreen(recoverySession ? "reset" : "account"); message(recoverySession ? "Email verified. Choose your new password." : "Email confirmed. Your workspace is ready."); });
  field("accountClearLocal").onclick = (event) => run(event.currentTarget, async () => {
    if (!confirm("Remove saved links, owner access, editor drafts and upload recovery from this browser? Download a backup first. Paused uploads will no longer be resumable here. Hosted capsules will not be deleted.")) return;
    await window.clearTransferRecovery?.();
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (storage.includes(key) || key === "capsule-editor-drafts" || /^(capsule-collection-draft:|prompt-capsule-burned:)/.test(key)) keys.push(key); }
    keys.forEach((key) => localStorage.removeItem(key)); sessionStorage.removeItem(returnKey);
    location.reload();
  });
  let previousScreen = state.screen;
  window.addEventListener("capsule-screen", () => {
    if (state.screen !== previousScreen) {
      field("accountPassword").value = ""; field("accountPassword").type = "password";
      field("accountPasswordReveal").setAttribute("aria-label", "Show password"); field("accountPasswordReveal").title = "Show password";
      field("recoveryPassword").value = ""; field("accountErasePassword").value = "";
      if (previousScreen === "reset") field("recoveryCode").value = "";
    }
    previousScreen = state.screen; render(); field("authStatus").textContent = "";
    if (CapsuleRoutes.authScreens.includes(state.screen)) field("authTitle").focus({ preventScroll: true });
  });
  function readCallback() {
    const url = new URL(location.href), fragment = new URLSearchParams(url.hash.slice(1));
    if (url.pathname !== "/auth/confirm") return;
    const type = url.searchParams.get("type") || fragment.get("type") || "signup";
    confirmationType = type === "recovery" ? "recovery" : "signup";
    if (url.searchParams.has("token_hash")) callback = { tokenHash: url.searchParams.get("token_hash"), type };
    else if (fragment.has("refresh_token")) callback = { refresh: fragment.get("refresh_token"), type };
    const error = url.searchParams.get("error") || fragment.get("error");
    history.replaceState(null, "", "/auth/confirm");
    if (error) message("This email link has expired or is invalid. Request a new link.", true);
  }
  readCallback(); render();
  async function key(password, salt) {
    if (password.length < 12) throw new Error("Use an encryption password of at least 12 characters.");
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  field("cloudSave").addEventListener("click", (event) => run(event.target, async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const secret = await key(field("cloudPassword").value, salt);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, secret, new TextEncoder().encode(JSON.stringify(Object.fromEntries(storage.map((name) => [name, local(name)])))));
    const encode = (value) => bytesToBase64Url(new Uint8Array(value));
    const result = await request({ action: "save", revision, encrypted: { format: "capsule-workspace", version: 1, salt: encode(salt), iv: encode(iv), ciphertext: encode(ciphertext) } });
    revision = result.revision; field("cloudPassword").value = ""; message("Encrypted workspace saved.");
  }));
  field("cloudLoad").addEventListener("click", (event) => run(event.target, async () => {
    const result = await request({ action: "load" });
    if (!result.encrypted) { revision = 0; message("No cloud workspace yet."); return; }
    const encrypted = result.encrypted, secret = await key(field("cloudPassword").value, base64UrlToBytes(encrypted.salt));
    let data;
    try { data = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(encrypted.iv) }, secret, base64UrlToBytes(encrypted.ciphertext)))); }
    catch { throw new Error("Encryption password is incorrect or cloud backup is damaged."); }
    const writes = storage.map((name) => {
      if (!Array.isArray(data[name])) throw new Error("Cloud workspace is invalid.");
      const identity = (item) => name === storage[0] ? item?.envelope?.id : item?.token;
      const merged = new Map(local(name).map((item) => [identity(item), item]));
      for (const item of data[name]) { if (!identity(item)) throw new Error("Cloud record is invalid."); if (!merged.has(identity(item))) merged.set(identity(item), item); }
      if (merged.size > (name === storage[0] ? 25 : 50)) throw new Error("Combined workspace exceeds saved-record capacity.");
      return JSON.stringify([...merged.values()]);
    });
    const previous = storage.map((name) => localStorage.getItem(name));
    try { storage.forEach((name, index) => localStorage.setItem(name, writes[index])); }
    catch (error) { storage.forEach((name, index) => previous[index] === null ? localStorage.removeItem(name) : localStorage.setItem(name, previous[index])); throw error; }
    revision = result.revision; field("cloudPassword").value = ""; await goScreen("home"); message("Cloud workspace restored and merged.");
  }));
  for (const [id, enabled] of [["notificationEnable", true], ["notificationDisable", false]]) field(id).addEventListener("click", (event) => run(event.target, async () => {
    const record = local(storage[1]).find((item) => item.token === field("notificationCollection").value);
    if (!record) throw new Error("Choose a saved collection.");
    await request({ action: "notifications", token: record.token, ownerToken: record.ownerToken, enabled });
    message(enabled ? "Response emails enabled for this collection." : "Response emails disabled.");
  }));
  async function initialize() {
    try {
      const response = await fetch("/api/account", { signal: AbortSignal.timeout(10000), cache: "no-store" });
      if (!response.ok) throw new Error("Account service unavailable.");
      const config = await response.json(); available = Boolean(config.available);
      field("notificationEnable").disabled = !config.notifications;
      field("accountEraseSubmit").disabled = !config.erasure;
      field("accountEraseStatus").textContent = config.erasure ? "" : "Account deletion is unavailable until hosted cleanup is configured.";
      field("accountAvailability").textContent = available ? "" : "Sign-in is unavailable until the account service is connected. Local capsules and backups remain available.";
    if (available && !callback && !sessionStorage.getItem("capsule-session-signed-out")) await accessToken().catch((error) => { if (error.status !== 401) throw error; });
    } catch { available = false; field("accountAvailability").textContent = "Sign-in is temporarily unavailable. Try again, or continue with local capsules."; }
    field("accountRetry").hidden = available;
    for (const id of ["accountSubmit", "recoverySend", "recoveryReset", "confirmationContinue", "confirmationResend"]) field(id).disabled = !available;
    render();
  }
  field("accountRetry").onclick = () => { window.CapsuleAccount.ready = initialize(); };
  window.CapsuleAccount.ready = initialize();
})();
