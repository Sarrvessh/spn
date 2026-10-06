(function () {
  "use strict";
  const T = window.CapsuleTransfer;
  let database;
  function db() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open("capsule-transfers", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("recovery");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return database;
  }
  async function transaction(mode, operation) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("recovery", mode), store = tx.objectStore("recovery");
      let value;
      const request = operation(store);
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("Recovery storage unavailable."));
    });
  }
  let keyPromise;
  function key() {
    if (!keyPromise) keyPromise = (async () => {
      const existing = await transaction("readonly", (s) => s.get("device-key"));
      if (existing) return existing;
      const generated = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt","decrypt"]);
      try { await transaction("readwrite", (s) => s.add(generated, "device-key")); return generated; }
      catch { const concurrent = await transaction("readonly", (s) => s.get("device-key")); if (concurrent) return concurrent; throw new Error("Cannot store transfer recovery safely."); }
    })();
    return keyPromise;
  }
  window.CapsuleRecovery = {
    async save(session) {
      const encrypted = await T.seal(await key(), session, `capsule-recovery:${session.id}`);
      return transaction("readwrite", (s) => s.put(encrypted, session.id));
    },
    async list() {
      const keys = await transaction("readonly", (s) => s.getAllKeys());
      const output = [];
      for (const id of keys.filter((id) => id !== "device-key")) {
        const encrypted = await transaction("readonly", (s) => s.get(id));
        try { output.push(await T.unseal(await key(), encrypted, `capsule-recovery:${id}`)); } catch { /* Corrupt entries are never treated as empty transfers. */ }
      }
      return output;
    },
    remove: (id) => transaction("readwrite", (s) => s.delete(id)),
    async clear() { await transaction("readwrite", (s) => s.clear()); keyPromise = null; }
  };
})();
