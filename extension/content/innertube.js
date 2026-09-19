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

  const CLIENTS = [
    {
      clientName: "TVHTML5",
      clientVersion: "7.20250120.19.00",
      userAgent:
        "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version YouTubeTV/7.20250120.19.00",
    },
    {
      clientName: "ANDROID",
      clientVersion: "19.09.37",
      androidSdkVersion: 33,
      userAgent: "com.google.android.youtube/19.09.37 (Linux; U; Android 13) gzip",
    },
  ];

  /**
   * Demande le playerResponse via youtubei/v1/player pour plusieurs clients.
   * Retourne { formats, client } avec des formats audio ayant une `url` en
   * clair, ou null.
   */
  async function query(videoId, apiKey) {
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

        const resp = await fetch(
          "https://www.youtube.com/youtubei/v1/player?key=" +
            encodeURIComponent(apiKey) +
            "&prettyPrint=false",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              videoId,
              context: { client },
              playbackContext: {
                contentPlaybackContext: { vis: 0, splay: false, autoQuality: true },
              },
            }),
          }
        );
        if (!resp.ok) continue;
        const j = await resp.json();
        if (j?.playabilityStatus?.status !== "OK") continue;
        const formats = (j?.streamingData?.adaptiveFormats || []).filter(
          (f) => f.url && (f.mimeType || "").startsWith("audio/")
        );
        if (formats.length) return { formats, client: c.clientName };
      } catch {
        /* client suivant */
      }
    }
    return null;
  }

  return { query };
})();
