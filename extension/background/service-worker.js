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

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunk = 8192;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
  }
  return btoa(binary);
}

async function cleanNetRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = existing.map((r) => r.id);
    if (ids.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
    }
  } catch (e) {
    console.error("cleanNetRules:", e);
  }
}

// Nettoie immédiatement toute règle résiduelle pouvant bloquer le lecteur YouTube
cleanNetRules();

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

chrome.runtime.onInstalled.addListener(async () => {
  // Nettoie les onglets activés d'une précédente session (les tabId ne survivent pas).
  chrome.storage.local.set({ enabledTabs: {} });
  await cleanNetRules();

  // Ré-injection automatique sur les onglets YouTube ouverts afin que l'utilisateur
  // n'ait pas besoin de recharger la page après une mise à jour de l'extension.
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          "content/idb.js",
          "content/innertube.js",
          "content/cipher.js",
          "content/workerproxy.js",
          "content/engine.js",
          "content/content.js",
        ],
      }).catch(() => {});
      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["content/vocalis.css"],
      }).catch(() => {});
    }
  } catch {}
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // Le content script demande le document offscreen (hébergement du worker
  // IA : un content script ne peut pas créer de Worker chrome-extension://).
  if (msg.type === "vocalis:ensure-offscreen") {
    ensureOffscreen().then(() => sendResponse({ ok: true }));
    return true; // réponse asynchrone
  }

  // Définit le User-Agent sortant pour googlevideo.com (non utilisé en standard)
  if (msg.type === "vocalis:set-stream-ua") {
    sendResponse({ ok: true });
    return;
  }

  // Téléchargement sécurisé du flux audio complet sans restriction CORS ni bride de tranche
  if (msg.type === "vocalis:fetch-full-audio") {
    let cleanUrl = msg.url;
    try {
      const u = new URL(msg.url);
      u.searchParams.delete("range");
      cleanUrl = u.toString();
    } catch {}

    fetch(cleanUrl)
      .then(async (resp) => {
        if (!resp.ok) {
          sendResponse({ ok: false, status: resp.status, error: "HTTP " + resp.status });
          return;
        }
        const total = parseInt(resp.headers.get("content-length") || "0", 10);
        const buf = await resp.arrayBuffer();
        const base64 = arrayBufferToBase64(buf);
        sendResponse({ ok: true, base64, total: total || buf.byteLength, size: buf.byteLength });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  // Téléchargement sécurisé de tranches audio sans restriction CORS
  // (exécuté avec l'origine de l'extension et les host_permissions googlevideo).
  if (msg.type === "vocalis:fetch-range") {
    let cleanUrl = msg.url;
    try {
      const u = new URL(msg.url);
      u.searchParams.delete("range");
      cleanUrl = u.toString();
    } catch {}

    const headers = {};
    if (msg.start != null && msg.end != null) {
      headers["Range"] = `bytes=${msg.start}-${msg.end}`;
    }
    fetch(cleanUrl, { headers })
      .then(async (resp) => {
        if (!resp.ok && resp.status !== 206) {
          // Si le header Range est refusé, tente avec le paramètre ?range= dans l'URL
          try {
            const u2 = new URL(cleanUrl);
            u2.searchParams.set("range", `${msg.start}-${msg.end}`);
            const resp2 = await fetch(u2.toString());
            if (resp2.ok || resp2.status === 206) {
              const buf2 = await resp2.arrayBuffer();
              const base64 = arrayBufferToBase64(buf2);
              const cr2 = resp2.headers.get("content-range");
              let t2 = 0;
              const m2 = cr2 && cr2.match(/\/(\d+)$/);
              if (m2) t2 = parseInt(m2[1], 10);
              else if (resp2.status === 200) t2 = parseInt(resp2.headers.get("content-length") || "0", 10);
              sendResponse({ ok: true, base64, total: t2 });
              return;
            }
          } catch {}
          sendResponse({ ok: false, status: resp.status });
          return;
        }
        const cr = resp.headers.get("content-range");
        let total = 0;
        const m = cr && cr.match(/\/(\d+)$/);
        if (m) total = parseInt(m[1], 10);
        else if (resp.status === 200) total = parseInt(resp.headers.get("content-length") || "0", 10);

        const buf = await resp.arrayBuffer();
        const base64 = arrayBufferToBase64(buf);
        sendResponse({ ok: true, base64, total });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
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

  // Synchronisation depuis le bouton du lecteur vidéo (.ytp-right-controls)
  if (msg.type === "vocalis:set-tab-enabled" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    chrome.storage.local.get({ enabledTabs: {} }).then(({ enabledTabs }) => {
      if (msg.enabled) enabledTabs[tabId] = true;
      else delete enabledTabs[tabId];
      chrome.storage.local.set({ enabledTabs });
    });
    chrome.action.setBadgeText({ tabId, text: msg.enabled ? "ON" : "" });
    if (msg.enabled) {
      chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
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
