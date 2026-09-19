/**
 * Vocalis — proxy de worker pour script de contenu.
 *
 * Un content script ne peut pas faire `new Worker(chrome-extension://…)`.
 * Ce proxy expose l'interface standard d'un Worker (postMessage / onmessage /
 * onerror / terminate) mais délègue l'exécution réelle au document offscreen
 * de l'extension via un port persistant chrome.runtime.
 */

self.VocalisWorkerProxy = (() => {
  "use strict";

  class WorkerProxy {
    constructor() {
      this.queue = [];
      this.port = null;
      this.onmessage = null;
      this.onerror = null;
      this.dead = false;

      // 1. S'assure que le document offscreen existe
      // 2. Ouvre le canal direct (port) vers lui
      this.ready = chrome.runtime
        .sendMessage({ type: "vocalis:ensure-offscreen" })
        .then(() => {
          if (this.dead) return;
          const port = chrome.runtime.connect({ name: "vocalis-worker" });
          this.port = port;

          port.onMessage.addListener((msg) => {
            if (this.dead) return;
            this.onmessage && this.onmessage({ data: msg });
          });

          port.onDisconnect.addListener(() => {
            if (this.dead) return;
            const err = chrome.runtime.lastError?.message || "Liaison worker perdue";
            this.onerror && this.onerror({ message: err });
          });

          // Vide la file d'attente des messages envoyés avant que le port soit prêt
          const q = this.queue;
          this.queue = null;
          for (const m of q) {
            port.postMessage(m);
          }
        })
        .catch((e) => {
          this.onerror && this.onerror({ message: String((e && e.message) || e) });
        });
    }

    /** Interface compatible Worker.postMessage.
        (Les Float32Array et ArrayBuffer sont copiés via la structured-clone de chrome.runtime). */
    postMessage(msg, _transfer) {
      if (this.dead) return;
      if (this.queue) {
        this.queue.push(msg);
      } else if (this.port) {
        try {
          this.port.postMessage(msg);
        } catch (e) {
          this.onerror && this.onerror({ message: String((e && e.message) || e) });
        }
      }
    }

    terminate() {
      this.dead = true;
      this.queue = null;
      if (this.port) {
        try {
          this.port.disconnect();
        } catch {}
        this.port = null;
      }
    }
  }

  return WorkerProxy;
})();
