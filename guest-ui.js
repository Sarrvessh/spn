(() => {
  "use strict";
  if (!window.CapsuleRelease?.accountFree) return;
  document.body.classList.add("account-free");
  const hide = (element) => { if (element) element.hidden = true; };
  document.querySelectorAll('[data-screen="collect"], [data-screen="request"], [data-screen="form"], .collection-tabs').forEach(hide);
  for (const prefix of ["", "file"]) {
    for (const name of ["BurnAfterRead", "AutoExpiry", "ScheduledUnlock"]) {
      const id = prefix ? `${prefix}${name}` : name[0].toLowerCase() + name.slice(1);
      const field = document.getElementById(id);
      field.checked = false; field.disabled = true; hide(field.closest("label"));
    }
    hide(document.getElementById(prefix ? "fileExpiryField" : "expiryField"));
    hide(document.getElementById(prefix ? "fileUnlockField" : "unlockField"));
    const password = document.getElementById(prefix ? "filePassword" : "password");
    password.minLength = 12; password.placeholder = "At least 12 characters";
  }
  const fileReceipt = document.querySelector(".file-result");
  hide(fileReceipt.querySelector(".short-link-field"));
  hide(fileReceipt.querySelector(".receipt-meta"));
  hide(document.getElementById("fileCopyLink").parentElement);
  document.getElementById("fileDownloadCapsule").className = "primary file-action-download";
  document.getElementById("fileDownloadCapsule").textContent = "Download encrypted file";
  fileReceipt.querySelector(".result-lead").textContent = "Package your files into an encrypted download.";
  document.getElementById("fileResultHint").textContent = "Your encrypted file will be ready to download here.";
  document.getElementById("resultHint").textContent = "Your encrypted prompt link will appear here.";
  document.querySelector("#createPanel .result-lead").textContent = "Your encrypted prompt link will appear here.";
  document.getElementById("shareLink").placeholder = "Create a prompt to get an encrypted link";
  updatePromptMeter();
  document.querySelector("#capsuleWorkspace .desk-heading p").textContent = "Your private sharing workspace.";
  document.querySelector(".desk-footnote").textContent = "Saved on this device. Shared copies cannot be revoked.";
  document.querySelector(".desk-empty p")?.replaceChildren("Create a prompt link or an encrypted file.");
  const filter = document.getElementById("deskFilter");
  Array.from(filter.options).filter((option) => ["collection", "expired"].includes(option.value)).forEach((option) => option.remove());
  const privacy = document.createElement("section"); privacy.className = "guest-privacy";
  privacy.innerHTML = '<details><summary>Privacy & device storage</summary><p>Links and encrypted files are not uploaded. Anyone with the link or file can open it unless a password is set. Copies cannot be revoked. Local history may include sharing keys, and editor drafts are saved unencrypted on this device.</p><button type="button" class="secondary" id="guestClear">Clear this device</button><p role="status" id="guestClearStatus"></p></details>';
  document.getElementById("capsuleWorkspace").append(privacy);
  document.getElementById("guestClear").onclick = () => {
    if (!confirm("Remove saved capsules, editor drafts and sharing keys from this device? Already shared copies will remain.")) return;
    try {
      for (const key of ["prompt-capsule-recent-pack", "capsule-editor-drafts", "capsule-secure-collections"]) localStorage.removeItem(key);
      location.replace("/workspace");
    } catch { document.getElementById("guestClearStatus").textContent = "Device storage could not be cleared. Check your browser's site storage settings."; }
  };
})();
