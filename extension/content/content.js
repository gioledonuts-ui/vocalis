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
    journal: [],
  };

  function logLine(msg) {
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, "0") + ":" +
      String(t.getMinutes()).padStart(2, "0") + ":" +
      String(t.getSeconds()).padStart(2, "0");
    state.journal.push(hh + "  " + msg);
    if (state.journal.length > 40) state.journal.shift();
  }

  const MB = (b) => (b / 1048576).toFixed(1) + " Mo";

  const getVideoElement = () =>
    document.querySelector("video.html5-main-video") || document.querySelector("video");

  /* ------------------------------------------------------------------ */
  /* Overlay                                                             */
  /* ------------------------------------------------------------------ */

  function cancelVocalis() {
    // Désactivation complète (storage + badge compris) depuis l'overlay.
    chrome.runtime.sendMessage({ type: "vocalis:disable-tab" }).catch(() => {});
    setEnabled(false);
  }

  /* ------------------------------------------------------------------ */
  /* Bouton intégré dans le lecteur YouTube (.ytp-right-controls)       */
  /* ------------------------------------------------------------------ */

  function insertPlayerButton() {
    const player = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    const rightControls = player
      ? player.querySelector(".ytp-right-controls")
      : document.querySelector(".ytp-right-controls");
    if (!rightControls) return;

    let btn = document.getElementById("vocalis-player-btn");
    if (btn && btn.parentNode === rightControls) {
      updatePlayerButton();
      return;
    }
    if (btn) {
      btn.remove();
      btn = null;
    }

    if (!btn) {
      btn = document.createElement("button");
      btn.id = "vocalis-player-btn";
      btn.className = "ytp-button vocalis-player-btn";
      btn.setAttribute("aria-label", "Vocalis — Retirer la musique de fond (Alt+V)");
      btn.setAttribute("title", "Vocalis — Retirer la musique de fond (Alt+V)");
      btn.style.cssText =
        "display:inline-flex!important;align-items:center!important;justify-content:center!important;" +
        "width:46px!important;height:100%!important;vertical-align:top!important;cursor:pointer!important;" +
        "opacity:0.9;padding:0!important;border:none!important;background:transparent!important;";

      btn.innerHTML = `
        <svg height="100%" version="1.1" viewBox="0 0 36 36" width="100%" style="pointer-events:none;width:100%!important;height:100%!important;">
          <path class="ytp-svg-fill vocalis-icon-path" fill="#ffffff" d="M 8.5,13 h 0.0 a 1.5,1.5 0 0 1 1.5,1.5 v 7.0 a 1.5,1.5 0 0 1 -1.5,1.5 h -0.0 a 1.5,1.5 0 0 1 -1.5,-1.5 v -7.0 a 1.5,1.5 0 0 1 1.5,-1.5 Z M 13.5,9 h 0.0 a 1.5,1.5 0 0 1 1.5,1.5 v 15.0 a 1.5,1.5 0 0 1 -1.5,1.5 h -0.0 a 1.5,1.5 0 0 1 -1.5,-1.5 v -15.0 a 1.5,1.5 0 0 1 1.5,-1.5 Z M 18.5,6 h 0.0 a 1.5,1.5 0 0 1 1.5,1.5 v 21.0 a 1.5,1.5 0 0 1 -1.5,1.5 h -0.0 a 1.5,1.5 0 0 1 -1.5,-1.5 v -21.0 a 1.5,1.5 0 0 1 1.5,-1.5 Z M 23.5,11 h 0.0 a 1.5,1.5 0 0 1 1.5,1.5 v 11.0 a 1.5,1.5 0 0 1 -1.5,1.5 h -0.0 a 1.5,1.5 0 0 1 -1.5,-1.5 v -11.0 a 1.5,1.5 0 0 1 1.5,-1.5 Z M 28.5,8 h 0.0 a 1.5,1.5 0 0 1 1.5,1.5 v 17.0 a 1.5,1.5 0 0 1 -1.5,1.5 h -0.0 a 1.5,1.5 0 0 1 -1.5,-1.5 v -17.0 a 1.5,1.5 0 0 1 1.5,-1.5 Z"></path>
        </svg>
      `;

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setEnabled(!state.enabled);
      });

      btn.addEventListener("mouseenter", () => {
        btn.style.opacity = "1";
        btn.style.transform = "scale(1.1)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.opacity = state.enabled ? "1" : "0.9";
        btn.style.transform = "scale(1)";
      });
    }

    const settingsBtn = rightControls.querySelector(".ytp-settings-button");
    if (settingsBtn && settingsBtn.parentNode === rightControls) {
      rightControls.insertBefore(btn, settingsBtn);
    } else {
      rightControls.prepend(btn);
    }

    updatePlayerButton();
  }

  function updatePlayerButton() {
    const btn = document.getElementById("vocalis-player-btn");
    if (!btn) return;

    const path = btn.querySelector(".vocalis-icon-path");
    const isActive = state.enabled && !!state.engine?.active;
    const isPreparing = state.enabled && !state.engine?.active && !state.status.notice;
    const isError = state.enabled && !!state.status.notice && !state.engine?.started;

    btn.classList.toggle("active", isActive);
    btn.classList.toggle("loading", isPreparing);
    btn.classList.toggle("error", isError);

    if (path) {
      if (isActive) {
        path.setAttribute("fill", "#a78bfa");
        path.style.filter = "drop-shadow(0 0 5px rgba(167, 139, 250, 0.9))";
      } else if (isPreparing) {
        path.setAttribute("fill", "#22d3ee");
        path.style.filter = "drop-shadow(0 0 4px #22d3ee)";
      } else if (isError) {
        path.setAttribute("fill", "#f87171");
        path.style.filter = "none";
      } else {
        path.setAttribute("fill", "#ffffff");
        path.style.filter = "none";
      }
    }

    if (isActive) {
      btn.title = "Vocalis : Actif (musique retirée, voix seules) — Cliquer pour couper (Alt+V)";
      btn.setAttribute("aria-label", "Vocalis : Actif");
    } else if (isPreparing) {
      const p = state.status.pct != null ? ` (${state.status.pct} %)` : "";
      btn.title = `Vocalis : Préparation en cours${p}… — Cliquer pour annuler (Alt+V)`;
      btn.setAttribute("aria-label", "Vocalis : Préparation en cours");
    } else if (isError) {
      btn.title = `Vocalis : ${state.status.notice || "Erreur"} — Cliquer pour réessayer (Alt+V)`;
      btn.setAttribute("aria-label", "Vocalis : Erreur");
    } else {
      btn.title = "Vocalis : Retirer la musique de fond (Alt+V)";
      btn.setAttribute("aria-label", "Vocalis : Retirer la musique de fond");
    }
  }

  function showOverlay({ title, subtitle, pct = null, error = false }) {
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
          <button class="vocalis-close" type="button">Annuler — garder le son original</button>
          <p class="vocalis-note"></p>
        </div>`;
      (document.querySelector(".html5-video-player") || document.body).appendChild(overlay);
      overlay.querySelector(".vocalis-close").addEventListener("click", cancelVocalis);
    }

    overlay.querySelector(".vocalis-card").classList.toggle("error", error);
    overlay.querySelector(".vocalis-title").textContent = title;
    overlay.querySelector(".vocalis-subtitle").textContent = subtitle || "";
    overlay.querySelector(".vocalis-close").textContent = error
      ? "Fermer et garder le son original"
      : "Annuler — garder le son original";
    overlay.querySelector(".vocalis-note").textContent = error
      ? "La vidéo reste lisible avec son son d'origine."
      : "Vocalis — tout se traite sur ton PC, rien ne part en ligne.";

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
    if (state.stallTimer) { clearInterval(state.stallTimer); state.stallTimer = null; }
    const engine = state.engine;
    state.engine = null;
    engine?.destroy();
    hideOverlay();
    hideBufferBar();
    state.status = { phase: null, pct: null, notice: null };
    updatePlayerButton();
    if (purge && state.currentVideoId) {
      await VocalisIDB.deleteVideo(state.currentVideoId).catch(() => {});
    }
    state.currentVideoId = null;
  }

  async function startPipeline() {
    logLine("activation demandée");
    const video = getVideoElement();
    if (!video) {
      logLine("ERREUR : aucun <video> trouvé dans la page");
      showOverlay({
        title: "Lecteur vidéo introuvable.",
        subtitle: "Recharge la page YouTube (F5) puis reclique sur Vocalis.",
        error: true,
      });
      return;
    }
    logLine("vidéo trouvée, démarrage du pipeline");

    const engine = new VocalisEngine(video, {
      onPhase: (name, pct, info) => {
        state.status.phase = name;
        state.status.pct = pct;
        updatePlayerButton();
        if (name === "download" && pct != null && info?.seconds != null) {
          if (pct % 20 === 0) logLine("réception audio : " + pct + " % (" + Math.round(info.seconds) + " s)");
        } else if (name === "model" && pct != null && !info?.cached) {
          if (pct % 25 === 0) logLine("téléchargement modèle : " + pct + " %");
        }
        if (!state.enabled) return;
        if (name === "response") {
          showOverlay({ title: "Lecture du lecteur YouTube…", pct: null });
        } else if (name === "download") {
          showOverlay({
            title: "Réception de l'audio…",
            subtitle:
              pct != null
                ? info?.seconds != null
                  ? `${pct} % — ${Math.round(info.seconds)} s de vidéo reçues, la lecture démarre vite`
                  : `${pct} %` + (info?.received ? ` — ${MB(info.received)} / ${MB(info.total)}` : "")
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
            subtitle: info?.cached
              ? ""
              : info?.received
                ? `${pct ?? 0} % — ${MB(info.received)} / ${MB(info.total)} (en parallèle de l'audio)`
                : `${pct ?? 0} % — ensuite tout reste sur ton PC`,
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
      onLog: (msg) => { logLine(msg); },
      onProcessed: (ranges, duration) => {
        updateBufferBar(ranges, duration);
      },
      onStall: (pct) => {
        state.status.phase = "stall";
        updatePlayerButton();
        showOverlay({
          title: "Traitement de cette zone…",
          subtitle: `Vidéo traitée à ${pct} % — un instant.`,
          pct: null,
        });
      },
      onStallClear: () => {
        if (state.status.phase === "stall") {
          state.status.phase = null;
          updatePlayerButton();
          hideOverlay();
        }
      },
      onError: (msg) => {
        state.status.notice = msg;
        updatePlayerButton();
        if (state.stallTimer) {
          clearInterval(state.stallTimer);
          state.stallTimer = null;
        }
        if (state.enabled) {
          showOverlay({ title: msg, subtitle: "", error: true, closable: true, pct: null });
        }
      },
      onNotice: (msg) => {
        state.status.notice = msg;
        updatePlayerButton();
      },
      onReady: (duration) => {
        state.currentVideoId = engine.videoId;
        hideOverlay();
        updateBufferBar(engine.ranges(), duration);
        updatePlayerButton();
        if (state.enabled) {
          engine.initAudioContext();
          engine.activate();
          if (state.pausedByUs) {
            const v = getVideoElement();
            if (v && v.paused) {
              v.play().catch(() => {});
            }
          }
        }
      },
    });

    state.engine = engine;
    // Déverrouille immédiatement l'AudioContext lors du clic utilisateur
    engine.initAudioContext();

    /* Garde-fou : si la phase reste figée 45 s, on l'affiche au lieu de
       laisser un chargement infini silencieux. */
    let lastSig = "", lastChange = Date.now();
    state.stallTimer && clearInterval(state.stallTimer);
    state.stallTimer = setInterval(() => {
      const eng = state.engine;
      if (!state.enabled || !eng) { clearInterval(state.stallTimer); state.stallTimer = null; return; }
      if (eng.started) { clearInterval(state.stallTimer); state.stallTimer = null; return; }
      const sig = state.status.phase + "|" + state.status.pct;
      if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); return; }
      if (Date.now() - lastChange > 45000) {
        clearInterval(state.stallTimer); state.stallTimer = null;
        const etape = state.status.phase || "?";
        logLine("BLOCAGE : aucun progrès depuis 45 s à l'étape « " + etape + " »");
        showOverlay({
          title: "Pipeline bloqué à l'étape « " + etape + " ».",
          subtitle:
            "Ouvre le popup Vocalis et envoie le bloc debug affiché : " +
            "tout y est journalisé, on saura quoi corriger.",
          error: true,
          closable: true,
          pct: null,
        });
      }
    }, 5000);

    try {
      await engine.start();
    } catch (e) {
      logLine("ERREUR pipeline : " + (e?.message || e));
      if (state.enabled) {
        showOverlay({
          title: "Échec du pipeline : " + (e?.message || e),
          subtitle: "Ouvre le popup Vocalis et envoie le bloc debug.",
          error: true,
          closable: true,
          pct: null,
        });
      }
    }
  }

  function setEnabled(enabled) {
    // Après un « Actualiser » de l'extension dans chrome://extensions, les
    // onglets ouverts gardent l'ANCIEN script dont le worker est mort :
    // on le détecte et on demande un F5 au lieu de pendouiller en silence.
    let ctxOk = true;
    try { ctxOk = !!chrome.runtime.id; } catch { ctxOk = false; }
    if (!ctxOk || !enabled) {
      if (!ctxOk) {
        showOverlay({
          title: "Vocalis a été mis à jour.",
          subtitle: "Recharge cette page YouTube (F5) puis reclique sur Vocalis.",
          error: true,
        });
        return;
      }
    }
    state.enabled = enabled;
    chrome.runtime.sendMessage({ type: "vocalis:badge", on: enabled }).catch(() => {});
    chrome.runtime.sendMessage({ type: "vocalis:set-tab-enabled", enabled }).catch(() => {});
    updatePlayerButton();
    const video = getVideoElement();

    if (!enabled) {
      // On garde le cache (réactivation instantanée) ; il sera purgé
      // quand on quittera la vidéo.
      state.engine?.deactivate();
      hideOverlay();
      hideBufferBar();
      if (video) {
        video.muted = false;
        if (state.pausedByUs && video.paused) video.play().catch(() => {});
      }
      state.pausedByUs = false;
      return;
    }

    // SILENCE + PAUSE immédiats : plus de son original qui tourne pendant le
    // chargement, et l'utilisateur garde la main (overlay non bloquant).
    if (video) {
      state.pausedByUs = !video.paused;
      video.pause();
      video.muted = true;
    }

    if (state.engine?.started) {
      updateBufferBar(state.engine.ranges(), state.engine.duration);
      state.engine.activate();
      if (state.pausedByUs && video) video.play().catch(() => {});
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
        running: !!state.engine?.running,
        phase: state.status.phase,
        pct: state.status.pct,
        notice: state.status.notice,
        videoId: state.currentVideoId,
        processedPct: state.engine?.status().processedPct ?? null,
        via: state.engine?.status().via ?? null,
        mode: state.engine?.status().mode ?? null,
        journal: state.journal.slice(-14),
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

  // Raccourci clavier Alt+V pour basculer Vocalis directement depuis YouTube
  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "v" || e.key === "V")) {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      e.preventDefault();
      setEnabled(!state.enabled);
    }
  });

  // Insertion et surveillance continue du bouton dans la barre de contrôle YouTube
  insertPlayerButton();
  setInterval(insertPlayerButton, 800);
  window.addEventListener("yt-navigate-finish", insertPlayerButton);
  window.addEventListener("yt-player-updated", insertPlayerButton);

  try {
    const obs = new MutationObserver(() => {
      if (!document.getElementById("vocalis-player-btn")) {
        insertPlayerButton();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  } catch {}
})();
