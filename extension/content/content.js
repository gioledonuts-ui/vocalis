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
        <svg height="100%" version="1.1" viewBox="0 0 36 36" width="100%" style="pointer-events:none;width:24px!important;height:24px!important;" fill="none">
          <rect x="6.5" y="8" width="3.2" height="15" rx="1.6" fill="currentColor"/>
          <rect x="11.8" y="12" width="3.2" height="14" rx="1.6" fill="currentColor"/>
          <rect x="17.1" y="16" width="3.2" height="13" rx="1.6" fill="currentColor"/>
          <rect x="22.4" y="12" width="3.2" height="14" rx="1.6" fill="currentColor"/>
          <rect x="27.7" y="8" width="3.2" height="15" rx="1.6" fill="currentColor"/>
        </svg>
      `;

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setEnabled(!state.enabled);
      });

      btn.addEventListener("mouseenter", () => {
        btn.style.opacity = "1";
        btn.style.transform = "scale(1.08)";
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

    const isActive = state.enabled && !!state.engine?.active;
    const isPreparing = state.enabled && !state.engine?.active && !state.status.notice;
    const isError = state.enabled && !!state.status.notice && !state.engine?.started;

    btn.classList.toggle("active", isActive);
    btn.classList.toggle("loading", isPreparing);
    btn.classList.toggle("error", isError);

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

  function renderOverlayDOM() {
    let overlay = document.getElementById("vocalis-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "vocalis-overlay";
      overlay.innerHTML = `
        <div class="vocalis-card" id="voc-card">
          <div class="vocalis-card-header">
            <div class="vocalis-brand">
              <div class="vocalis-logo-icon">
                <svg viewBox="0 0 36 36" width="20" height="20" fill="none">
                  <defs>
                    <linearGradient id="vocOvGrad" x1="6" y1="18" x2="30" y2="18" gradientUnits="userSpaceOnUse">
                      <stop offset="0%" stop-color="#38bdf8"/>
                      <stop offset="50%" stop-color="#818cf8"/>
                      <stop offset="100%" stop-color="#c084fc"/>
                    </linearGradient>
                  </defs>
                  <rect x="6.5" y="8" width="3.2" height="15" rx="1.6" fill="url(#vocOvGrad)"/>
                  <rect x="11.8" y="12" width="3.2" height="14" rx="1.6" fill="url(#vocOvGrad)"/>
                  <rect x="17.1" y="16" width="3.2" height="13" rx="1.6" fill="url(#vocOvGrad)"/>
                  <rect x="22.4" y="12" width="3.2" height="14" rx="1.6" fill="url(#vocOvGrad)"/>
                  <rect x="27.7" y="8" width="3.2" height="15" rx="1.6" fill="url(#vocOvGrad)"/>
                </svg>
              </div>
              <div class="vocalis-brand-text">
                <span class="vocalis-brand-name">Vocalis</span>
                <span class="vocalis-brand-tag">Séparation vocale locale</span>
              </div>
            </div>
            <div class="vocalis-card-header-right">
              <div class="vocalis-status-pill" id="voc-status-pill">
                <span class="vocalis-status-dot"></span>
                <span class="vocalis-status-pill-text" id="voc-status-pill-text">WebGPU</span>
              </div>
              <button class="vocalis-close-icon-btn" id="voc-close-icon-btn" type="button" aria-label="Annuler et fermer" title="Annuler et fermer">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M4 4l8 8M12 4l-8 8"/>
                </svg>
              </button>
            </div>
          </div>

          <div class="vocalis-card-body">
            <div class="vocalis-phase-title" id="voc-phase-title">Connexion au flux audio…</div>
            <div class="vocalis-phase-subtitle" id="voc-phase-sub">Analyse du lecteur YouTube</div>
          </div>

          <div class="vocalis-gauge-section">
            <div class="vocalis-progress-bar">
              <div class="vocalis-progress-fill indeterminate" id="voc-progress-fill"></div>
            </div>
            <div class="vocalis-metrics">
              <span class="vocalis-step-indicator" id="voc-step-ind">Étape 1/3 • Flux audio</span>
              <span class="vocalis-pct-text" id="voc-pct-text">Connexion</span>
            </div>
          </div>

          <div class="vocalis-card-footer">
            <button class="vocalis-cancel-btn" id="voc-close-btn" type="button">
              Annuler — garder le son original
            </button>
          </div>
        </div>`;
      (document.querySelector(".html5-video-player") || document.body).appendChild(overlay);
      overlay.querySelector("#voc-close-btn")?.addEventListener("click", cancelVocalis);
      overlay.querySelector("#voc-close-icon-btn")?.addEventListener("click", cancelVocalis);
    }
    return overlay;
  }

  function updateOverlayState(opts = {}) {
    const { name = null, pct = null, info = null, error = null, title = null, subtitle = null } = opts;
    const isError = !!error || !!opts.error;
    if (!state.enabled && !isError) {
      hideOverlay();
      return;
    }
    const overlay = renderOverlayDOM();
    const card = overlay.querySelector(".vocalis-card");
    const phaseTitle = document.getElementById("voc-phase-title");
    const phaseSub = document.getElementById("voc-phase-sub");
    const stepInd = document.getElementById("voc-step-ind");
    const pctText = document.getElementById("voc-pct-text");
    const fill = document.getElementById("voc-progress-fill");
    const statusPill = document.getElementById("voc-status-pill");
    const statusPillText = document.getElementById("voc-status-pill-text");
    const closeBtn = document.getElementById("voc-close-btn");

    if (isError) {
      card?.classList.add("error");
      statusPill?.classList.add("error");
      if (statusPillText) statusPillText.textContent = "Erreur";
      if (phaseTitle) phaseTitle.textContent = title || "Traitement interrompu";
      if (phaseSub) phaseSub.textContent = (typeof error === "string" ? error : subtitle) || "Impossible d'isoler les voix.";
      if (stepInd) stepInd.textContent = "Échec du traitement";
      if (pctText) pctText.textContent = "—";
      if (fill) {
        fill.classList.remove("indeterminate");
        fill.style.width = "0%";
      }
      if (closeBtn) closeBtn.textContent = "Fermer — garder le son original";
      return;
    }

    card?.classList.remove("error");
    statusPill?.classList.remove("error");
    if (statusPillText) statusPillText.textContent = "WebGPU";
    if (closeBtn) closeBtn.textContent = "Annuler — garder le son original";

    if (name === "response") {
      if (phaseTitle) phaseTitle.textContent = "Connexion au flux audio…";
      if (phaseSub) phaseSub.textContent = "Analyse du lecteur YouTube et des pistes disponibles";
      if (stepInd) stepInd.textContent = "Étape 1/3 • Flux audio";
      if (pctText) pctText.textContent = "Connexion";
      if (fill) {
        fill.classList.add("indeterminate");
        fill.style.width = "";
      }
    } else if (name === "download") {
      const p = pct != null ? `${pct} %` : "En cours";
      const detail = info?.seconds
        ? `${Math.round(info.seconds)} s reçues`
        : info?.received
          ? `${MB(info.received)} / ${MB(info.total)}`
          : "Extraction des données audio…";
      if (phaseTitle) phaseTitle.textContent = "Récupération du flux audio…";
      if (phaseSub) phaseSub.textContent = detail;
      if (stepInd) stepInd.textContent = "Étape 1/3 • Flux audio";
      if (pctText) pctText.textContent = p;
      if (fill) {
        if (pct != null) {
          fill.classList.remove("indeterminate");
          fill.style.width = `${pct}%`;
        } else {
          fill.classList.add("indeterminate");
          fill.style.width = "";
        }
      }
    } else if (name === "decode" || name === "resample") {
      if (phaseTitle) phaseTitle.textContent = "Préparation du signal audio…";
      if (phaseSub) phaseSub.textContent = "Formatage stéréo 44,1 kHz & alignement Demucs v4";
      if (stepInd) stepInd.textContent = "Étape 2/3 • Décodage";
      if (pctText) pctText.textContent = "Formatage";
      if (fill) {
        fill.classList.add("indeterminate");
        fill.style.width = "";
      }
    } else if (name === "model") {
      const isReady = info?.cached || pct === 100;
      if (phaseTitle) phaseTitle.textContent = isReady ? "Moteur IA prêt" : "Chargement du modèle Demucs…";
      if (phaseSub) phaseSub.textContent = isReady
        ? "Modèle Demucs v4 actif en mémoire GPU (WebGPU)"
        : `Initialisation des poids neuronaux (${pct ?? 0} %)`;
      if (stepInd) stepInd.textContent = "Étape 2/3 • Modèle IA";
      if (pctText) pctText.textContent = isReady ? "100 %" : `${pct ?? 0} %`;
      if (fill) {
        if (isReady) {
          fill.classList.remove("indeterminate");
          fill.style.width = "100%";
        } else if (pct != null && !info?.cached) {
          fill.classList.remove("indeterminate");
          fill.style.width = `${pct}%`;
        } else {
          fill.classList.add("indeterminate");
          fill.style.width = "";
        }
      }
    } else if (name === "prepare") {
      const p = Math.min(100, Math.max(0, pct ?? 0));
      if (phaseTitle) phaseTitle.textContent = "Isolation des voix en cours…";
      if (phaseSub) phaseSub.textContent = `Séparation Demucs v4 • Tampon d'écoute ${p} %`;
      if (stepInd) stepInd.textContent = "Étape 3/3 • Isolation vocale";
      if (pctText) pctText.textContent = `${p} %`;
      if (fill) {
        fill.classList.remove("indeterminate");
        fill.style.width = `${p}%`;
      }
    } else if (name === "stall") {
      const p = pct != null ? `${pct} %` : "Calcul";
      if (phaseTitle) phaseTitle.textContent = "Séparation vocale en continu…";
      if (phaseSub) phaseSub.textContent = "Traitement du segment audio suivant sur votre GPU";
      if (stepInd) stepInd.textContent = "Traitement actif";
      if (pctText) pctText.textContent = p;
      if (fill) {
        if (pct != null) {
          fill.classList.remove("indeterminate");
          fill.style.width = `${pct}%`;
        } else {
          fill.classList.add("indeterminate");
          fill.style.width = "";
        }
      }
    }
  }

  function showOverlay(opts) {
    updateOverlayState(opts);
  }

  function hideOverlay() {
    const o = document.getElementById("vocalis-overlay");
    if (!o) return;
    o.classList.add("fade-out");
    setTimeout(() => o.remove(), 250);
  }

  /* ------------------------------------------------------------------ */
  /* Barre « son traité » (Buffer bar interactive)                      */
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
      bar.title = "Vocalis : son sans musique prêt";
      anchor.parentElement.appendChild(bar);

      // Tooltip au survol de la barre de buffer
      let tip = null;
      bar.addEventListener("mouseenter", () => {
        tip = document.createElement("div");
        tip.id = "vocalis-bufferbar-tooltip";
        document.body.appendChild(tip);
      });
      bar.addEventListener("mousemove", (e) => {
        if (!tip) return;
        const rect = bar.getBoundingClientRect();
        const processedSec = ranges.reduce((acc, [s, e]) => acc + (e - s), 0);
        const pctTotal = Math.round((processedSec / duration) * 100);
        tip.textContent = `🎙️ Vocalis : ${pctTotal} % traité (${Math.round(processedSec)} s sans musique)`;
        tip.style.left = e.clientX + "px";
        tip.style.top = (rect.top - 36) + "px";
      });
      bar.addEventListener("mouseleave", () => {
        tip?.remove();
        tip = null;
      });
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
        updateOverlayState({ name, pct, info });
      },
      onLog: (msg) => { logLine(msg); },
      onProcessed: (ranges, duration) => {
        updateBufferBar(ranges, duration);
      },
      onStall: (pct) => {
        state.status.phase = "stall";
        updatePlayerButton();
        updateOverlayState({ name: "stall", pct });
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
          updateOverlayState({ error: msg });
        }
      },
      onNotice: (msg) => {
        state.status.notice = msg;
        updatePlayerButton();
      },
      onReady: async (duration) => {
        state.currentVideoId = engine.videoId;
        hideOverlay();
        updateBufferBar(engine.ranges(), duration);
        updatePlayerButton();
        if (state.enabled) {
          engine.initAudioContext();
          if (state.pausedByUs) {
            const v = getVideoElement();
            if (v && v.paused) {
              v.play().catch(() => {});
            }
          }
          await engine.activate();
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
        updateOverlayState({
          error: "Pipeline ralenti à l'étape « " + etape + " ». Ouvre le popup Vocalis pour voir le journal.",
        });
      }
    }, 5000);

    try {
      await engine.start();
    } catch (e) {
      logLine("ERREUR pipeline : " + (e?.message || e));
      if (state.enabled) {
        updateOverlayState({
          error: "Échec du pipeline : " + (e?.message || e),
        });
      }
    }
  }

  async function setEnabled(enabled) {
    // Après un « Actualiser » de l'extension dans chrome://extensions, les
    // onglets ouverts gardent l'ANCIEN script dont le worker est mort :
    // on le détecte et on demande un F5 au lieu de pendouiller en silence.
    let ctxOk = true;
    try { ctxOk = !!chrome.runtime.id; } catch { ctxOk = false; }
    if (!ctxOk || !enabled) {
      if (!ctxOk) {
        updateOverlayState({
          error: "Vocalis a été mis à jour. Recharge cette page YouTube (F5) puis reclique sur Vocalis.",
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
        try {
          const p = document.getElementById("movie_player");
          if (p && typeof p.unMute === "function") p.unMute();
        } catch {}
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
      await state.engine.activate();
      if (state.pausedByUs && video) {
        video.play().catch(() => {});
        state.pausedByUs = false;
      }
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
        backend: state.engine?.status().backend ?? null,
        gpuName: state.engine?.status().gpuName ?? null,
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
