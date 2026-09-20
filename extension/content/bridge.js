/**
 * Vocalis — pont « main world » (s'exécute DANS la page YouTube)
 *
 * Le script de contenu vit dans un monde isolé et ne voit pas les objets
 * JavaScript de YouTube. Ce petit pont, exécuté dans le monde principal
 * (manifest : "world": "MAIN"), expose les données du lecteur via
 * window.postMessage :
 *
 *  - réponse à « get-player-response » : le playerResponse complet
 *    (streamingData, videoDetails…) — c'est là que se trouve l'URL du
 *    flux audio adaptatif ;
 *  - événement « video-changed » quand l'identifiant de vidéo change
 *    (YouTube est une SPA : on change de vidéo sans recharger la page).
 *
 * Note sécurité (acceptable ici) : la page peut théoriquement lire/imiter
 * ces messages. Au pire elle ne casse que notre propre pipeline audio.
 */

(() => {
  "use strict";

  const send = (type, payload) =>
    window.postMessage({ source: "vocalis-bridge", type, payload }, "*");

  function playerResponse() {
    let pr = null;
    try {
      const init = window.ytInitialPlayerResponse;
      if (init && init.videoDetails) {
        const initFormats = init.streamingData?.adaptiveFormats || [];
        const hasSig = initFormats.some(
          (f) => (f.mimeType || "").startsWith("audio/") && (f.signatureCipher || f.cipher || f.url)
        );
        if (hasSig) return init;
        pr = init;
      }
    } catch {}
    try {
      const player = document.getElementById("movie_player");
      if (player && typeof player.getPlayerResponse === "function") {
        const ppr = player.getPlayerResponse();
        if (ppr && ppr.videoDetails) {
          const pprFormats = ppr.streamingData?.adaptiveFormats || [];
          const hasSig = pprFormats.some(
            (f) => (f.mimeType || "").startsWith("audio/") && (f.signatureCipher || f.cipher || f.url)
          );
          if (hasSig) return ppr;
          if (!pr) pr = ppr;
        }
      }
    } catch {}
    try {
      const flexy = document.querySelector("ytd-watch-flexy, ytd-watch-grid");
      if (flexy && flexy.playerData && flexy.playerData.videoDetails) {
        if (!pr) pr = flexy.playerData;
      }
    } catch {}
    return pr;
  }

  /* Requêtes du script de contenu */
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "vocalis-content") return;
    if (d.type === "get-player-response") {
      send("player-response", {
        pr: playerResponse(),
        playerJsUrl: playerJsUrl(),
        apiKey: apiKey(),
      });
    }
  });

  function playerJsUrl() {
    try {
      const js =
        playerResponse()?.assets?.js ||
        (window.ytplayer && window.ytplayer.config && window.ytplayer.config.assets?.js) ||
        (window.yt && window.yt.config_ && window.yt.config_.PLAYER_CONFIG && window.yt.config_.PLAYER_CONFIG.assets?.js);
      if (js) return js.startsWith("http") ? js : "https://www.youtube.com" + js;

      const scripts = Array.from(document.querySelectorAll("script[src]"));
      for (const s of scripts) {
        const src = s.src || "";
        if (src.includes("/s/player/") && (src.includes("base.js") || src.includes("player_ias") || src.includes("desktop_polymer"))) {
          return src;
        }
      }
      for (const s of scripts) {
        const src = s.src || "";
        if (src.includes("/s/player/")) return src;
      }
      return null;
    } catch {
      return null;
    }
  }

  function apiKey() {
    try {
      return (window.ytcfg && window.ytcfg.get && window.ytcfg.get("INNERTUBE_API_KEY")) || null;
    } catch {
      return null;
    }
  }

  /* Détection de changement de vidéo (navigation SPA) */
  let lastVideoId = null;
  function getVideoId() {
    const fromPr = playerResponse()?.videoDetails?.videoId;
    if (fromPr) return fromPr;
    const urlParams = new URLSearchParams(window.location.search);
    const fromUrl = urlParams.get("v");
    if (fromUrl) return fromUrl;
    if (window.location.pathname.startsWith("/shorts/")) {
      return window.location.pathname.split("/")[2] || null;
    }
    return null;
  }

  function checkVideo() {
    const id = getVideoId();
    if (id === lastVideoId) return;
    const from = lastVideoId;
    lastVideoId = id;
    send("video-changed", { from, to: id });
  }

  window.addEventListener("yt-navigate-start", checkVideo);
  window.addEventListener("yt-page-data-updated", checkVideo);
  document.addEventListener("yt-page-data-updated", checkVideo);
  // Filet de sécurité : certains changements ne déclenchent pas d'événement.
  setInterval(checkVideo, 1500);
  checkVideo();
})();
