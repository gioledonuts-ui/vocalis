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
        <div class="vocalis-card">
          <div class="vocalis-brand">
            <div class="vocalis-brand-left">
              <div class="vocalis-badge-icon">
                <svg viewBox="0 0 36 36" width="22" height="22" fill="none">
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
              <div class="vocalis-brand-titles">
                <span class="vocalis-brand-name">Vocalis</span>
                <span class="vocalis-brand-tag">YouTube sans musique de fond</span>
              </div>
            </div>
            <div class="vocalis-equalizer">
              <span></span><span></span><span></span><span></span><span></span>
            </div>
          </div>

          <div class="vocalis-stepper">
            <div class="vocalis-step pending" id="voc-step-audio">
              <div class="vocalis-step-icon">1</div>
              <div class="vocalis-step-body">
                <div class="vocalis-step-title">1. Flux audio YouTube</div>
                <div class="vocalis-step-sub" id="voc-step-audio-sub">Connexion au flux audio…</div>
              </div>
            </div>
            <div class="vocalis-step pending" id="voc-step-model">
              <div class="vocalis-step-icon">2</div>
              <div class="vocalis-step-body">
                <div class="vocalis-step-title">2. Moteur IA (Demucs v4)</div>
                <div class="vocalis-step-sub" id="voc-step-model-sub">Chargement du modèle…</div>
              </div>
            </div>
            <div class="vocalis-step pending" id="voc-step-prep">
              <div class="vocalis-step-icon">3</div>
              <div class="vocalis-step-body">
                <div class="vocalis-step-title">3. Isolation vocale</div>
                <div class="vocalis-step-sub" id="voc-step-prep-sub">Pré-chargement des premières secondes…</div>
              </div>
            </div>
          </div>

          <div class="vocalis-progress-bar">
            <div class="vocalis-progress-fill indeterminate" id="voc-progress-fill"></div>
          </div>

          <div class="vocalis-footer">
            <button class="vocalis-close" id="voc-close-btn" type="button">Annuler — son d'origine</button>
            <div class="vocalis-tech-badge">⚡ 100% Local (RTX/WebGPU)</div>
          </div>
        </div>`;
      (document.querySelector(".html5-video-player") || document.body).appendChild(overlay);
      overlay.querySelector("#voc-close-btn").addEventListener("click", cancelVocalis);
    }
    return overlay;
  }

  function updateOverlayState({ name, pct = null, info = null, error = null }) {
    if (!state.enabled && !error) {
      hideOverlay();
      return;
    }
    const overlay = renderOverlayDOM();
    const card = overlay.querySelector(".vocalis-card");
    const stepAudio = document.getElementById("voc-step-audio");
    const stepModel = document.getElementById("voc-step-model");
    const stepPrep = document.getElementById("voc-step-prep");
    const subAudio = document.getElementById("voc-step-audio-sub");
    const subModel = document.getElementById("voc-step-model-sub");
    const subPrep = document.getElementById("voc-step-prep-sub");
    const fill = document.getElementById("voc-progress-fill");
    const closeBtn = document.getElementById("voc-close-btn");

    if (error) {
      card.classList.add("error");
      if (subAudio) subAudio.textContent = "Erreur de traitement";
      if (subModel) subModel.textContent = error;
      if (fill) { fill.classList.remove("indeterminate"); fill.style.width = "0%"; }
      if (closeBtn) closeBtn.textContent = "Fermer et garder le son original";
      return;
    }
    card.classList.remove("error");
    if (closeBtn) closeBtn.textContent = "Annuler — garder le son original";

    function setStep(el, subEl, iconEl, status, subText, defaultNum) {
      if (!el) return;
      el.className = `vocalis-step ${status}`;
      if (subEl) subEl.textContent = subText;
      if (iconEl) iconEl.textContent = status === "done" ? "✓" : status === "active" ? "" : defaultNum;
    }

    const iconAudio = stepAudio?.querySelector(".vocalis-step-icon");
    const iconModel = stepModel?.querySelector(".vocalis-step-icon");
    const iconPrep = stepPrep?.querySelector(".vocalis-step-icon");

    if (name === "response") {
      setStep(stepAudio, subAudio, iconAudio, "active", "Analyse du lecteur YouTube…", "1");
      setStep(stepModel, subModel, iconModel, "pending", "En attente…", "2");
      setStep(stepPrep, subPrep, iconPrep, "pending", "En attente…", "3");
      fill.classList.add("indeterminate");
      fill.style.width = "";
    } else if (name === "download") {
      const pText = pct != null ? `${pct} %` : "Récupération…";
      const sizeText = info?.received ? ` (${MB(info.received)} / ${MB(info.total)})` : info?.seconds ? ` (${Math.round(info.seconds)} s)` : "";
      setStep(stepAudio, subAudio, iconAudio, "active", `Téléchargement du flux : ${pText}${sizeText}`, "1");
      setStep(stepModel, subModel, iconModel, "active", "Initialisation du modèle en parallèle…", "2");
      setStep(stepPrep, subPrep, iconPrep, "pending", "En attente…", "3");
      if (pct != null) { fill.classList.remove("indeterminate"); fill.style.width = `${pct}%`; }
      else { fill.classList.add("indeterminate"); }
    } else if (name === "decode" || name === "resample") {
      setStep(stepAudio, subAudio, iconAudio, "done", "Flux audio extrait avec succès ✓", "1");
      setStep(stepModel, subModel, iconModel, "active", "Formatage 44,1 kHz & session IA…", "2");
      setStep(stepPrep, subPrep, iconPrep, "pending", "En attente…", "3");
      fill.classList.add("indeterminate");
      fill.style.width = "";
    } else if (name === "model") {
      setStep(stepAudio, subAudio, iconAudio, "done", "Flux audio extrait avec succès ✓", "1");
      if (info?.cached || pct === 100) {
        setStep(stepModel, subModel, iconModel, "done", "Modèle IA prêt (WebGPU RTX) ✓", "2");
      } else {
        setStep(stepModel, subModel, iconModel, "active", `Chargement du modèle : ${pct ?? 0} %`, "2");
      }
      setStep(stepPrep, subPrep, iconPrep, "pending", "En attente…", "3");
      if (pct != null && !info?.cached) { fill.classList.remove("indeterminate"); fill.style.width = `${pct}%`; }
    } else if (name === "prepare") {
      setStep(stepAudio, subAudio, iconAudio, "done", "Flux audio extrait avec succès ✓", "1");
      setStep(stepModel, subModel, iconModel, "done", "Modèle IA prêt (WebGPU RTX) ✓", "2");
      setStep(stepPrep, subPrep, iconPrep, "active", `Pré-chargement : ${pct ?? 0} % (lecture dès 20 s)`, "3");
      fill.classList.remove("indeterminate");
      fill.style.width = `${pct ?? 0}%`;
    } else if (name === "stall") {
      setStep(stepAudio, subAudio, iconAudio, "done", "Flux audio extrait avec succès ✓", "1");
      setStep(stepModel, subModel, iconModel, "done", "Modèle IA prêt (WebGPU RTX) ✓", "2");
      setStep(stepPrep, subPrep, iconPrep, "active", `Traitement de cette zone… (${pct ?? 0} %)`, "3");
      fill.classList.add("indeterminate");
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
