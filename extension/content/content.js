/**
 * Vocalis — script de contenu YouTube (v0.1 : interface & squelette)
 *
 * Ce fichier est injecté sur toutes les pages youtube.com.
 *
 * En v0.1 il gère :
 *  - l'overlay de chargement (écran affiché pendant la préparation du son) ;
 *  - la barre « son traité » qui viendra se placer au niveau de la barre
 *    rouge YouTube (comme la barre grise de buffer, mais pour l'audio traité) ;
 *  - les hooks de navigation (YouTube est une SPA : on doit purger le cache
 *    quand on quitte une vidéo — logique réelle en v0.2).
 *
 * En v0.2+ il orchestrera :
 *  - la récupération du flux audio de la vidéo ;
 *  - le découpage en segments et leur envoi au moteur de séparation ;
 *  - la relecture du son sans musique, synchronisé avec l'image ;
 *  - le cache IndexedDB (conservé pendant la vidéo, purgé en la quittant).
 */

(() => {
  "use strict";

  const state = {
    enabled: false,
    overlay: null,
    overlayTimer: null,
  };

  /* ------------------------------------------------------------------ */
  /* Utilitaires DOM                                                     */
  /* ------------------------------------------------------------------ */

  const getVideoElement = () => document.querySelector("video.html5-main-video") ||
    document.querySelector("video");

  const getPlayerContainer = () => document.querySelector(".html5-video-player");

  /* ------------------------------------------------------------------ */
  /* Overlay de chargement                                               */
  /* ------------------------------------------------------------------ */

  function showOverlay({ title, subtitle, progressPct = null }) {
    let overlay = document.getElementById("vocalis-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "vocalis-overlay";
      overlay.innerHTML = `
        <div class="vocalis-card">
          <div class="vocalis-logo">
            <span></span><span></span><span></span><span></span><span></span>
          </div>
          <h2 class="vocalis-title"></h2>
          <p class="vocalis-subtitle"></p>
          <div class="vocalis-progress"><div class="vocalis-progress-fill"></div></div>
          <p class="vocalis-note"></p>
        </div>`;
      (getPlayerContainer() || document.body).appendChild(overlay);
    }

    overlay.querySelector(".vocalis-title").textContent = title;
    overlay.querySelector(".vocalis-subtitle").textContent = subtitle || "";
    overlay.querySelector(".vocalis-note").textContent =
      "Vocalis v0.1 — le moteur de séparation audio arrive en v0.3. " +
      "En attendant, ce pipeline est validé étape par étape (voir docs/ROADMAP.md).";

    const fill = overlay.querySelector(".vocalis-progress-fill");
    if (progressPct == null) {
      fill.classList.add("indeterminate");
      fill.style.width = "";
    } else {
      fill.classList.remove("indeterminate");
      fill.style.width = `${progressPct}%`;
    }

    state.overlay = overlay;
  }

  function hideOverlay() {
    document.getElementById("vocalis-overlay")?.remove();
    state.overlay = null;
    if (state.overlayTimer) {
      clearTimeout(state.overlayTimer);
      state.overlayTimer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Barre « son traité » (au niveau de la barre rouge YouTube)          */
  /* ------------------------------------------------------------------ */

  /**
   * Affiche les zones de son déjà traitées/mises en cache.
   * `ranges` = liste de [début, fin] en secondes (v0.2+).
   * En v0.1 la barre existe mais reste vide.
   */
  function updateBufferBar(ranges = [], duration = 0) {
    const anchor = document.querySelector(".ytp-progress-bar");
    if (!anchor) return;

    let bar = document.getElementById("vocalis-bufferbar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "vocalis-bufferbar";
      bar.title = "Vocalis : parties de la vidéo dont le son est déjà traité";
      anchor.parentElement.appendChild(bar);
    }

    bar.replaceChildren();
    if (!duration) return;
    for (const [start, end] of ranges) {
      const seg = document.createElement("div");
      seg.className = "vocalis-bufferbar-seg";
      seg.style.left = `${(start / duration) * 100}%`;
      seg.style.width = `${Math.max(0, ((end - start) / duration) * 100)}%`;
      bar.appendChild(seg);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Cache                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * v0.2 : videra le cache IndexedDB des segments audio de la vidéo courante.
   * Règle produit : le cache vit tant qu'on reste sur la vidéo (retour en
   * arrière = relecture instantanée), il est purgé dès qu'on la quitte.
   */
  function purgeCache() {
    // TODO(v0.2) : indexedDB.deleteDatabase / suppression des clés videoId:*
  }

  /* ------------------------------------------------------------------ */
  /* Activation / désactivation                                          */
  /* ------------------------------------------------------------------ */

  function setEnabled(enabled) {
    state.enabled = enabled;

    chrome.runtime.sendMessage({ type: "vocalis:badge", on: enabled }).catch(() => {});

    if (enabled) {
      const video = getVideoElement();
      showOverlay({
        title: video ? "Préparation du son…" : "En attente du lecteur vidéo…",
        subtitle: video
          ? "La musique de fond sera retirée, les voix conservées."
          : "Ouvre une vidéo puis réactive Vocalis.",
      });
      // v0.1 : pas encore de moteur, on informe au bout de quelques secondes.
      state.overlayTimer = setTimeout(() => {
        // L'overlay reste visible : c'est l'emplacement du futur écran de
        // chargement (barre de progression réelle à partir de la v0.2).
      }, 2500);
    } else {
      hideOverlay();
      purgeCache();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Messages & navigation                                               */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "vocalis:set-enabled") {
      setEnabled(!!msg.enabled);
    }
    // v0.2 : messages d'avancement du pipeline → barre de progression + buffer bar.
  });

  // YouTube est une single-page app : ces événements signalent qu'on change
  // de page/vidéo sans recharger l'onglet. C'est LÀ qu'on purge le cache.
  document.addEventListener("yt-navigate-start", () => {
    purgeCache();
    hideOverlay();
  });
  window.addEventListener("pagehide", () => {
    purgeCache();
  });

  // v0.2 : surveiller aussi les changements de vidéo à l'intérieur du lecteur
  // (clic sur une vidéo suivante dans la playlist auto) via MutationObserver
  // sur <video> et l'URL courante.
})();
