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

chrome.runtime.onInstalled.addListener(() => {
  // Nettoie les onglets activés d'une précédente session (les tabId ne survivent pas).
  chrome.storage.local.set({ enabledTabs: {} });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

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
