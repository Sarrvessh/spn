(function () {
  const STORE = "capsule-secure-collections";
  const cfg = {
    request: { appId: "requestApp", prefix: "r", title: "Secure Request", action: "Create Request Link", cats: ["HR onboarding", "Vendor registration", "Client verification", "Insurance claim", "Loan documentation", "Freelancer payment setup", "University admission", "Custom"] },
    form: { appId: "formApp", prefix: "f", title: "Secure Form", action: "Create Form Link", cats: ["Employee feedback", "Incident report", "Whistleblower report", "Medical intake", "Exit interview", "Customer complaint", "Background verification", "Custom"] },
  };
  const fieldTypes = [["short-text","Short text"],["long-text","Long text"],["email","Email"],["phone","Phone"],["number","Number"],["date","Date"],["dropdown","Dropdown"],["radio","Radio"],["checkboxes","Checkboxes"],["file","File upload"],["multi-file","Multiple files"],["signature","Signature"],["consent","Consent"],["notice","Notice"],["section","Section"],["severity","Severity"]];
  const ops = [["equals","Equals"],["not-equals","Not equals"],["contains","Contains"],["selected","Selected"],["not-selected","Not selected"],["greater-than","Greater than"],["less-than","Less than"]];
  const s = { requestFields: [], formFields: [], public: null, dashboards: {}, creating: {} };
  const MAX_COLLECTION_REQUEST_BYTES = Math.floor(4.2 * 1024 * 1024);
  const esc = (v) => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  const id = (p = "fld") => crypto.randomUUID ? `${p}-${crypto.randomUUID()}` : `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const records = () => { try { return JSON.parse(localStorage.getItem(STORE) || "[]"); } catch { return []; } };
  const saveRecords = (items) => localStorage.setItem(STORE, JSON.stringify(items.slice(0, 50)));
  const remember = (item) => saveRecords([item, ...records().filter((row) => row.token !== item.token)]);
  const options = (items, selected = "") => items.map((item) => `<option value="${esc(item)}" ${item === selected ? "selected" : ""}>${esc(item)}</option>`).join("");
  async function hashValue(value) {
    if (!value) return "";
    const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(String(value)));
    return bytesToBase64Url(new Uint8Array(digest));
  }
  const hashEmail = (value) => hashValue(String(value || "").trim().toLowerCase());
  const hashSecret = (value) => hashValue(String(value || ""));
  function defaultLabel(kind, type) {
    const labels = {
      "short-text": kind === "request" ? "Requested information" : "Short answer",
      "long-text": "Detailed response",
      email: "Email address",
      phone: "Phone number",
      number: "Number",
      date: "Date",
      dropdown: "Choose an option",
      radio: "Select one option",
      checkboxes: "Select all that apply",
      file: "Upload a file",
      "multi-file": "Upload files",
      signature: "Signature",
      consent: "I consent to submit this information securely",
      notice: "Security notice",
      section: "Section heading",
      severity: "Severity",
    };
    return labels[type] || "Response";
  }
  function isGenericLabel(kind, label) {
    const text = String(label || "").trim();
    if (!text) return true;
    return fieldTypes.some(([type]) => {
      const base = defaultLabel(kind, type);
      return text === base || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+$`).test(text);
    });
  }
  function defaultField(kind, type = "short-text") {
    return {
      id: id(),
      type,
      label: defaultLabel(kind, type),
      description: type === "notice" ? "Sensitive values are encrypted before upload." : "",
      required: !["notice", "section"].includes(type),
      placeholder: "",
      options: ["Option 1", "Option 2"],
      validation: "",
      acceptedFileTypes: ".pdf,.png,.jpg,.jpeg",
      maxFileSizeMb: 5,
      maxFileCount: type === "multi-file" ? 5 : 1,
      sensitive: !["notice", "section"].includes(type),
      condition: { sourceFieldId: "", operator: "equals", value: "" },
    };
  }
  function applyFieldType(kind, field, type) {
    const next = fieldTypes.some(([value]) => value === type) ? type : "short-text";
    const keepLabel = !isGenericLabel(kind, field.label);
    field.type = next;
    if (!keepLabel) field.label = defaultLabel(kind, next);
    if (["notice", "section"].includes(next)) {
      field.required = false;
      field.sensitive = false;
      if (next === "notice" && !field.description) {
        field.description = "Sensitive values are encrypted before upload.";
      }
    } else if (field.required === undefined) {
      field.required = true;
    }
    if (["dropdown", "radio", "checkboxes"].includes(next) && !(field.options || []).length) {
      field.options = ["Option 1", "Option 2"];
    }
    if (next === "multi-file") field.maxFileCount = Math.max(Number(field.maxFileCount) || 1, 2);
    if (next === "file") field.maxFileCount = 1;
    return field;
  }
  async function encryptPayload(payload, keyParam, title, expiresAt = "") {
    const generated = keyParam ? null : await generateShareKey();
    const finalKey = keyParam || bytesToBase64Url(generated.rawKey);
    const cryptoKey = keyParam ? await importAesKey(base64UrlToBytes(keyParam)) : generated.cryptoKey;
    const iv = randomBytes(12);
    const packed = await capsuleToPlaintext(payload);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, packed.bytes);
    const ciphertext = bytesToBase64Url(new Uint8Array(encrypted));
    return { keyParam: finalKey, envelope: { id: id("env"), iv: bytesToBase64Url(iv), ciphertext, pack: packed.pack, label: "prod", guards: ["auto-expiry"], createdAt: Date.now(), expiresAt, alg: "AES-256-GCM", title, seal: await integritySeal(ciphertext) } };
  }
  async function api(url, init = {}) {
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);
      throw new Error(
        local
          ? "Cannot reach the collection API. Start `npx vercel dev` and open the URL it provides."
          : "Cannot reach the collection service. Check your connection and confirm the latest Vercel deployment is active.",
      );
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error(
        "Collection API is unavailable. Run this app with `npx vercel dev` or use the deployed Vercel URL.",
      );
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Secure collection request failed.");
    return data;
  }
  function linkFor(kind, token, keyParam) {
    const base = `${window.location.origin}/${cfg[kind].prefix}/${token}`;
    return `${base}#${new URLSearchParams({ key: keyParam }).toString()}`;
  }
  function pathInfo() {
    const match = window.location.pathname.match(/^\/([rf])\/([A-Za-z0-9_-]{20,80})\/?$/);
    return match ? { kind: match[1] === "r" ? "request" : "form", token: match[2] } : null;
  }
  function ensure(kind) {
    if (!s[`${kind}Fields`].length) {
      s[`${kind}Fields`] = kind === "request"
        ? [defaultField(kind), defaultField(kind, "consent")]
        : [defaultField(kind), defaultField(kind, "file"), defaultField(kind, "consent")];
    }
  }
  function renderWorkspace(kind) {
    if (s.public?.kind === kind) return;
    ensure(kind);
    const c = cfg[kind], app = document.getElementById(c.appId);
    if (!app) return;
    const detailExtras = kind === "request"
      ? `<label><span>Recipient name</span><input id="${kind}RecipientName" placeholder="Optional" /></label><label><span>Recipient email</span><input id="${kind}RecipientEmail" type="email" placeholder="Optional" /></label><label><span>Submission deadline</span><input id="${kind}CloseAt" type="datetime-local" /></label>`
      : `<label><span>Opening date</span><input id="${kind}OpenAt" type="datetime-local" /></label><label><span>Closing date</span><input id="${kind}CloseAt" type="datetime-local" /></label><label><span>Maximum responses</span><input id="${kind}MaxResponses" type="number" min="1" value="25" /></label>`;
    app.innerHTML = `<section class="workspace collection-workspace"><form id="${kind}CollectionForm" class="editor collection-editor"><div class="band"><div class="builder-step"><span>1</span><div><p>${esc(c.title)}</p><h2>Basics</h2></div></div><p class="builder-lead">Name the ${kind} and tell recipients what you need.</p><div class="grid two"><label><span>Title</span><input id="${kind}Title" required placeholder="${kind === "request" ? "Vendor onboarding packet" : "Incident report"}" /></label><label><span>Category</span><select id="${kind}Category">${options(c.cats)}</select></label>${detailExtras}</div><label><span>Instructions</span><textarea id="${kind}Description" rows="3" placeholder="What should the recipient include?"></textarea></label><label><span>Completion message <small>optional</small></span><textarea id="${kind}Completion" rows="2" placeholder="Thanks — your encrypted reply was received."></textarea></label></div><div class="band"><div class="builder-step"><span>2</span><div><p>Questions</p><h2>What to collect</h2></div></div><p class="builder-lead">Add questions, then change each field’s type and label to match what you need.</p><div id="${kind}Fields" class="field-builder-list"></div><div class="field-add-bar"><label class="field-add-type"><span>New field type</span><select id="${kind}FieldType">${fieldTypes.map(([v,l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></label><button id="${kind}AddField" class="secondary" type="button">Add field</button></div></div><div class="band collection-security"><div class="builder-step"><span>3</span><div><p>Access</p><h2>Sharing rules</h2></div></div><p class="builder-lead">Choose who can respond and how Capsule should retain encrypted replies.</p><div class="guards"><label class="check"><input id="${kind}OneTime" type="checkbox" ${kind === "request" ? "checked" : ""} /><i></i><span><strong>${kind === "request" ? "One submission only" : "Limit to one response total"}</strong><small>${kind === "request" ? "Requests close after the first reply" : "Leave off to accept responses up to the maximum"}</small></span></label><label class="check"><input id="${kind}AutoClose" type="checkbox" checked /><i></i><span><strong>Auto-close at response limit</strong><small>Close when the configured maximum is reached</small></span></label><label class="check"><input id="${kind}RequireConsent" type="checkbox" checked /><i></i><span><strong>Require consent</strong><small>Validated before encrypted upload</small></span></label>${kind === "form" ? `<label class="check"><input id="${kind}Anonymous" type="checkbox" /><i></i><span><strong>Anonymous submissions</strong><small>Do not collect identity automatically</small></span></label>` : ""}<label class="check"><input id="${kind}RequirePassword" type="checkbox" /><i></i><span><strong>Require password</strong><small>Recipient must enter the shared password</small></span></label><label class="check"><input id="${kind}RequireOtp" type="checkbox" /><i></i><span><strong>Require one-time code</strong><small>Use a separately shared verification code</small></span></label><label class="check"><input id="${kind}BurnAfterView" type="checkbox" checked /><i></i><span><strong>Burn after owner views</strong><small>Delete the server payload after local reveal</small></span></label><label class="check"><input id="${kind}BurnAfterExport" type="checkbox" /><i></i><span><strong>Burn after export</strong><small>Delete the server payload after archive download</small></span></label></div><div class="grid two security-options"><label><span>Allowed recipient email</span><input id="${kind}AllowedEmail" type="email" placeholder="Optional" /></label><label><span>Access password</span><input id="${kind}AccessPassword" type="password" autocomplete="new-password" /></label><label><span>One-time code</span><input id="${kind}OtpCode" type="password" autocomplete="off" /></label><label><span>Retention rule</span><select id="${kind}Retention"><option value="view">After viewing</option><option value="export">After export</option><option value="86400000">24 hours</option><option value="604800000">7 days</option><option value="close">After close</option><option value="manual">Manual burn</option></select></label></div></div><div class="actions"><button class="primary" type="submit">${esc(c.action)}</button><button id="${kind}ResetCollection" class="secondary" type="button">Reset</button></div></form><aside class="result collection-result"><div class="section-heading"><p>Share</p><h2>Encrypted link</h2></div><p class="result-lead">Create the ${kind}, then copy the private link. The decryption key stays in the URL fragment.</p><label class="short-link-field"><span>Share link</span><input id="${kind}ShareLink" type="text" readonly placeholder="Link appears after create" /></label><div class="button-row"><button id="${kind}CopyLink" class="primary" type="button" disabled>Copy Link</button></div><p id="${kind}Status" class="status"></p><div class="section-heading collection-owner-heading"><p>Owner</p><h2>Responses</h2></div><div id="${kind}OwnerDashboard" class="owner-dashboard"></div></aside></section>`;
    organizeCollectionSettings(kind);
    wire(kind); renderFields(kind); renderDashboard(kind);
  }
  function organizeCollectionSettings(kind) {
    const passwordToggle = document.getElementById(`${kind}RequirePassword`);
    const band = passwordToggle?.closest(".band");
    if (!band) return;

    if (kind === "request") {
      const oneTime = document.getElementById(`${kind}OneTime`);
      if (oneTime) {
        oneTime.checked = true;
        oneTime.disabled = true;
      }
      const autoCloseLabel = document.getElementById(`${kind}AutoClose`)?.closest("label");
      if (autoCloseLabel) autoCloseLabel.hidden = true;
    }

    const details = document.createElement("details");
    details.className = "collection-advanced-settings";
    const summary = document.createElement("summary");
    summary.innerHTML = "<strong>Advanced security</strong><small>Passwords, codes, retention, and burn rules</small>";
    const body = document.createElement("div");
    body.className = "collection-advanced-body";
    const toggleGrid = document.createElement("div");
    toggleGrid.className = "guards collection-advanced-toggles";
    const inputGrid = document.createElement("div");
    inputGrid.className = "grid two security-options";

    [`${kind}RequirePassword`, `${kind}RequireOtp`, `${kind}BurnAfterView`, `${kind}BurnAfterExport`]
      .forEach((fieldId) => {
        const label = document.getElementById(fieldId)?.closest("label");
        if (label) toggleGrid.append(label);
      });
    [`${kind}AllowedEmail`, `${kind}AccessPassword`, `${kind}OtpCode`, `${kind}Retention`]
      .forEach((fieldId) => {
        const label = document.getElementById(fieldId)?.closest("label");
        if (label) inputGrid.append(label);
      });

    body.append(toggleGrid, inputGrid);
    details.append(summary, body);
    band.append(details);
    const syncCredentialFields = () => {
      const passwordLabel = document.getElementById(`${kind}AccessPassword`)?.closest("label");
      const otpLabel = document.getElementById(`${kind}OtpCode`)?.closest("label");
      if (passwordLabel) passwordLabel.hidden = !document.getElementById(`${kind}RequirePassword`).checked;
      if (otpLabel) otpLabel.hidden = !document.getElementById(`${kind}RequireOtp`).checked;
    };
    document.getElementById(`${kind}RequirePassword`).addEventListener("change", syncCredentialFields);
    document.getElementById(`${kind}RequireOtp`).addEventListener("change", syncCredentialFields);
    syncCredentialFields();
    band.querySelectorAll(".guards, .security-options").forEach((container) => {
      if (container !== toggleGrid && container !== inputGrid && !container.children.length) {
        container.remove();
      }
    });
  }
  function wire(kind) {
    document.getElementById(`${kind}CollectionForm`).addEventListener("submit", (event) => createCollection(event, kind));
    document.getElementById(`${kind}AddField`).addEventListener("click", () => {
      const type = document.getElementById(`${kind}FieldType`).value;
      const field = defaultField(kind, type);
      const sameTypeCount = s[`${kind}Fields`].filter((item) => item.type === type).length;
      if (sameTypeCount) field.label = `${field.label} ${sameTypeCount + 1}`;
      s[`${kind}Fields`].push(field);
      renderFields(kind);
      const card = document.querySelector(`[data-field-id="${field.id}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      card?.querySelector('[data-field-prop="label"]')?.focus();
    });
    document.getElementById(`${kind}CopyLink`).addEventListener("click", () => copyCollectionText(document.getElementById(`${kind}ShareLink`).value, document.getElementById(`${kind}Status`), "Link"));
    document.getElementById(`${kind}ResetCollection`).addEventListener("click", () => {
      s[`${kind}Fields`] = kind === "request"
        ? [defaultField(kind), defaultField(kind, "consent")]
        : [defaultField(kind), defaultField(kind, "file"), defaultField(kind, "consent")];
      s.public = null;
      renderWorkspace(kind);
    });
  }
  function updateFieldProp(kind, field, prop, input) {
    if (prop === "type") {
      applyFieldType(kind, field, input.value);
      renderFields(kind);
      return true;
    }
    if (prop === "options") {
      field.options = input.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      return false;
    }
    if (prop.startsWith("condition")) {
      if (!field.condition) field.condition = { sourceFieldId: "", operator: "equals", value: "" };
      if (prop === "conditionSource") field.condition.sourceFieldId = input.value;
      if (prop === "conditionOperator") field.condition.operator = input.value;
      if (prop === "conditionValue") field.condition.value = input.value;
      return false;
    }
    if (prop === "maxFileSizeMb" || prop === "maxFileCount") {
      field[prop] = Number(input.value) || 1;
      return false;
    }
    field[prop] = input.type === "checkbox" ? input.checked : input.value;
    if (prop === "label") {
      const title = input.closest(".field-card")?.querySelector(".field-card-title strong");
      if (title) title.textContent = field.label || "Untitled field";
    }
    return false;
  }
  function renderFields(kind) {
    const fields = s[`${kind}Fields`], target = document.getElementById(`${kind}Fields`);
    if (!target) return;
    target.innerHTML = fields.map((field, index) => fieldCard(kind, field, index, fields)).join("");
    const sync = (input) => {
      const field = fields.find((item) => item.id === input.dataset.fieldId);
      if (!field) return;
      updateFieldProp(kind, field, input.dataset.fieldProp, input);
    };
    target.querySelectorAll("[data-field-prop]").forEach((input) => {
      input.addEventListener("input", () => {
        if (input.dataset.fieldProp === "type") return;
        sync(input);
      });
      input.addEventListener("change", () => sync(input));
    });
    target.querySelectorAll("[data-field-action]").forEach((button) => button.addEventListener("click", () => {
      const i = fields.findIndex((item) => item.id === button.dataset.fieldId); if (i < 0) return;
      const a = button.dataset.fieldAction;
      if (a === "delete") fields.splice(i, 1);
      if (a === "duplicate") {
        const copy = { ...fields[i], id: id(), options: [...(fields[i].options || [])], condition: { ...(fields[i].condition || {}) } };
        fields.splice(i + 1, 0, copy);
      }
      if (a === "up" && i > 0) fields.splice(i - 1, 0, fields.splice(i, 1)[0]);
      if (a === "down" && i < fields.length - 1) fields.splice(i + 1, 0, fields.splice(i, 1)[0]);
      renderFields(kind);
    }));
    let dragged = "";
    target.querySelectorAll(".field-card").forEach((card) => {
      card.addEventListener("dragstart", () => { dragged = card.dataset.fieldId; card.classList.add("is-dragging"); });
      card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
      card.addEventListener("dragover", (event) => event.preventDefault());
      card.addEventListener("drop", () => {
        if (!dragged || dragged === card.dataset.fieldId) return;
        const from = fields.findIndex((item) => item.id === dragged);
        const to = fields.findIndex((item) => item.id === card.dataset.fieldId);
        fields.splice(to, 0, fields.splice(from, 1)[0]);
        renderFields(kind);
      });
    });
  }
  function fieldCard(kind, field, index, fields) {
    const typeLabel = fieldTypes.find(([v]) => v === field.type)?.[1] || field.type;
    const supportsOptions = ["dropdown", "radio", "checkboxes"].includes(field.type);
    const supportsPlaceholder = ["short-text", "long-text", "email", "phone", "number"].includes(field.type);
    const supportsValidation = ["short-text", "long-text", "email", "phone", "number"].includes(field.type);
    const isFile = ["file", "multi-file"].includes(field.type);
    const isStructural = ["notice", "section"].includes(field.type);
    const sourceOptions = fields.filter((item) => item.id !== field.id && !["notice", "section"].includes(item.type)).map((item) => `<option value="${item.id}" ${field.condition?.sourceFieldId === item.id ? "selected" : ""}>${esc(item.label)}</option>`).join("");
    const typeOptions = fieldTypes.map(([v, l]) => `<option value="${v}" ${field.type === v ? "selected" : ""}>${esc(l)}</option>`).join("");
    const advanced = [
      supportsValidation ? `<label><span>Validation pattern</span><input data-field-prop="validation" data-field-id="${field.id}" value="${esc(field.validation)}" placeholder="Example: [A-Z]{2}-[0-9]{4}" /></label>` : "",
      isFile ? `<label><span>Accepted file types</span><input data-field-prop="acceptedFileTypes" data-field-id="${field.id}" value="${esc(field.acceptedFileTypes)}" /></label><label><span>Max file size MB</span><input type="number" min="1" data-field-prop="maxFileSizeMb" data-field-id="${field.id}" value="${esc(field.maxFileSizeMb)}" /></label><label><span>Max file count</span><input type="number" min="1" data-field-prop="maxFileCount" data-field-id="${field.id}" value="${esc(field.maxFileCount)}" /></label>` : "",
    ].join("");
    const switches = isStructural ? "" : `<div class="guards field-guards"><label class="check"><input type="checkbox" data-field-prop="required" data-field-id="${field.id}" ${field.required ? "checked" : ""} /><i></i><span><strong>Required</strong><small>Recipient must complete it</small></span></label><label class="check"><input type="checkbox" data-field-prop="sensitive" data-field-id="${field.id}" ${field.sensitive ? "checked" : ""} /><i></i><span><strong>Sensitive field</strong><small>Excluded from audit metadata</small></span></label></div>`;
    const condition = kind === "form" && !isStructural ? `<div class="field-options"><small>Conditional display</small><div class="condition-row"><label><span>Source field</span><select data-field-prop="conditionSource" data-field-id="${field.id}"><option value="">Always show</option>${sourceOptions}</select></label><label><span>Rule</span><select data-field-prop="conditionOperator" data-field-id="${field.id}">${ops.map(([v,l]) => `<option value="${v}" ${field.condition?.operator === v ? "selected" : ""}>${l}</option>`).join("")}</select></label><label><span>Value</span><input data-field-prop="conditionValue" data-field-id="${field.id}" value="${esc(field.condition?.value)}" /></label></div></div>` : "";
    const settings = `${advanced ? `<div class="grid two">${advanced}</div>` : ""}${switches}${condition}`;
    return `<article class="field-card" draggable="true" data-field-id="${field.id}"><div class="field-card-header"><div class="field-card-title"><span class="field-index">${index + 1}</span><div><strong>${esc(field.label || typeLabel)}</strong><small>${esc(typeLabel)}${field.sensitive ? " · sensitive" : ""}${field.required ? " · required" : ""}</small></div></div><div class="mini-actions"><button class="icon-button" type="button" title="Move up" aria-label="Move field up" data-field-action="up" data-field-id="${field.id}">↑</button><button class="icon-button" type="button" title="Move down" aria-label="Move field down" data-field-action="down" data-field-id="${field.id}">↓</button><button class="mini-button" type="button" data-field-action="duplicate" data-field-id="${field.id}">Duplicate</button><button class="mini-button danger-text" type="button" data-field-action="delete" data-field-id="${field.id}">Delete</button></div></div><div class="field-core"><label><span>Field type</span><select data-field-prop="type" data-field-id="${field.id}">${typeOptions}</select></label><label><span>Field label</span><input data-field-prop="label" data-field-id="${field.id}" value="${esc(field.label)}" placeholder="${esc(typeLabel)}" /></label>${supportsPlaceholder ? `<label><span>Placeholder <small>optional</small></span><input data-field-prop="placeholder" data-field-id="${field.id}" value="${esc(field.placeholder)}" /></label>` : ""}</div><label><span>Helper text <small>optional</small></span><textarea rows="2" data-field-prop="description" data-field-id="${field.id}">${esc(field.description)}</textarea></label>${supportsOptions ? `<label><span>Options <small>one per line</small></span><textarea rows="3" data-field-prop="options" data-field-id="${field.id}">${esc((field.options || []).join("\n"))}</textarea></label>` : ""}${settings ? `<details class="field-card-settings"><summary>More settings</summary><div class="field-settings-body">${settings}</div></details>` : ""}</article>`;
  }
  async function createCollection(event, kind) {
    event.preventDefault();
    const c = cfg[kind], status = document.getElementById(`${kind}Status`);
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');
    if (s.creating[kind]) return;
    s.creating[kind] = true;
    submitButton.disabled = true;
    setStatus(status, `Encrypting ${kind}...`);
    try {
      const closeAt = document.getElementById(`${kind}CloseAt`)?.value ? new Date(document.getElementById(`${kind}CloseAt`).value).toISOString() : "";
      const openAt = document.getElementById(`${kind}OpenAt`)?.value ? new Date(document.getElementById(`${kind}OpenAt`).value).toISOString() : "";
      const template = { kind, title: document.getElementById(`${kind}Title`).value.trim(), category: document.getElementById(`${kind}Category`).value, description: document.getElementById(`${kind}Description`).value.trim(), completionMessage: document.getElementById(`${kind}Completion`).value.trim(), recipient: kind === "request" ? { name: document.getElementById(`${kind}RecipientName`)?.value.trim(), email: document.getElementById(`${kind}RecipientEmail`)?.value.trim() } : null, openAt, closeAt, anonymous: Boolean(document.getElementById(`${kind}Anonymous`)?.checked), fields: s[`${kind}Fields`].map((field, displayOrder) => ({ ...field, displayOrder })), privacyNotice: kind === "form" && document.getElementById(`${kind}Anonymous`)?.checked ? "Anonymous mode avoids collecting identity fields automatically, but browser, network, or infrastructure logs may still limit anonymity." : "Sensitive values are encrypted before upload and never copied into audit receipts." };
      if (!template.title) throw new Error("Add a title.");
      const publicPolicy = { kind, oneTime: kind === "request" || document.getElementById(`${kind}OneTime`).checked, autoClose: document.getElementById(`${kind}AutoClose`).checked, maxSubmissions: kind === "form" ? Number(document.getElementById(`${kind}MaxResponses`)?.value || 25) : 1, requirePassword: document.getElementById(`${kind}RequirePassword`).checked, requireOtp: document.getElementById(`${kind}RequireOtp`).checked, requireConsent: document.getElementById(`${kind}RequireConsent`).checked, allowedEmailHash: await hashEmail(document.getElementById(`${kind}AllowedEmail`).value || document.getElementById(`${kind}RecipientEmail`)?.value || ""), accessPasswordHash: document.getElementById(`${kind}RequirePassword`).checked ? await hashSecret(document.getElementById(`${kind}AccessPassword`).value) : "", otpHash: document.getElementById(`${kind}RequireOtp`).checked ? await hashSecret(document.getElementById(`${kind}OtpCode`).value) : "" };
      if (publicPolicy.requirePassword && !publicPolicy.accessPasswordHash) throw new Error("Access password is enabled but empty.");
      if (publicPolicy.requireOtp && !publicPolicy.otpHash) throw new Error("One-time code is enabled but empty.");
      const encrypted = await encryptPayload(template, "", c.title, closeAt);
      const retentionMode = document.getElementById(`${kind}Retention`).value;
      const retention = { mode: retentionMode, burnAfterView: retentionMode === "view" || document.getElementById(`${kind}BurnAfterView`).checked, burnAfterExport: retentionMode === "export" || document.getElementById(`${kind}BurnAfterExport`).checked };
      const created = await api("/api/collections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, encryptedTemplate: encrypted.envelope, publicMeta: { kind, openAt, expiresAt: closeAt, createdAt: Date.now() }, publicPolicy, retention }) });
      const url = linkFor(kind, created.token, encrypted.keyParam);
      document.getElementById(`${kind}ShareLink`).value = url;
      document.getElementById(`${kind}CopyLink`).disabled = false;
      remember({ kind, token: created.token, ownerToken: created.ownerToken, keyParam: encrypted.keyParam, encryptedTemplate: encrypted.envelope, shareUrl: url, localTitle: template.title, createdAt: Date.now() });
      renderDashboard(kind);
      setStatus(status, `${c.title} link ready. The URL fragment carries the decryption key.`);
    } catch (error) {
      setStatus(status, error.message || `Could not create ${kind}.`, true);
    } finally {
      s.creating[kind] = false;
      submitButton.disabled = false;
    }
  }
  function renderDashboard(kind) {
    const target = document.getElementById(`${kind}OwnerDashboard`);
    if (!target) return;
    const mine = records().filter((item) => item.kind === kind);
    if (!mine.length) { target.innerHTML = `<div class="collection-empty">Created ${kind}s appear here on this device. The server keeps encrypted payloads and non-sensitive audit receipts only.</div>`; return; }
    target.innerHTML = `<div class="collection-list">${mine.map((r) => `<article class="collection-card"><div class="collection-card-header"><div class="collection-card-title"><strong>${esc(r.localTitle)}</strong><small>${esc(formatDate(r.createdAt))}</small></div><div class="mini-actions"><button class="mini-button" data-action="load" data-token="${r.token}" type="button">Load</button><button class="mini-button" data-action="copy" data-token="${r.token}" type="button">Copy</button><button class="mini-button" data-action="duplicate" data-token="${r.token}" type="button">Duplicate</button></div></div></article>`).join("")}</div><div id="${kind}DashboardDetail"></div>`;
    target.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", async () => {
      const record = mine.find((item) => item.token === button.dataset.token); if (!record) return;
      if (button.dataset.action === "copy") await copyCollectionText(record.shareUrl, document.getElementById(`${kind}Status`), "Link");
      if (button.dataset.action === "load") await loadDashboard(kind, record);
      if (button.dataset.action === "duplicate") await duplicateTemplate(kind, record);
    }));
  }
  async function duplicateTemplate(kind, record) {
    try {
      const template = await decryptCapsule(record.encryptedTemplate, record.keyParam, "");
      s[`${kind}Fields`] = template.fields.map((field) => ({ ...field, id: id() }));
      renderWorkspace(kind);
      document.getElementById(`${kind}Title`).value = `${template.title || "Untitled"} copy`;
      document.getElementById(`${kind}Description`).value = template.description || "";
      setStatus(document.getElementById(`${kind}Status`), "Template duplicated locally. Review settings, then create a new link.");
    } catch (error) { setStatus(document.getElementById(`${kind}Status`), error.message || "Duplicate failed.", true); }
  }
  async function loadDashboard(kind, record) {
    const detail = document.getElementById(`${kind}DashboardDetail`);
    detail.innerHTML = `<p class="status">Loading encrypted submissions...</p>`;
    try {
      const data = await api(`/api/collections/${encodeURIComponent(record.token)}?owner=${encodeURIComponent(record.ownerToken)}`);
      s.dashboards[kind] = { data, record };
      const submissions = data.submissions || [];
      const effectiveExpiry = data.expiresAt || data.maxRetentionAt;
      detail.innerHTML = `<div class="collection-status-grid"><div class="collection-stat"><span>Status</span><strong>${esc(data.status)}</strong></div><div class="collection-stat"><span>Available</span><strong data-stat-available>${submissions.filter((item) => item.status !== "burned").length}</strong></div><div class="collection-stat"><span>Available until</span><strong>${esc(formatDate(effectiveExpiry))}</strong></div><div class="collection-stat"><span>Burned</span><strong data-stat-burned>${submissions.filter((item) => item.status === "burned").length}</strong></div></div><div class="inline-actions"><button class="secondary" data-owner="revoke" type="button">Revoke Link</button><button class="secondary" data-owner="burn-all" type="button">Burn All</button><button class="secondary" data-owner="export" type="button">Export Encrypted Archive</button></div><div class="submission-list">${submissions.length ? submissions.map((item) => `<article class="submission-card"><div class="submission-card-header"><div class="submission-card-title"><strong>${esc(item.receiptId || item.id)}</strong><small>${esc(formatDate(item.submittedAt))} - ${esc(item.status || "stored")}</small></div><div class="mini-actions"><button class="mini-button" data-sub="open" data-id="${item.id}" ${item.status === "burned" ? "disabled" : ""} type="button">Open</button><button class="mini-button" data-sub="download" data-id="${item.id}" ${item.status === "burned" ? "disabled" : ""} type="button">Download</button><button class="mini-button" data-sub="burn" data-id="${item.id}" ${item.status === "burned" ? "disabled" : ""} type="button">Burn</button></div></div><div id="${kind}Submission-${item.id}"></div></article>`).join("") : `<div class="collection-empty">No submissions yet.</div>`}</div><div class="audit-list">${(data.audit || []).map((event) => `<div class="audit-event"><span>${esc(event.type)}</span><small>${esc(formatDate(event.at))}</small></div>`).join("")}</div>`;
      detail.querySelectorAll("[data-owner]").forEach((button) => button.addEventListener("click", () => ownerAction(kind, record, button.dataset.owner)));
      detail.querySelectorAll("[data-sub]").forEach((button) => button.addEventListener("click", () => submissionAction(kind, record, button.dataset.sub, button.dataset.id)));
    } catch (error) { detail.innerHTML = `<p class="status error">${esc(error.message)}</p>`; }
  }
  async function ownerAction(kind, record, action) {
    try {
      if (action === "revoke") await api(`/api/collections/${encodeURIComponent(record.token)}?owner=${encodeURIComponent(record.ownerToken)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke" }) });
      if (action === "burn-all") { if (!confirm("Burn all encrypted submission payloads? Audit receipts remain without sensitive values.")) return; await api(`/api/collections/${encodeURIComponent(record.token)}?owner=${encodeURIComponent(record.ownerToken)}`, { method: "DELETE" }); }
      if (action === "export") { const data = await api(`/api/collections/${encodeURIComponent(record.token)}?owner=${encodeURIComponent(record.ownerToken)}`); downloadFile(`${safeFilename(record.localTitle || kind)}-encrypted-archive.json`, JSON.stringify(data, null, 2)); if (data.retention?.burnAfterExport) await api(`/api/collections/${encodeURIComponent(record.token)}?owner=${encodeURIComponent(record.ownerToken)}`, { method: "DELETE" }); }
      await loadDashboard(kind, record);
    } catch (error) { setStatus(document.getElementById(`${kind}Status`), error.message || "Owner action failed.", true); }
  }
  async function submissionAction(kind, record, action, submissionId) {
    try {
      const data = s.dashboards[kind]?.data || await api(`/api/collections/${encodeURIComponent(record.token)}?owner=${encodeURIComponent(record.ownerToken)}`);
      const submission = (data.submissions || []).find((item) => item.id === submissionId);
      if (!submission?.encryptedPayload) return;
      if (action === "download") { downloadFile(`${submission.receiptId || submission.id}.encrypted-submission.json`, JSON.stringify(submission.encryptedPayload, null, 2)); if (data.retention?.burnAfterExport) await api(`/api/collections/${encodeURIComponent(record.token)}?owner=${encodeURIComponent(record.ownerToken)}&submission=${encodeURIComponent(submissionId)}`, { method: "DELETE" }); }
      if (action === "burn") { if (!confirm("Burn this encrypted submission payload? The audit receipt will remain.")) return; await api(`/api/collections/${encodeURIComponent(record.token)}?owner=${encodeURIComponent(record.ownerToken)}&submission=${encodeURIComponent(submissionId)}`, { method: "DELETE" }); }
      if (action === "open") {
        if (data.retention?.burnAfterView && !confirm("This submission is configured to burn after viewing. Reveal it now?")) return;
        const payload = await decryptCapsule(submission.encryptedPayload, record.keyParam, "");
        const reveal = document.getElementById(`${kind}Submission-${submissionId}`);
        reveal.innerHTML = `<div class="public-surface">${Object.entries(payload.values || {}).map(([key, value]) => `<div class="notice-block"><strong>${esc(key)}</strong><pre>${esc(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre></div>`).join("")}${(payload.attachments || []).length ? `<section class="attachments-block"><h3>Attachments</h3><ul class="attach-download-list">${payload.attachments.map((attachment, index) => `<li><span class="attach-info"><strong>${esc(attachment.name || `Attachment ${index + 1}`)}</strong><span>${esc(attachment.type || "application/octet-stream")} · ${Number(attachment.size || 0).toLocaleString()} bytes</span></span><button type="button" data-revealed-attachment="${index}">Download</button></li>`).join("")}</ul></section>` : ""}<p class="result-hint">Plaintext was decrypted locally in this browser. Burning removes Capsule's encrypted server payload and does not delete exported copies.</p><p class="status" data-reveal-status></p></div>`;
        reveal.querySelectorAll("[data-revealed-attachment]").forEach((button) => button.addEventListener("click", () => {
          const attachment = payload.attachments[Number(button.dataset.revealedAttachment)];
          downloadAttachment(attachment);
        }));
        if (data.retention?.burnAfterView) {
          await api(`/api/collections/${encodeURIComponent(record.token)}?owner=${encodeURIComponent(record.ownerToken)}&submission=${encodeURIComponent(submissionId)}`, { method: "DELETE" });
          submission.status = "burned";
          delete submission.encryptedPayload;
          const card = reveal.closest(".submission-card");
          card?.querySelectorAll("[data-sub]").forEach((button) => { button.disabled = true; });
          const subtitle = card?.querySelector(".submission-card-title small");
          if (subtitle) subtitle.textContent = `${formatDate(submission.submittedAt)} - burned`;
          const revealStatus = reveal.querySelector("[data-reveal-status]");
          if (revealStatus) revealStatus.textContent = "Encrypted server payload burned. This decrypted view remains available until you leave or reload.";
          const detail = document.getElementById(`${kind}DashboardDetail`);
          const available = detail?.querySelector("[data-stat-available]");
          const burned = detail?.querySelector("[data-stat-burned]");
          if (available) available.textContent = String(Math.max(0, Number(available.textContent) - 1));
          if (burned) burned.textContent = String(Number(burned.textContent) + 1);
        }
        return;
      }
      await loadDashboard(kind, record);
    } catch (error) { setStatus(document.getElementById(`${kind}Status`), error.message || "Submission action failed.", true); }
  }
  function matchValue(value, operator, expected) {
    const actual = Array.isArray(value) ? value : [value ?? ""];
    const text = actual.join(" ").toLowerCase(), exp = String(expected ?? "").toLowerCase();
    if (operator === "equals") return text === exp;
    if (operator === "not-equals") return text !== exp;
    if (operator === "contains") return text.includes(exp);
    if (operator === "selected") return actual.some((item) => String(item).toLowerCase() === exp);
    if (operator === "not-selected") return !actual.some((item) => String(item).toLowerCase() === exp);
    if (operator === "greater-than") return Number(actual[0]) > Number(expected);
    if (operator === "less-than") return Number(actual[0]) < Number(expected);
    return true;
  }
  function visible(field, values) {
    return !field.condition?.sourceFieldId || matchValue(values[field.condition.sourceFieldId], field.condition.operator, field.condition.value);
  }
  function showPublicCollectionScreen(kind) {
    ["home", "prompt", "file", "receive", "request", "form"].forEach((screen) => {
      document.getElementById(`${screen}Screen`)?.classList.toggle("is-hidden", screen !== kind);
    });
    document.querySelectorAll("[data-screen]").forEach((control) => {
      const active = control.dataset.screen === kind;
      control.classList.toggle("is-active", active);
      if (active) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function openPublicPath() {
    const found = pathInfo();
    if (!found) {
      leavePublicCollection();
      const tab = new URLSearchParams(window.location.search).get("tab");
      const target = ["prompt", "file", "receive", "request", "form"].includes(tab) ? tab : "home";
      if (typeof setScreen === "function") setScreen(target);
      return false;
    }
    showPublicCollectionScreen(found.kind);
    const app = document.getElementById(cfg[found.kind].appId);
    s.public = { kind: found.kind, token: found.token };
    app.innerHTML = `<section class="public-shell"><div class="empty-state"><h2>Opening ${esc(cfg[found.kind].title)}</h2><p>Fetching encrypted configuration...</p></div></section>`;
    try {
      const keyParam = readFragment().get("key") || "";
      if (!keyParam) throw new Error("Missing URL key fragment.");
      const remote = await api(`/api/collections/${encodeURIComponent(found.token)}`);
      const template = await decryptCapsule(remote.encryptedTemplate, keyParam, "");
      s.public = { ...found, keyParam, remote, template };
      renderPublic();
    } catch (error) { app.innerHTML = `<section class="public-shell"><div class="empty-state"><h2>Secure link unavailable</h2><p>${esc(error.message || "Invalid, expired, or revoked link.")}</p></div></section>`; }
    return true;
  }
  function renderPublic() {
    const ctx = s.public, inactive = ctx.remote.status !== "active";
    const policy = ctx.remote.publicPolicy || {};
    const effectiveExpiry = ctx.remote.expiresAt || ctx.remote.maxRetentionAt;
    const needsEmail = Boolean(policy.requireEmail || policy.requireEmailVerification || policy.allowedEmailHash);
    const needsPassword = Boolean(policy.requirePassword);
    const needsOtp = Boolean(policy.requireOtp);
    const needsConsent = Boolean(policy.requireConsent);
    const verificationFields = `${needsEmail ? `<label><span>Verification email</span><input id="publicVerifyEmail" type="email" autocomplete="email" required /></label>` : ""}${needsPassword ? `<label><span>Access password (case-sensitive)</span><input id="publicAccessPassword" type="password" autocomplete="current-password" required /></label>` : ""}${needsOtp ? `<label><span>One-time code (case-sensitive)</span><input id="publicOtp" type="password" required /></label>` : ""}`;
    document.getElementById(cfg[ctx.kind].appId).innerHTML = `<section class="public-shell"><div class="viewer"><form id="publicCollectionForm" class="public-form"><div class="band"><p class="eyebrow">Capsule</p><h2>${esc(ctx.template.title)}</h2><p class="result-lead">${esc(ctx.template.description || "Complete this encrypted submission.")}</p><div class="security-notice"><strong>Security notice</strong>Submissions are encrypted in this browser before upload. Audit receipts keep timestamps and status only, not sensitive answers.</div>${ctx.template.privacyNotice ? `<div class="notice-block">${esc(ctx.template.privacyNotice)}</div>` : ""}${effectiveExpiry ? `<p class="result-hint">Available until ${esc(formatDate(effectiveExpiry))}</p>` : ""}</div><div id="publicFields" class="band public-form"></div>${verificationFields || needsConsent ? `<div class="band">${verificationFields ? `<div class="grid two">${verificationFields}</div>` : ""}${needsConsent ? `<label class="check"><input id="publicConsent" type="checkbox" /><i></i><span><strong>I consent to submit this information securely</strong><small>The confirmation receipt will not repeat sensitive values.</small></span></label>` : ""}</div>` : ""}<div class="actions"><button id="publicSubmitButton" class="primary" type="submit" ${inactive ? "disabled" : ""}>Submit Securely</button></div><p id="publicStatus" class="status ${inactive ? "error" : ""}">${inactive ? esc(ctx.remote.message || ctx.remote.status) : ""}</p></form></div></section>`;
    renderPublicFields();
    document.getElementById("publicCollectionForm").addEventListener("input", updatePublicVisibility);
    document.getElementById("publicCollectionForm").addEventListener("change", updatePublicVisibility);
    document.getElementById("publicCollectionForm").addEventListener("submit", submitPublic);
  }
  function renderPublicFields() {
    document.getElementById("publicFields").innerHTML = s.public.template.fields.map((field) => `<div data-public-container="${field.id}">${publicField(field)}</div>`).join("");
    updatePublicVisibility();
  }
  function publicField(field) {
    const req = field.required ? "required" : "", desc = field.description ? `<small>${esc(field.description)}</small>` : "";
    const label = `${esc(field.label || "Untitled field")}${field.required ? `<span class="required-mark" aria-hidden="true">*</span>` : ""}`;
    if (field.type === "section") return `<div class="public-field"><h3>${label}</h3>${desc}</div>`;
    if (field.type === "notice") return `<div class="notice-block"><strong>${label}</strong>${desc}</div>`;
    if (["long-text", "signature"].includes(field.type)) return `<label class="public-field"><span class="public-field-label">${label}</span>${desc}<textarea data-public-field="${field.id}" rows="${field.type === "signature" ? 3 : 5}" placeholder="${esc(field.placeholder)}" ${req}></textarea></label>`;
    if (["dropdown", "severity"].includes(field.type)) { const opts = field.type === "severity" ? ["Low", "Medium", "High", "Critical"] : field.options || []; return `<label class="public-field"><span class="public-field-label">${label}</span>${desc}<select data-public-field="${field.id}" ${req}><option value="">Select</option>${opts.map((item) => `<option>${esc(item)}</option>`).join("")}</select></label>`; }
    if (["radio", "checkboxes", "consent"].includes(field.type)) { const inputType = field.type === "radio" ? "radio" : "checkbox", opts = field.type === "consent" ? [field.label || "I consent to submit this information securely"] : field.options || []; return `<fieldset class="public-field"><legend>${label}</legend>${desc}<div class="option-stack">${opts.map((item, index) => `<label class="option-row"><input data-public-field="${field.id}" name="${field.id}" type="${inputType}" value="${esc(item)}" ${field.required && (field.type === "radio" || field.type === "consent") && index === 0 ? "required" : ""} />${esc(item)}</label>`).join("")}</div></fieldset>`; }
    if (["file", "multi-file"].includes(field.type)) return `<label class="public-field"><span class="public-field-label">${label}</span>${desc}<input data-public-field="${field.id}" type="file" accept="${esc(field.acceptedFileTypes)}" ${field.type === "multi-file" ? "multiple" : ""} ${req} /></label>`;
    const type = field.type === "phone" ? "tel" : field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : "text";
    return `<label class="public-field"><span class="public-field-label">${label}</span>${desc}<input data-public-field="${field.id}" type="${type}" placeholder="${esc(field.placeholder)}" ${req} /></label>`;
  }
  function fieldValue(field, includeFiles = true) {
    const controls = Array.from(document.querySelectorAll(`[data-public-field="${field.id}"]`));
    if (field.type === "checkboxes") return controls.filter((control) => control.checked).map((control) => control.value);
    if (field.type === "consent") return controls.some((control) => control.checked) ? "accepted" : "";
    if (["file", "multi-file"].includes(field.type)) return includeFiles ? controls[0]?.files || [] : [];
    return controls.find((control) => control.type !== "radio" || control.checked)?.value || "";
  }
  function publicFieldValues(includeFiles = true) {
    return Object.fromEntries(
      s.public.template.fields
        .filter((field) => !["notice", "section"].includes(field.type))
        .map((field) => [field.id, fieldValue(field, includeFiles)]),
    );
  }
  function publicVisibility(values) {
    const fields = s.public.template.fields;
    const byId = new Map(fields.map((field) => [field.id, field]));
    const resolved = new Map();
    function resolve(field, visiting = new Set()) {
      if (resolved.has(field.id)) return resolved.get(field.id);
      if (!field.condition?.sourceFieldId) {
        resolved.set(field.id, true);
        return true;
      }
      if (visiting.has(field.id)) {
        resolved.set(field.id, false);
        return false;
      }
      const source = byId.get(field.condition.sourceFieldId);
      if (!source) {
        resolved.set(field.id, false);
        return false;
      }
      const nextVisiting = new Set(visiting);
      nextVisiting.add(field.id);
      const result = resolve(source, nextVisiting)
        && matchValue(values[source.id], field.condition.operator, field.condition.value);
      resolved.set(field.id, result);
      return result;
    }
    fields.forEach((field) => resolve(field));
    return resolved;
  }
  function updatePublicVisibility() {
    if (!s.public?.template) return;
    const visibility = publicVisibility(publicFieldValues(false));
    for (const field of s.public.template.fields) {
      const isVisible = visibility.get(field.id) !== false;
      const container = document.querySelector(`[data-public-container="${field.id}"]`);
      if (container) {
        container.hidden = !isVisible;
        container.querySelectorAll("input, select, textarea").forEach((control) => { control.disabled = !isVisible; });
      }
    }
  }
  function readValues(includeFiles = true) {
    const rawValues = publicFieldValues(includeFiles);
    const visibility = publicVisibility(rawValues);
    const values = {}, errors = [];
    for (const field of s.public.template.fields) {
      if (visibility.get(field.id) === false || ["notice", "section"].includes(field.type)) continue;
      const value = rawValues[field.id];
      values[field.id] = value;
      if (field.required && (!value || (Array.isArray(value) && !value.length) || (value instanceof FileList && !value.length))) errors.push(`${field.label} is required.`);
      if (field.validation && value && !(value instanceof FileList)) {
        let rule;
        try { rule = new RegExp(`^(?:${field.validation})$`, "u"); }
        catch { errors.push(`${field.label} has an invalid validation pattern. Ask the form owner to correct it.`); continue; }
        const candidates = Array.isArray(value) ? value : [value];
        if (candidates.some((item) => !rule.test(String(item)))) errors.push(`${field.label} does not match the required format.`);
      }
    }
    return { values, errors };
  }
  function acceptsFile(file, accepted) {
    const rules = String(accepted || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (!rules.length) return true;
    const name = file.name.toLowerCase(), type = (file.type || "").toLowerCase();
    return rules.some((rule) => rule.startsWith(".") ? name.endsWith(rule) : rule.endsWith("/*") ? type.startsWith(rule.slice(0, -1)) : type === rule);
  }
  function estimateEncryptedRequestBytes(values) {
    let fileBytes = 0;
    Object.values(values).forEach((value) => {
      if (value instanceof FileList) Array.from(value).forEach((file) => { fileBytes += file.size; });
    });
    const metadataBytes = new Blob([JSON.stringify({ values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value instanceof FileList ? Array.from(value).map((file) => ({ name: file.name, type: file.type, size: file.size })) : value])) })]).size;
    return Math.ceil((fileBytes + metadataBytes + 64 * 1024) * 4 / 3);
  }
  async function submitPublic(event) {
    event.preventDefault();
    const ctx = s.public, status = document.getElementById("publicStatus");
    const submitButton = document.getElementById("publicSubmitButton");
    if (ctx.submitting) return;
    setStatus(status, "Validating and encrypting submission...");
    const { values, errors } = readValues(true);
    const consentGiven = Boolean(document.getElementById("publicConsent")?.checked);
    if (ctx.remote.publicPolicy?.requireConsent && !consentGiven) errors.push("Consent is required.");
    if (errors.length) { setStatus(status, errors[0], true); return; }
    if (estimateEncryptedRequestBytes(values) > MAX_COLLECTION_REQUEST_BYTES) { setStatus(status, "The combined files are too large to encrypt and upload. Keep the encrypted request under about 4.2 MB.", true); return; }
    ctx.submitting = true;
    submitButton.disabled = true;
    try {
      const attachments = [], normalized = {};
      for (const field of ctx.template.fields) {
        if (!Object.prototype.hasOwnProperty.call(values, field.id)) continue;
        const value = values[field.id];
        if (value instanceof FileList) {
          const files = Array.from(value);
          if (files.length > Number(field.maxFileCount || 1)) throw new Error(`${field.label} allows up to ${field.maxFileCount || 1} file(s).`);
          normalized[field.label] = [];
          for (const file of files) {
            if (file.size > Number(field.maxFileSizeMb || 5) * 1024 * 1024) throw new Error(`${file.name} exceeds ${field.maxFileSizeMb || 5} MB.`);
            if (!acceptsFile(file, field.acceptedFileTypes)) throw new Error(`${file.name} is not an accepted file type for ${field.label}.`);
            const attachment = await readFileAsAttachment(file); attachments.push(attachment); normalized[field.label].push({ id: attachment.id, name: attachment.name, size: attachment.size, type: attachment.type });
          }
        } else normalized[field.label] = value;
      }
      const encrypted = await encryptPayload({ kind: "collection-submission", submittedAt: new Date().toISOString(), values: normalized, attachments }, ctx.keyParam, "Encrypted submission");
      const requestBody = JSON.stringify({ encryptedPayload: encrypted.envelope, consentVerified: consentGiven, verification: { emailHash: await hashEmail(document.getElementById("publicVerifyEmail")?.value || ""), passwordHash: await hashSecret(document.getElementById("publicAccessPassword")?.value || ""), otpHash: await hashSecret(document.getElementById("publicOtp")?.value || ""), consent: consentGiven, consentVerified: consentGiven } });
      if (new Blob([requestBody]).size > MAX_COLLECTION_REQUEST_BYTES) throw new Error("The encrypted submission exceeds the upload limit. Remove one or more files and try again.");
      const result = await api(`/api/collections/${encodeURIComponent(ctx.token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody });
      document.getElementById("publicCollectionForm").innerHTML = `<div class="band receipt-box"><strong>${esc(ctx.template.completionMessage || "Your encrypted submission was received.")}</strong><p>Receipt ID: ${esc(result.receiptId)}</p><p>Submitted: ${esc(formatDate(result.submittedAt))}</p><p>Status: encrypted and stored</p></div>`;
    } catch (error) {
      ctx.submitting = false;
      submitButton.disabled = false;
      setStatus(status, error.message || "Submission failed.", true);
    }
  }
  async function copyCollectionText(text, status, label) {
    try { await copyText(text, status, label); }
    catch (error) { setStatus(status, error.message || `${label} could not be copied.`, true); }
  }
  function downloadAttachment(attachment) {
    if (!attachment?.data) return;
    const binary = atob(attachment.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    downloadFile(attachment.name || "attachment", bytes, attachment.type || "application/octet-stream");
  }
  function leavePublicCollection() {
    if (!s.public) return;
    s.public = null;
    renderWorkspace("request");
    renderWorkspace("form");
  }
  window.resetCollectionPublicState = leavePublicCollection;
  function init() {
    renderWorkspace("request");
    renderWorkspace("form");
    document.addEventListener("click", (event) => {
      const navigation = event.target.closest("[data-screen]");
      if (navigation && s.public) {
        const next = navigation.dataset.screen || "home";
        leavePublicCollection();
        history.replaceState(
          null,
          "",
          next === "home"
            ? `${window.location.origin}/`
            : `${window.location.origin}/?tab=${encodeURIComponent(next)}`,
        );
      }
    }, true);
    openPublicPath();
  }
  window.addEventListener("hashchange", openPublicPath);
  window.addEventListener("popstate", openPublicPath);
  init();
})();
