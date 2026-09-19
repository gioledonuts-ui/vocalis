/**
 * Vocalis — script de contenu YouTube v0.2
 *
 * Orchestre le moteur audio (engine.js) :
 *  - activation/désactivation depuis le popup ;
 *  - overlay de chargement avec progression réelle (téléchargement,
 *    décodage, préparation) ;
 *  - barre « son traité » au-dessus de la barre rouge YouTube ;
 *  - cycle de vie du cache : conservé pendant la vidéo, purgé quand on
 *    en change (SPA) ou quand on quitte la page.
 */

(() => {
  "use strict";

  const state = {
    enabled: false,
    engine: null,
    currentVideoId: null,
    status: { phase: null, pct: null, notice: null },
  };

  const MB = (b) => (b / 1048576).toFixed(1) + " Mo";

  const getVideoElement = () =>
    document.querySelector("video.html5-main-video") || document.querySelector("video");

  /* ------------------------------------------------------------------ */
  /* Overlay                                                             */
  /* ------------------------------------------------------------------ */

  function showOverlay({ title, subtitle, pct = null, error = false, closable = false }) {
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
          <button class="vocalis-close" type="button">Fermer et garder le son original</button>
        </div>`;
      (document.querySelector(".html5-video-player") || document.body).appendChild(overlay);
      overlay.querySelector(".vocalis-close").addEventListener("click", hideOverlay);
    }

    overlay.querySelector(".vocalis-card").classList.toggle("error", error);
    overlay.querySelector(".vocalis-title").textContent = title;
    overlay.querySelector(".vocalis-subtitle").textContent = subtitle || "";
    overlay.querySelector(".vocalis-close").style.display = closable ? "" : "none";
    overlay.querySelector(".vocalis-note").textContent = error
      ? "La vidéo reste lisible avec son son d'origine."
      : "Vocalis v0.2 — pipeline audio validé, modèle de séparation en v0.3.";

    const fill = overlay.querySelector(".vocalis-progress-fill");
    if (pct == null) {
      fill.classList.add("indeterminate");
      fill.style.width = "";
    } else {
      fill.classList.remove("indeterminate");
      fill.style.width = pct + "%";
    }
  }

  function hideOverlay() {
    document.getElementById("vocalis-overlay")?.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Barre « son traité »                                                */
  /* ------------------------------------------------------------------ */

  function updateBufferBar(ranges = [], duration = 0) {
    const anchor = document.querySelector(".ytp-progress-bar");
    if (!anchor) return;

    let bar = document.getElementById("vocalis-bufferbar");
    if (!ranges.length || !duration) {
      bar?.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "vocalis-bufferbar";
      bar.title = "Vocalis : son déjà préparé (retour arrière instantané)";
      anchor.parentElement.appendChild(bar);
    }

    bar.replaceChildren();
    for (const [start, end] of ranges) {
      const seg = document.createElement("div");
      seg.className = "vocalis-bufferbar-seg";
      seg.style.left = (start / duration) * 100 + "%";
      seg.style.width = Math.max(0, ((end - start) / duration) * 100) + "%";
      bar.appendChild(seg);
    }
  }

  function hideBufferBar() {
    document.getElementById("vocalis-bufferbar")?.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Cycle de vie du moteur + cache                                      */
  /* ------------------------------------------------------------------ */

  async function teardown({ purge = false } = {}) {
    const engine = state.engine;
    state.engine = null;
    engine?.destroy();
    hideOverlay();
    hideBufferBar();
    state.status = { phase: null, pct: null, notice: null };
    if (purge && state.currentVideoId) {
      await VocalisIDB.deleteVideo(state.currentVideoId).catch(() => {});
    }
    state.currentVideoId = null;
  }

  async function startPipeline() {
    const video = getVideoElement();
    if (!video) return;

    const engine = new VocalisEngine(video, {
      onPhase: (name, pct, info) => {
        state.status.phase = name;
        state.status.pct = pct;
        if (!state.enabled) return;
        if (name === "response") {
          showOverlay({ title: "Lecture du lecteur YouTube…", pct: null });
        } else if (name === "download") {
          showOverlay({
            title: "Téléchargement de l'audio…",
            subtitle:
              pct != null
                ? `${pct} %` + (info ? ` — ${MB(info.received)} / ${MB(info.total)}` : "")
                : "Connexion au flux audio…",
            pct,
          });
        } else if (name === "decode") {
          showOverlay({ title: "Analyse de l'audio…", pct: null });
        } else if (name === "resample") {
          showOverlay({ title: "Mise au format du modèle (44,1 kHz)…", pct: null });
        } else if (name === "model") {
          showOverlay({
            title: info?.cached
              ? "Chargement du modèle IA depuis ton PC…"
              : "Téléchargement du modèle IA (une seule fois, ~172 Mo)…",
            subtitle: info?.cached ? "" : `${pct ?? 0} % — ensuite tout reste sur ton PC`,
            pct: info?.cached ? null : pct,
          });
        } else if (name === "prepare") {
          showOverlay({
            title: "Séparation voix / musique…",
            subtitle: `Pré-chargement : ${pct ?? 0} % — la lecture démarre dès que c'est prêt`,
            pct,
          });
        }
      },
      onProcessed: (ranges, duration) => {
        updateBufferBar(ranges, duration);
      },
      onStall: (pct) => {
        state.status.phase = "stall";
        showOverlay({
          title: "Traitement de cette zone…",
          subtitle: `Vidéo traitée à ${pct} % — un instant.`,
          pct: null,
        });
      },
      onStallClear: () => {
        if (state.status.phase === "stall") {
          state.status.phase = null;
          hideOverlay();
        }
      },
      onError: (msg) => {
        state.status.notice = msg;
        if (state.enabled) {
          showOverlay({ title: msg, subtitle: "", error: true, closable: true, pct: null });
        }
      },
      onNotice: (msg) => {
        state.status.notice = msg;
      },
      onReady: (duration) => {
        state.currentVideoId = engine.videoId;
        hideOverlay();
        updateBufferBar([[0, duration]], duration);
        if (state.enabled) engine.activate();
      },
    });

    state.engine = engine;
    await engine.start();
  }

  function setEnabled(enabled) {
    state.enabled = enabled;
    chrome.runtime.sendMessage({ type: "vocalis:badge", on: enabled }).catch(() => {});

    if (!enabled) {
      // On garde le cache (re-activation instantanée) ; il sera purgé
      // quand on quittera la vidéo.
      state.engine?.deactivate();
      hideOverlay();
      hideBufferBar();
      return;
    }

    if (state.engine?.started) {
      updateBufferBar([[0, state.engine.duration]], state.engine.duration);
      state.engine.activate();
    } else if (!state.engine || !state.engine.running) {
      // Jamais lancé, ou précédent essai en erreur : on (re)part.
      startPipeline();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Messages, navigation SPA, purge                                     */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "vocalis:set-enabled") {
      setEnabled(!!msg.enabled);
    }
    if (msg?.type === "vocalis:get-status") {
      sendResponse({
        enabled: state.enabled,
        started: !!state.engine?.started,
        active: !!state.engine?.active,
        phase: state.status.phase,
        pct: state.status.pct,
        notice: state.status.notice,
        videoId: state.currentVideoId,
        processedPct: state.engine?.status().processedPct ?? null,
      });
    }
  });

  // Le pont main-world signale tout changement de vidéo (SPA) :
  // on purge le cache de l'ancienne et on repart si Vocalis est actif.
  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.source !== "vocalis-bridge") return;
    if (e.data.type !== "video-changed") return;
    const { from, to } = e.data.payload || {};
    if (!from || from === to) return;

    await teardown({ purge: true }); // règle produit : quitter la vidéo = vider le cache
    if (state.enabled && to) startPipeline();
  });

  window.addEventListener("pagehide", () => {
    if (state.currentVideoId) VocalisIDB.deleteVideo(state.currentVideoId).catch(() => {});
  });
})();
