/**
 * Vocalis — accès Innertube (API player de YouTube)
 *
 * Le lecteur web reçoit des URLs chiffrées, mais d'autres « clients » YouTube
 * (TV, Android) reçoivent souvent des URLs en clair. On rejoue donc la requête
 * player de l'API publique youtubei avec ces profils — exactement ce que font
 * les outils de téléchargement sérieux. Aucun compte, aucun token : l'API key
 * est publique (elle est dans la page).
 */

self.VocalisInnertube = (() => {
  "use strict";

  /* Clients alignés sur l'état de l'art 2026 (yt-dlp) : android_vr et
     android « sdkless » ne demandent ni PO-token ni déchiffrement JS et
     renvoient des URLs en clair ; les autres sont des filets de sécurité. */
  const CLIENTS = [
    {
      clientName: "ANDROID_VR",
      clientVersion: "1.61",
      androidSdkVersion: 32,
      userAgent: "com.google.android.youtube.tvvr/1.61 (Linux; U; Android 12L) gzip",
    },
    {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      // pas d'androidSdkVersion volontairement (« sdkless »)
      userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
    },
    {
      clientName: "IOS",
      clientVersion: "19.09.37",
      deviceModel: "iPhone14,3",
      userAgent:
        "com.google.ios.youtube/19.09.37 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)",
    },
    {
      clientName: "TVHTML5",
      clientVersion: "7.20250630.19.00",
      userAgent:
        "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version YouTubeTV/7.20250630.19.00",
    },
  ];

  /**
   * Demande le playerResponse via youtubei/v1/player pour plusieurs clients.
   * Retourne { formats, client } avec des formats audio ayant une `url` en
   * clair, ou null. `onLog` (optionnel) journalise chaque tentative.
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

        const resp = await fetch(
          "https://www.youtube.com/youtubei/v1/player?key=" +
            encodeURIComponent(apiKey) +
            "&prettyPrint=false",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(6000), // une requête qui traîne = client suivant
            body: JSON.stringify({
              videoId,
              context: { client },
              playbackContext: {
                contentPlaybackContext: { vis: 0, splay: false, autoQuality: true },
              },
            }),
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
          return { formats, client: c.clientName };
        }
        log("innertube " + c.clientName + " : " + audioAll.length +
            " formats audio mais aucun avec URL (DRM/SABR/chiffré)");
      } catch (e) {
        log("innertube " + c.clientName + " : échec (" + (e?.message || e) + ")");
      }
    }
    return null;
  }

  return { query };
})();
