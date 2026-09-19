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
    return;
  }

  const { enabledTabs = {} } = await chrome.storage.local.get("enabledTabs");
  const enabled = !!enabledTabs[tab.id];

  btn.disabled = false;
  btn.classList.toggle("on", enabled);
  btn.textContent = enabled ? "Désactiver Vocalis" : "Activer sur cette vidéo";

  if (!enabled) {
    statusEl.textContent =
      "Prêt. Clique pour remplacer le son de la vidéo par sa version sans musique (modèle en v0.3).";
    progressZone.classList.add("hidden");
    return;
  }

  // Statut en direct du pipeline côté page.
  let st = null;
  try {
    st = await chrome.tabs.sendMessage(tab.id, { type: "vocalis:get-status" });
  } catch {
    /* page pas encore prête */
  }

  if (!st) {
    statusEl.textContent = "Vocalis actif — en attente du lecteur vidéo…";
    progressZone.classList.add("hidden");
    return;
  }

  if (st.notice) statusEl.textContent = st.notice;
  else if (st.active)
    statusEl.textContent =
      `Musique retirée, son synchronisé.` +
      (st.processedPct != null ? ` (${st.processedPct} % de la vidéo traité.)` : "");
  else if (st.started) statusEl.textContent = "Voix prêtes — bascule de la lecture…";
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
}

btn.addEventListener("click", async () => {
  const tab = await currentTab();
  if (!isYouTubeUrl(tab?.url)) return;

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

refresh();
setInterval(refresh, 800); // statut vivant pendant que le popup est ouvert
