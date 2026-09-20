/**
 * Vocalis — popup (bouton de la barre d'extensions Chrome)
 *
 * v0.2 : active/désactive Vocalis sur l'onglet YouTube courant ET affiche
 * l'état en direct du pipeline (phase, progression, éventuel message).
 */

const btn = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const versionEl = document.getElementById("version");
const progressZone = document.getElementById("progress-zone");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const syncWarning = document.getElementById("sync-warning");
const reloadTabBtn = document.getElementById("reload-tab-btn");

const PHASES = {
  response: "Lecture du lecteur YouTube…",
  download: "Téléchargement de l'audio",
  decode: "Analyse de l'audio…",
  resample: "Mise au format 44,1 kHz…",
  model: "Modèle IA (HTDemucs)",
  prepare: "Séparation voix / musique (pré-chargement)",
  stall: "Traitement de la zone en cours…",
};

function isYouTubeUrl(url = "") {
  try {
    const host = new URL(url).hostname;
    return host === "www.youtube.com" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const tab = await currentTab();
  const onYouTube = isYouTubeUrl(tab?.url);

  versionEl.textContent = "v" + chrome.runtime.getManifest().version;

  if (!onYouTube) {
    btn.disabled = true;
    btn.textContent = "Ouvre une vidéo YouTube";
    statusEl.textContent =
      "Vocalis s'utilise sur une page YouTube. Ouvre une vidéo puis reviens ici.";
    progressZone.classList.add("hidden");
    syncWarning?.classList.add("hidden");
    return;
  }

  // Vérifie si le script de contenu répond dans l'onglet
  let st = null;
  let connectionFailed = false;
  try {
    st = await chrome.tabs.sendMessage(tab.id, { type: "vocalis:get-status" });
  } catch {
    connectionFailed = true;
  }

  if (connectionFailed) {
    // Si le content script ne répond pas, la page a été ouverte avant la mise à jour
    syncWarning?.classList.remove("hidden");
    statusEl.textContent = "Page non synchronisée suite à la mise à jour.";
    btn.disabled = false;
    btn.classList.remove("on");
    btn.textContent = "🔄 Recharger la page (F5)";
    progressZone.classList.add("hidden");
    return;
  }

  syncWarning?.classList.add("hidden");

  const { enabledTabs = {} } = await chrome.storage.local.get("enabledTabs");
  const enabled = !!enabledTabs[tab.id];

  btn.disabled = false;
  btn.classList.toggle("on", enabled);
  btn.textContent = enabled ? "Désactiver Vocalis" : "Activer sur cette vidéo";

  if (!enabled) {
    statusEl.textContent =
      "Prêt. Clique sur le bouton Vocalis dans la barre du lecteur YouTube ou ici pour lancer.";
    progressZone.classList.add("hidden");
    return;
  }

  if (st.notice) statusEl.textContent = st.notice;
  else if (st.active) {
    const bits = [];
    if (st.processedPct != null) bits.push(st.processedPct + " % traité");
    if (st.mode) bits.push("mode " + st.mode);
    if (st.via) bits.push("flux via " + st.via);
    statusEl.textContent =
      "Musique retirée, son synchronisé." + (bits.length ? " (" + bits.join(", ") + ")" : "");
  } else if (st.started) statusEl.textContent = "Voix prêtes — bascule de la lecture…";
  else statusEl.textContent = "Pipeline en cours…";

  if (!st.active && st.phase) {
    progressZone.classList.remove("hidden");
    const label = PHASES[st.phase] || st.phase;
    if (st.pct != null) {
      progressFill.style.width = st.pct + "%";
      progressLabel.textContent = `${label} — ${st.pct} %`;
    } else {
      progressFill.style.width = "100%";
      progressLabel.textContent = label;
    }
  } else {
    progressZone.classList.add("hidden");
  }

  const journalEl = document.getElementById("journal");
  const debug =
    "état=" + (st.active ? "ACTIF" : st.started ? "prêt" : st.running ? "pipeline" : "idle") +
    "  phase=" + (st.phase ?? "-") +
    (st.pct != null ? " " + st.pct + "%" : "") +
    "  mode=" + (st.mode ?? "-") + "  via=" + (st.via ?? "-") + "\n" +
    (st.journal || []).join("\n");
  journalEl.classList.remove("hidden");
  journalEl.textContent = debug;
  journalEl.scrollTop = journalEl.scrollHeight;
}

btn.addEventListener("click", async () => {
  const tab = await currentTab();
  if (!isYouTubeUrl(tab?.url)) return;

  // Si le content script est déconnecté, un clic recharge immédiatement la page
  let responsive = false;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "vocalis:get-status" });
    if (res) responsive = true;
  } catch {}

  if (!responsive) {
    chrome.tabs.reload(tab.id);
    window.close();
    return;
  }

  const { enabledTabs = {} } = await chrome.storage.local.get("enabledTabs");
  const nowEnabled = !enabledTabs[tab.id];

  if (nowEnabled) enabledTabs[tab.id] = true;
  else delete enabledTabs[tab.id];
  await chrome.storage.local.set({ enabledTabs });

  chrome.runtime.sendMessage({ type: "vocalis:tab-state", tabId: tab.id, on: nowEnabled });
  chrome.tabs
    .sendMessage(tab.id, { type: "vocalis:set-enabled", enabled: nowEnabled })
    .catch(() => {});

  refresh();
});

if (reloadTabBtn) {
  reloadTabBtn.addEventListener("click", async () => {
    const tab = await currentTab();
    if (tab?.id) {
      chrome.tabs.reload(tab.id);
      window.close();
    }
  });
}

const openStudioBtn = document.getElementById("open-studio");
if (openStudioBtn) {
  openStudioBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("studio.html") });
  });
}

refresh();
setInterval(refresh, 800); // statut vivant pendant que le popup est ouvert
