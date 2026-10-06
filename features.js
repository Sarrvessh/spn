(() => {
  const draftKey = "capsule-editor-drafts";
  const ids = ["title", "label", "model", "tags", "userPrompt", "systemPrompt", "variables", "expectedOutput", "notes", "temperature", "topP", "expiresIn", "fileTitle", "fileLabel", "fileExpiresIn", "burnAfterRead", "autoExpiry", "scheduledUnlock", "unlockAt", "fileBurnAfterRead", "fileAutoExpiry", "fileScheduledUnlock", "fileUnlockAt"];
  let drafts = {};
  try { drafts = JSON.parse(localStorage.getItem(draftKey) || "{}"); } catch { /* Fresh device. */ }
  for (const id of ids) {
    const field = document.getElementById(id);
    if (!field) continue;
    if (Object.hasOwn(drafts, id)) { if (field.type === "checkbox") field.checked = Boolean(drafts[id]); else if (typeof drafts[id] === "string") field.value = drafts[id]; field.dispatchEvent(new Event(field.type === "checkbox" ? "change" : "input", { bubbles: true })); }
    const save = () => {
      drafts[id] = field.type === "checkbox" ? field.checked : field.value;
      try { localStorage.setItem(draftKey, JSON.stringify(drafts)); } catch { /* Editing remains available. */ }
    };
    field.addEventListener("input", save); field.addEventListener("change", save);
  }
  window.duplicateCapsule = async (capsule) => {
    const file = capsule.kind === "file-drop";
    await goScreen(file ? "file" : "prompt");
    const values = file ? { fileTitle: `${capsule.title} (copy)` } : { title: `${capsule.title} (copy)`, model: capsule.model, userPrompt: capsule.userPrompt, systemPrompt: capsule.systemPrompt, notes: capsule.notes, expectedOutput: capsule.expectedOutput, variables: JSON.stringify(capsule.variables || {}), tags: (capsule.tags || []).join(", "), temperature: capsule.temperature, topP: capsule.topP };
    for (const [id, value] of Object.entries(values)) { const field = document.getElementById(id); if (field) { field.value = value ?? ""; field.dispatchEvent(new Event("input", { bubbles: true })); } }
    if (file) { state.pendingAttachments = (capsule.attachments || []).map((item) => ({ ...item })); renderPendingAttachments(); updateAttachBudget(); }
    document.getElementById(file ? "fileScheduledUnlock" : "scheduledUnlock").checked = false;
    document.getElementById(file ? "fileUnlockField" : "unlockField").classList.add("is-hidden");
    setStatus(file ? fileStatus : createStatus, "Copy ready. Review the sharing rules, then create a new link.");
  };
  const promptTemplates = {
    handoff: { title: "Prompt handoff", userPrompt: "Complete {{task}} for {{audience}}. Use the context and constraints below.", systemPrompt: "Be accurate, concise, and explicit about assumptions.", expectedOutput: "Result, assumptions, and next steps" },
    review: { title: "Code review", userPrompt: "Review {{code}} for bugs, security risks, and missing tests. Rank findings by severity.", systemPrompt: "You are a careful software reviewer. Cite evidence for each finding." },
    writing: { title: "Writing brief", userPrompt: "Write {{format}} about {{topic}} for {{audience}} using {{tone}}.", expectedOutput: "A polished draft with a clear title and structure" },
  };
  const header = document.querySelector("#promptScreen .workspace-header");
  const label = document.createElement("label"); label.className = "template-picker";
  label.innerHTML = `<span>Start from a template</span><select id="promptTemplate"><option value="">Choose a template</option><option value="handoff">Prompt handoff</option><option value="review">Code review</option><option value="writing">Writing brief</option></select>`;
  header.append(label);
  label.querySelector("select").addEventListener("change", (event) => {
    const template = promptTemplates[event.target.value]; if (!template) return;
    if (document.getElementById("userPrompt").value && !confirm("Replace the current prompt with this template?")) { event.target.value = ""; return; }
    for (const id of ["title", "userPrompt", "systemPrompt", "expectedOutput"]) { const field = document.getElementById(id); field.value = template[id] || ""; field.dispatchEvent(new Event("input", { bubbles: true })); }
    event.target.value = "";
  });
  for (const [buttonId, prefix] of [["resetCreate", ""], ["resetFile", "file"]]) {
    document.getElementById(buttonId)?.addEventListener("click", () => {
      for (const id of ids.filter((id) => prefix ? id.startsWith(prefix) : !id.startsWith("file"))) delete drafts[id];
      localStorage.setItem(draftKey, JSON.stringify(drafts));
    });
  }
  for (const [formId, statusId, resultName, copyId] of [["capsuleForm", "createStatus", "promptResult", "copyLink"], ["fileForm", "fileStatus", "fileResult", "fileCopyLink"]]) {
    if (window.CapsuleRelease?.accountFree) continue;
    const target = document.getElementById(formId);
    const meter = document.createElement("p"); meter.className = "upload-stage"; meter.setAttribute("role", "status"); target.append(meter);
    const retry = document.createElement("button"); retry.type = "button"; retry.className = "secondary"; retry.textContent = "Retry upload"; retry.hidden = true;
    document.getElementById(statusId).after(retry);
    new MutationObserver(() => { const result = state[resultName]; retry.hidden = !result.envelope || !document.getElementById(statusId).classList.contains("error"); }).observe(document.getElementById(statusId), { attributes: true, childList: true });
    target.addEventListener("submit", () => { meter.textContent = target.querySelector('[type="submit"]').disabled ? "Encrypting locally…" : ""; });
    window.addEventListener("capsule-upload-stage", (event) => { if (target.querySelector('[type="submit"]').disabled || retry.disabled) meter.textContent = event.detail; });
    new MutationObserver(() => { if (!target.querySelector('[type="submit"]').disabled) meter.textContent = ""; }).observe(target.querySelector('[type="submit"]'), { attributes: true, attributeFilter: ["disabled"] });
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        const result = state[resultName];
        const id = await uploadCapsule(result.envelope, { kind: resultName === "fileResult" ? "file-drop" : "prompt" });
        const url = buildShortShareUrl(id, result.keyParam);
        document.getElementById(resultName === "fileResult" ? "fileShareLink" : "shareLink").value = url;
        rememberPackItem(result.envelope, result.keyParam, url);
        document.getElementById(copyId).disabled = false;
        if (resultName === "fileResult") { setFileResultMode("short-link"); updateFileLinkMeter(); } else updateLinkMeter();
        updateResultState(); setStatus(document.getElementById(statusId), "Upload complete. Your link is ready."); retry.hidden = true;
      } catch (error) { setStatus(document.getElementById(statusId), error.message, true); }
      finally { retry.disabled = false; meter.textContent = ""; }
    });
  }
})();
