/**
 * Vocalis — proxy de worker pour script de contenu.
 *
 * Un content script ne peut pas faire `new Worker(chrome-extension://…)`.
 * Ce proxy expose la même interface qu'un Worker (postMessage / onmessage /
 * onerror / terminate) mais délègue la création au document offscreen de
 * l'extension, qui lui a l'origine extension. Les messages transitent par
 * chrome.runtime (copie structurée : les ArrayBuffer voyagent sans souci).
 */

self.VocalisWorkerProxy = (() => {
  "use strict";

  let seq = 0;

  class WorkerProxy {
    constructor() {
      this.clientId = "w" + Date.now().toString(36) + "-" + (++seq) + "-" +
        Math.random().toString(36).slice(2, 8);
      this.queue = [];
      this.onmessage = null;
      this.onerror = null;
      this.dead = false;

      this._listener = (msg) => {
        if (!msg || typeof msg !== "object") return false;
        if (msg.type === "vocalis:w-msg" && msg.clientId === this.clientId) {
          this.onmessage && this.onmessage({ data: msg.msg });
        } else if (msg.type === "vocalis:w-error" && msg.clientId === this.clientId) {
          this.onerror && this.onerror({ message: msg.message });
        }
        return false;
      };
      chrome.runtime.onMessage.addListener(this._listener);

      this.ready = chrome.runtime
        .sendMessage({ type: "vocalis:ensure-offscreen" })
        .then(() =>
          chrome.runtime.sendMessage({ type: "vocalis:w-spawn", clientId: this.clientId })
        )
        .then(() => {
          const q = this.queue;
          this.queue = null;
          for (const m of q) this._post(m);
        })
        .catch((e) => {
          this.onerror && this.onerror({ message: String((e && e.message) || e) });
        });
    }

    _post(msg) {
      if (this.dead) return;
      chrome.runtime
        .sendMessage({ type: "vocalis:w-post", clientId: this.clientId, msg })
        .catch(() => {});
    }

    /** Même signature que Worker.postMessage (le 2e arg, transferts, est
        ignoré : la messagerie runtime copie de toute façon). */
    postMessage(msg, _transfer) {
      if (this.queue) this.queue.push(msg);
      else this._post(msg);
    }

    terminate() {
      this.dead = true;
      this.queue = null;
      try { chrome.runtime.onMessage.removeListener(this._listener); } catch { /* déjà retiré */ }
      chrome.runtime
        .sendMessage({ type: "vocalis:w-terminate", clientId: this.clientId })
        .catch(() => {});
    }
  }

  return WorkerProxy;
})();
