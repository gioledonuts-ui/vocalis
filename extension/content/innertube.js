/**
 * Vocalis — accès Innertube (API player de YouTube)
 *
 * Le lecteur web reçoit des URLs chiffrées, mais d'autres « clients » YouTube
 * (Apple Vision Pro, Android sdkless, TV) reçoivent des URLs directes sans
 * signature ni PO-token. On rejoue la requête player de l'API publique
 * youtubei avec ces profils — exactement comme yt-dlp.
 */

self.VocalisInnertube = (() => {
  "use strict";

  /* Clients alignés sur l'état de l'art 2026 :
     1. TVHTML5 : client Smart TV (flux direct haute fidélité, sans limite 1 Mo, sans PO-token).
     2. IOS : client avec clé iOS dédiée.
     3. MEDIA_CONNECT_FRONTEND & WEB_EMBEDDED_PLAYER : flux directs sans restriction.
     4. ANDROID : repli mobile. */
  const CLIENTS = [
    {
      clientName: "TVHTML5",
      clientVersion: "7.20250120.19.00",
      userAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
    },
    {
      clientName: "IOS",
      clientVersion: "17.33.2",
      deviceModel: "iPhone14,3",
      userAgent:
        "com.google.ios.youtube/17.33.2 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)",
      apiKey: "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc",
    },
    {
      clientName: "MEDIA_CONNECT_FRONTEND",
      clientVersion: "0.1",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    {
      clientName: "WEB_EMBEDDED_PLAYER",
      clientVersion: "1.20241202.00.00",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
    },
  ];

  /**
   * Demande le playerResponse via youtubei/v1/player pour plusieurs clients.
   * Retourne { formats, client, userAgent } avec des formats audio ayant une
   * `url` en clair, ou null. `onLog` (optionnel) journalise chaque tentative.
   */
  async function query(videoId, apiKey, onLog) {
    const log = (m) => onLog && onLog(m);
    for (const c of CLIENTS) {
      try {
        const client = {
          clientName: c.clientName,
          clientVersion: c.clientVersion,
          hl: "en",
          gl: "US",
          userAgent: c.userAgent,
        };
        if (c.androidSdkVersion) client.androidSdkVersion = c.androidSdkVersion;
        if (c.deviceModel) client.deviceModel = c.deviceModel;
        if (c.deviceMake) client.deviceMake = c.deviceMake;
        if (c.osName) client.osName = c.osName;
        if (c.osVersion) client.osVersion = c.osVersion;

        const effectiveKey = c.apiKey || apiKey;
        const bodyObj = {
          videoId,
          context: { client },
        };
        if (c.clientName === "IOS") {
          bodyObj.playbackContext = {
            contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" },
          };
          bodyObj.contentCheckOk = true;
          bodyObj.racyCheckOk = true;
        } else {
          bodyObj.playbackContext = {
            contentPlaybackContext: { vis: 0, splay: false, autoQuality: true },
          };
        }

        const resp = await fetch(
          "https://www.youtube.com/youtubei/v1/player?key=" +
            encodeURIComponent(effectiveKey) +
            "&prettyPrint=false",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(6000), // une requête qui traîne = client suivant
            body: JSON.stringify(bodyObj),
          }
        );
        if (!resp.ok) { log("innertube " + c.clientName + " : HTTP " + resp.status); continue; }
        // json() borné : une réponse qui s'éternise ne doit pas tout bloquer.
        const j = await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("timeout json")), 8000);
          resp.json().then((v) => { clearTimeout(t); resolve(v); },
                           (e) => { clearTimeout(t); reject(e); });
        });
        if (j?.playabilityStatus?.status !== "OK") {
          log("innertube " + c.clientName + " : refusé (" +
              (j?.playabilityStatus?.status || "réponse vide") + ")");
          continue;
        }
        const all = j?.streamingData?.adaptiveFormats || [];
        const audioAll = all.filter((f) => (f.mimeType || "").startsWith("audio/"));
        const formats = audioAll.filter((f) => f.url);
        if (formats.length) {
          log("innertube " + c.clientName + " : OK, " + formats.length + " formats audio");
          return { formats, client: c.clientName, userAgent: c.userAgent };
        }
        log("innertube " + c.clientName + " : " + audioAll.length +
            " formats audio mais aucun avec URL (DRM/SABR/chiffré)");
      } catch (e) {
        log("innertube " + c.clientName + " : échec (" + (e?.message || e) + ")");
      }
    }
    return null;
  }

  /**
   * Interroge l'API Innertube avec le profil WEB (PC standard).
   * Retourne { formats } contenant les formats adaptatifs signés (signatureCipher)
   * sans aucune bride de téléchargement ni limitation mobile.
   */
  async function queryWeb(videoId, apiKey, onLog) {
    const log = (m) => onLog && onLog(m);
    try {
      const effectiveKey = apiKey || "AIzaSyAO_FJ2SlqU8Q4STEHLNlTpqUcavnZbsC8";
      const resp = await fetch(
        "https://www.youtube.com/youtubei/v1/player?key=" +
          encodeURIComponent(effectiveKey) +
          "&prettyPrint=false",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            videoId,
            context: {
              client: {
                clientName: "WEB",
                clientVersion: "2.20240920.01.00",
                hl: "fr",
                gl: "FR",
              },
            },
            playbackContext: {
              contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" },
            },
          }),
        }
      );
      if (!resp.ok) {
        log("Innertube WEB : HTTP " + resp.status);
        return null;
      }
      const j = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout json")), 8000);
        resp.json().then((v) => { clearTimeout(t); resolve(v); },
                         (e) => { clearTimeout(t); reject(e); });
      });
      if (j?.playabilityStatus?.status !== "OK") {
        log("Innertube WEB : statut " + (j?.playabilityStatus?.status || "réponse vide"));
        return null;
      }
      const all = j?.streamingData?.adaptiveFormats || [];
      const audioAll = all.filter((f) => (f.mimeType || "").startsWith("audio/"));
      const directCount = audioAll.filter((f) => f.url).length;
      const cipherCount = audioAll.filter((f) => f.signatureCipher || f.cipher).length;
      log("Innertube WEB : " + audioAll.length + " formats audio (directs=" + directCount + ", signés=" + cipherCount + ")");
      return { formats: audioAll };
    } catch (e) {
      log("Innertube WEB : échec (" + (e?.message || e) + ")");
      return null;
    }
  }

  return { query, queryWeb };
})();
