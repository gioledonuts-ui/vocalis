/**
 * Vocalis — service worker (v0.1 : squelette)
 *
 * Rôles actuels :
 *  - répondre au « ping » du popup (vérification de liaison) ;
 *  - maintenir le badge « ON » sur l'icône quand Vocalis est actif sur un onglet.
 *
 * Rôle futur (v0.2+) :
 *  - superviser la pipeline audio (téléchargement du flux, traitement, cache).
 */

const BADGE_COLOR = "#7c3aed"; // violet Vocalis

/* Document offscreen (hébergement du worker IA) : créé à la demande,
   une seule instance. */
let offscreenCreating = null;
async function ensureOffscreen() {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existing.length) return;
  } catch { /* vieux Chrome : on tente la création, l'erreur « single document » est bénigne */ }
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Hébergement du worker IA Vocalis (origine extension).",
      })
      .catch(() => { /* déjà créé en parallèle : sans gravité */ })
      .finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

chrome.runtime.onInstalled.addListener(() => {
  // Nettoie les onglets activés d'une précédente session (les tabId ne survivent pas).
  chrome.storage.local.set({ enabledTabs: {} });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // Le content script demande le document offscreen (hébergement du worker
  // IA : un content script ne peut pas créer de Worker chrome-extension://).
  if (msg.type === "vocalis:ensure-offscreen") {
    ensureOffscreen().then(() => sendResponse({ ok: true }));
    return true; // réponse asynchrone
  }

  // Définit le User-Agent sortant pour googlevideo.com afin d'éviter le rejet
  // 403 CDN (YouTube vérifie la concordance entre le client et le User-Agent).
  if (msg.type === "vocalis:set-stream-ua") {
    const ua = msg.ua || "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";
    chrome.declarativeNetRequest
      .updateDynamicRules({
        removeRuleIds: [1001],
        addRules: [
          {
            id: 1001,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                {
                  header: "user-agent",
                  operation: "set",
                  value: ua,
                },
              ],
            },
            condition: {
              urlFilter: "googlevideo.com",
              resourceTypes: ["xmlhttprequest", "other", "media"],
            },
          },
        ],
      })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // Ping simple pour vérifier que tout le monde se parle.
  if (msg.type === "vocalis:ping") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return;
  }

  // Badge « ON » sur l'icône de l'extension pour l'onglet courant.
  if (msg.type === "vocalis:badge" && sender.tab?.id != null) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.on ? "ON" : "" });
    if (msg.on) {
      chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: BADGE_COLOR });
    }
    return;
  }

  // Bouton « Annuler » de l'overlay : désactive proprement l'onglet
  // (storage + badge), le content script faisant le reste en local.
  if (msg.type === "vocalis:disable-tab" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    chrome.storage.local.get({ enabledTabs: {} }).then(({ enabledTabs }) => {
      if (enabledTabs[tabId] !== undefined) {
        delete enabledTabs[tabId];
        chrome.storage.local.set({ enabledTabs });
      }
    });
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }

  // Le popup informe le worker de l'état d'un onglet (badge uniquement ici).
  if (msg.type === "vocalis:tab-state" && typeof msg.tabId === "number") {
    chrome.action.setBadgeText({ tabId: msg.tabId, text: msg.on ? "ON" : "" });
    if (msg.on) {
      chrome.action.setBadgeBackgroundColor({ tabId: msg.tabId, color: BADGE_COLOR });
    }
    return;
  }
});

// Si un onglet est fermé, on retire son entrée de la liste des onglets activés.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get({ enabledTabs: {} }).then(({ enabledTabs }) => {
    if (enabledTabs[tabId] !== undefined) {
      delete enabledTabs[tabId];
      chrome.storage.local.set({ enabledTabs });
    }
  });
});
