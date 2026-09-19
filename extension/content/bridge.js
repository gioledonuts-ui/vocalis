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
    const player = document.getElementById("movie_player");
    try {
      return player && typeof player.getPlayerResponse === "function"
        ? player.getPlayerResponse()
        : null;
    } catch {
      return null;
    }
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
        (window.ytplayer && window.ytplayer.config && window.ytplayer.config.assets?.js);
      if (js) return js.startsWith("http") ? js : "https://www.youtube.com" + js;
      // Le playerResponse runtime n'a pas toujours d'assets : on cherche la
      // balise <script> du lecteur chargée par la page elle-même.
      const el = document.querySelector(
        'script[src*="/s/player/"][src$="base.js"], script[src*="/s/player/"][src*="player_ias"]'
      );
      return el ? el.src : null;
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
  function checkVideo() {
    const id = playerResponse()?.videoDetails?.videoId || null;
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
