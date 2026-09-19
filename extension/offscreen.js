/**
 * Vocalis — document « offscreen » : héberge le worker IA.
 *
 * Un content script vit à l'origine de la page (youtube.com) et ne peut pas
 * construire un Worker pointant sur chrome-extension://… Alors que cette
 * page, elle, est d'origine extension : le worker y tourne avec tous ses
 * droits (imports relatifs, sous-workers onnxruntime, wasm, fetch du
 * modèle local via import.meta.url).
 *
 * Communication bidirectionnelle via port chrome.runtime :
 *  - content script ouvre chrome.runtime.connect({ name: "vocalis-worker" })
 *  - chaque connexion instancie un Worker module indépendant
 *  - port.onMessage / port.postMessage relaient les messages
 *  - déconnexion (navigation, onglet fermé, annulation) termine le Worker.
 */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "vocalis-worker") return;

  let worker = null;
  try {
    worker = new Worker("content/worker.js", { type: "module" });
  } catch (err) {
    try {
      port.postMessage({
        type: "error",
        message: "Création worker impossible : " + (err?.message || err),
      });
    } catch {}
    return;
  }

  port.onMessage.addListener((msg) => {
    try {
      worker.postMessage(msg);
    } catch (err) {
      try {
        port.postMessage({
          type: "error",
          message: "Échec envoi worker : " + (err?.message || err),
        });
      } catch {}
    }
  });

  worker.onmessage = (e) => {
    try {
      port.postMessage(e.data);
    } catch {}
  };

  worker.onerror = (e) => {
    try {
      port.postMessage({
        type: "error",
        message: e?.message || "Erreur interne worker IA",
      });
    } catch {}
  };

  port.onDisconnect.addListener(() => {
    try {
      worker.terminate();
    } catch {}
    worker = null;
  });
});
