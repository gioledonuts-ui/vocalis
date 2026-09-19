/**
 * Vocalis — popup (bouton de la barre d'extensions Chrome)
 *
 * v0.1 : active/désactive Vocalis pour l'onglet YouTube courant.
 * L'état est persisté dans chrome.storage.local (par tabId) et transmis
 * au script de contenu de la page YouTube.
 */

const btn = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const versionEl = document.getElementById("version");

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
    return;
  }

  const { enabledTabs = {} } = await chrome.storage.local.get("enabledTabs");
  const enabled = !!enabledTabs[tab.id];

  btn.disabled = false;
  btn.classList.toggle("on", enabled);
  btn.textContent = enabled ? "Désactiver Vocalis" : "Activer sur cette vidéo";
  statusEl.textContent = enabled
    ? "Vocalis est actif sur cet onglet. (v0.1 : le moteur de séparation arrive en v0.3.)"
    : "Prêt. Clique pour traiter le son de cette vidéo sans sa musique de fond.";
}

btn.addEventListener("click", async () => {
  const tab = await currentTab();
  if (!isYouTubeUrl(tab?.url)) return;

  const { enabledTabs = {} } = await chrome.storage.local.get("enabledTabs");
  const nowEnabled = !enabledTabs[tab.id];

  if (nowEnabled) enabledTabs[tab.id] = true;
  else delete enabledTabs[tab.id];
  await chrome.storage.local.set({ enabledTabs });

  // Prévient le service worker (badge) et la page YouTube (overlay).
  chrome.runtime.sendMessage({ type: "vocalis:tab-state", tabId: tab.id, on: nowEnabled });
  chrome.tabs.sendMessage(tab.id, { type: "vocalis:set-enabled", enabled: nowEnabled }).catch(() => {
    // La page n'a pas encore son script de contenu (chargement en cours) :
    // elle relira l'état au prochain message. Rien à faire de plus en v0.1.
  });

  refresh();
});

refresh();
