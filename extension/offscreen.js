/**
 * Vocalis — document « offscreen » : fabrique et héberge les workers IA.
 *
 * Un content script vit à l'origine de la page (youtube.com) et ne peut pas
 * construire un Worker pointant sur chrome-extension://… Alors que cette
 * page, elle, est d'origine extension : le worker y tourne avec tous ses
 * droits (imports relatifs, sous-workers onnxruntime, wasm, fetch du
 * modèle local via import.meta.url).
 *
 * Relay : content script → chrome.runtime.sendMessage → ici → worker,
 * et worker → chrome.tabs.sendMessage → content script.
 */

const workers = new Map(); // clientId -> { w, tabId }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "vocalis:w-spawn" && sender.tab?.id != null) {
    const clientId = msg.clientId;
    const tabId = sender.tab.id;
    // Un même clientId ne doit pas doubler.
    workers.get(clientId)?.w.terminate();
    const w = new Worker("content/worker.js", { type: "module" });
    workers.set(clientId, { w, tabId });
    w.onmessage = (e) => {
      chrome.tabs
        .sendMessage(tabId, { type: "vocalis:w-msg", clientId, msg: e.data })
        .catch(() => {
          // Onglet parti : le worker ne sert plus à rien.
          w.terminate();
          workers.delete(clientId);
        });
    };
    w.onerror = (e) => {
      chrome.tabs
        .sendMessage(tabId, {
          type: "vocalis:w-error",
          clientId,
          message: e.message || "worker",
        })
        .catch(() => {});
    };
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "vocalis:w-post") {
    workers.get(msg.clientId)?.w.postMessage(msg.msg);
    return false;
  }

  if (msg.type === "vocalis:w-terminate") {
    const rec = workers.get(msg.clientId);
    if (rec) {
      rec.w.terminate();
      workers.delete(msg.clientId);
    }
    return false;
  }

  return false;
});

// Onglet fermé → on tue ses workers.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [clientId, rec] of workers) {
    if (rec.tabId === tabId) {
      rec.w.terminate();
      workers.delete(clientId);
    }
  }
});
