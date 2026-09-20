/**
 * Vocalis — popup (contrôleur d'extension Chrome)
 *
 * Affiche l'état en direct du pipeline (stepper multi-étapes, jauge, GPU,
 * tampon) et permet d'activer/désactiver Vocalis en un clic.
 */

const btn = document.getElementById("toggle");
const toggleLabel = document.getElementById("toggle-label");
const statusEl = document.getElementById("status");
const statusDot = document.getElementById("status-dot");
const versionEl = document.getElementById("version");
const progressZone = document.getElementById("progress-zone");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const stepperStepTitle = document.getElementById("stepper-step-title");
const stepperPct = document.getElementById("stepper-pct");
const stepPillAudio = document.getElementById("step-pill-audio");
const stepPillIa = document.getElementById("step-pill-ia");
const stepPillVocal = document.getElementById("step-pill-vocal");
const specEngine = document.getElementById("spec-engine");
const specBuffer = document.getElementById("spec-buffer");
const syncWarning = document.getElementById("sync-warning");
const reloadTabBtn = document.getElementById("reload-tab-btn");

const PHASES = {
  response: "Connexion au lecteur YouTube…",
  download: "Téléchargement du flux audio",
  decode: "Analyse du format audio…",
  resample: "Mise au format IA (44,1 kHz)…",
  model: "Chargement du modèle Demucs v4",
  prepare: "Isolation de la voix (pré-chargement)",
  stall: "Traitement de cette zone…",
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

  if (versionEl) versionEl.textContent = "v" + chrome.runtime.getManifest().version;

  if (!onYouTube) {
    btn.disabled = true;
    if (toggleLabel) toggleLabel.textContent = "Ouvre une vidéo YouTube";
    statusEl.textContent = "Ouvre une vidéo sur YouTube pour activer Vocalis.";
    if (statusDot) statusDot.className = "status-dot";
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
    syncWarning?.classList.remove("hidden");
    statusEl.textContent = "Page non synchronisée suite à la mise à jour.";
    if (statusDot) statusDot.className = "status-dot error";
    btn.disabled = false;
    btn.classList.remove("on");
    if (toggleLabel) toggleLabel.textContent = "🔄 Recharger YouTube (F5)";
    progressZone.classList.add("hidden");
    return;
  }

  syncWarning?.classList.add("hidden");

  const { enabledTabs = {} } = await chrome.storage.local.get("enabledTabs");
  const enabled = !!enabledTabs[tab.id];

  btn.disabled = false;
  btn.classList.toggle("on", enabled);

  if (st?.mode) {
    if (specEngine) specEngine.textContent = "WebGPU";
  }
  if (st?.processedPct != null) {
    if (specBuffer) specBuffer.textContent = `${st.processedPct} %`;
  }

  if (!enabled) {
    if (toggleLabel) toggleLabel.textContent = "Activer sur cette vidéo";
    statusEl.textContent = "Prêt. Clique pour retirer la musique de fond.";
    if (statusDot) statusDot.className = "status-dot";
    progressZone.classList.add("hidden");
    return;
  }

  if (st.notice) {
    statusEl.textContent = st.notice;
    if (statusDot) statusDot.className = "status-dot error";
    if (toggleLabel) toggleLabel.textContent = "Erreur — Réessayer";
  } else if (st.active) {
    if (statusDot) statusDot.className = "status-dot active";
    if (toggleLabel) toggleLabel.textContent = "Désactiver Vocalis";
    const bits = [];
    if (st.processedPct != null) bits.push(`${st.processedPct} % traité`);
    if (st.via) bits.push(`via ${st.via}`);
    statusEl.textContent = "Voix isolées, musique retirée." + (bits.length ? " (" + bits.join(" · ") + ")" : "");
    progressZone.classList.add("hidden");
  } else if (st.started) {
    if (statusDot) statusDot.className = "status-dot loading";
    if (toggleLabel) toggleLabel.textContent = "Voix prêtes…";
    statusEl.textContent = "Pré-chargement terminé — synchronisation du lecteur…";
    progressZone.classList.add("hidden");
  } else {
    if (statusDot) statusDot.className = "status-dot loading";
    if (toggleLabel) toggleLabel.textContent = "Préparation en cours…";
    statusEl.textContent = "Séparation en cours sur ton PC…";
  }

  // Mise à jour du stepper si en cours de préparation
  if (!st.active && st.phase) {
    progressZone.classList.remove("hidden");
    const phaseName = st.phase;
    const label = PHASES[phaseName] || phaseName;

    if (st.pct != null) {
      progressFill.style.width = st.pct + "%";
      if (stepperPct) stepperPct.textContent = `${st.pct} %`;
      progressLabel.textContent = `${label} — ${st.pct} %`;
    } else {
      progressFill.style.width = "40%";
      progressFill.classList.add("indeterminate");
      if (stepperPct) stepperPct.textContent = "…";
      progressLabel.textContent = label;
    }

    if (phaseName === "response" || phaseName === "download") {
      if (stepPillAudio) stepPillAudio.className = "step-pill active";
      if (stepPillIa) stepPillIa.className = "step-pill pending";
      if (stepPillVocal) stepPillVocal.className = "step-pill pending";
      if (stepperStepTitle) stepperStepTitle.textContent = "1. Flux audio YouTube";
    } else if (phaseName === "decode" || phaseName === "resample" || phaseName === "model") {
      if (stepPillAudio) stepPillAudio.className = "step-pill done";
      if (stepPillIa) stepPillIa.className = "step-pill active";
      if (stepPillVocal) stepPillVocal.className = "step-pill pending";
      if (stepperStepTitle) stepperStepTitle.textContent = "2. Modèle IA (Demucs v4)";
    } else if (phaseName === "prepare" || phaseName === "stall") {
      if (stepPillAudio) stepPillAudio.className = "step-pill done";
      if (stepPillIa) stepPillIa.className = "step-pill done";
      if (stepPillVocal) stepPillVocal.className = "step-pill active";
      if (stepperStepTitle) stepperStepTitle.textContent = "3. Isolation vocale";
    }
  } else {
    progressZone.classList.add("hidden");
  }

  const journalEl = document.getElementById("journal");
  if (journalEl) {
    const debug =
      "état=" + (st.active ? "ACTIF" : st.started ? "prêt" : st.running ? "pipeline" : "idle") +
      "  phase=" + (st.phase ?? "-") +
      (st.pct != null ? " " + st.pct + "%" : "") +
      "  mode=" + (st.mode ?? "-") + "  via=" + (st.via ?? "-") + "\n" +
      (st.journal || []).join("\n");
    journalEl.textContent = debug;
    journalEl.scrollTop = journalEl.scrollHeight;
  }
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
setInterval(refresh, 800);
