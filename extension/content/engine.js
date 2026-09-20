/**
 * Vocalis — moteur audio v0.4
 *
 * Deux chemins pour obtenir les voix, sans musique :
 *
 *  A) INCRÉMENTAL (par défaut, flux m4a/AAC) : téléchargement par tranches
 *     de 4 Mo, démultiplexage mp4box.js, décodage WebCodecs au fil de l'eau,
 *     segments de 30 s envoyés au worker IA dès qu'ils existent. La lecture
 *     démarre après ~30 s de voix prêtes ; le reste suit en arrière-plan ;
 *     le téléchargement est borné pour ne pas ralentir la vidéo YouTube.
 *
 *  B) LEGACY (filet de sécurité) : téléchargement + décodage complet puis
 *     traitement, comme en v0.3. Utilisé si WebCodecs/mp4box/AAC manquent.
 *
 * Commun aux deux chemins : worker IA (HTDemucs ONNX WebGPU/WASM), cache
 * IndexedDB (retour arrière instantané, purge en quittant la vidéo),
 * relecture Web Audio synchronisée sur video.currentTime, barre
 * « son traité », écrans de chargement/traitement.
 */

self.VocalisEngine = (() => {
  "use strict";

  const CHUNK = 10;                 // durée d'un bloc traité (s)
  const SR = 44100;                 // fréquence du modèle / de l'itag 140
  const PRELOAD_S = 10;             // secondes de voix prêtes avant lecture
  const SCHEDULE_AHEAD = 90;        // secondes d'audio programmées d'avance
  const MEM_WINDOW = 60;            // blocs gardés en RAM (~30 min)
  const CACHE_CAP = 1_500_000_000;  // plafond IndexedDB par vidéo (~1,5 Go)
  const DRIFT_MAX = 0.40;           // écart audio/vidéo toléré (s) (400 ms)

  /** Borne n'importe quelle promesse : jamais d'attente infinie. */
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("délai dépassé : " + label)), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  class Engine {
    constructor(video, hooks = {}) {
      this.video = video;
      this.hooks = hooks;

      this.aborted = false;
      this.running = false;
      this.started = false;
      this.active = false;
      this.stalled = false;
      this.fatal = false;
      this.rateNoticeShown = false;
      this.mode = null;             // "incr" | "legacy"

      this.videoId = null;
      this.duration = 0;
      this.nChunks = 0;
      this.via = null;

      this.audio44 = null;          // masters (legacy uniquement)
      this.mem = new Map();         // index -> Int16Array (voix PCM16)
      this.buffers = new Map();     // index -> AudioBuffer
      this.processed = new Set();

      this.worker = null;
      this.workerReady = false;
      this.workerBusy = false;
      this.procQueue = [];

      this.downloadedSec = 0;       // secondes de flux reçues (incrémental)
      this.streamStarted = false;

      this.ctx = null;
      this.gain = null;
      this.sources = [];
      this.base = null;
      this.gen = 0;
      this.watchdog = null;
      this.cacheEnabled = true;
      this._bound = null;
    }

    phase(name, pct = null, info = null) {
      this.hooks.onPhase && this.hooks.onPhase(name, pct, info);
    }

    getPlayerResponse() {
      return new Promise((resolve) => {
        const timer = setTimeout(() => { cleanup(); resolve(null); }, 3000);
        const onMsg = (e) => {
          if (e.source !== window || e.data?.source !== "vocalis-bridge") return;
          if (e.data?.type !== "player-response") return;
          cleanup();
          resolve(e.data.payload);
        };
        const cleanup = () => {
          clearTimeout(timer);
          window.removeEventListener("message", onMsg);
        };
        window.addEventListener("message", onMsg);
        window.postMessage({ source: "vocalis-content", type: "get-player-response" }, "*");
      });
    }

    /* ---------------------------------------------------------- */
    /* Obtention du flux (3 couches, voir v0.3.1)                  */
    /* ---------------------------------------------------------- */

    pickAudio(pr, mimePrefix) {
      const formats = pr?.streamingData?.adaptiveFormats || [];
      const audio = formats.filter(
        (f) => f.url && (f.mimeType || "").startsWith(mimePrefix)
      );
      if (!audio.length) return null;
      audio.sort(
        (a, b) => (b.bitrate || b.averageBitrate || 0) - (a.bitrate || a.averageBitrate || 0)
      );
      return audio[0];
    }

    async resolveAudioSources(pr, videoId) {
      const log = (m) => this.hooks.onLog && this.hooks.onLog(m);
      const candidates = [];

      const fmts = pr?.streamingData?.adaptiveFormats || [];
      const pageAudio = fmts.filter((f) => (f.mimeType || "").startsWith("audio/"));
      log("flux page : " + pageAudio.length + " formats audio");

      // 1. Déchiffrement du flux natif de la page (prioritaire : le flux du lecteur web n'a AUCUNE limite de 1 Mo)
      let jsUrl = this.extras?.playerJsUrl;
      if (!jsUrl) {
        try {
          const scripts = Array.from(document.querySelectorAll("script[src]"));
          for (const s of scripts) {
            const src = s.src || "";
            if (src.includes("/s/player/") && (src.includes("base.js") || src.includes("player_ias") || src.includes("desktop_polymer"))) {
              jsUrl = src;
              break;
            }
          }
          if (!jsUrl) {
            for (const s of scripts) {
              const src = s.src || "";
              if (src.includes("/s/player/")) { jsUrl = src; break; }
            }
          }
        } catch {}
      }

      let ciphers = pageAudio.filter((f) => f.signatureCipher || f.cipher);

      // Si le playerResponse de la page n'a pas de signatureCipher (YouTube SABR desktop),
      // on demande directement les formats WEB à l'API Innertube avec client WEB (PC natif)
      const apiKey = this.extras?.apiKey || "AIzaSyAO_FJ2SlqU8Q4STEHLNlTpqUcavnZbsC8";
      const targetId = videoId || pr?.videoDetails?.videoId;

      if (!ciphers.length && targetId) {
        log("formats signés absents de la page, interrogation Innertube WEB…");
        const webData = await VocalisInnertube.queryWeb(targetId, apiKey, log);
        if (webData && webData.formats && webData.formats.length) {
          const directs = webData.formats.filter((f) => f.url);
          if (directs.length) {
            const sorted = directs.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            candidates.push({ format: sorted[0], via: "web-pc-direct", ua: null });
            log("Innertube WEB : flux audio direct trouvé (" + directs.length + " formats)");
          }
          ciphers = webData.formats.filter((f) => f.signatureCipher || f.cipher);
          log("Innertube WEB : " + ciphers.length + " formats signés obtenus");
        }
      }

      log("déchiffrement : jsUrl=" + (jsUrl ? "OK" : "aucun") + ", formats chiffrés=" + ciphers.length);
      if (jsUrl && ciphers.length) {
        log("déchiffrement : analyse des " + ciphers.length + " formats signés PC…");
        const variants = [jsUrl];
        const es5 = jsUrl.replace("/player_ias.vflset/", "/player_ias_es5.vflset/");
        if (es5 !== jsUrl) variants.push(es5);
        for (const v of variants) {
          const solved = await this.tryDecipher(v, ciphers, { m4a: null, best: null }, log);
          if (solved && solved.best) {
            candidates.push({ format: solved.best, via: "web-pc", ua: null });
            break;
          }
        }
      }

      // 2. Direct dans la page (si présent sans chiffrement)
      const direct = this.pickAudio(pr, "audio/");
      if (direct && direct.url) {
        candidates.push({ format: direct, via: "page-direct", ua: null });
      }

      // 3. Recherche Innertube alternative (repli uniquement si Web PC a échoué)
      if (!candidates.length) {
        log("recherche de flux via Innertube (repli mobile)…");
        try {
          const it = await withTimeout(
            VocalisInnertube.query(targetId, apiKey, log), 15000, "innertube"
          );
          if (it && it.formats && it.formats.length) {
            const sorted = it.formats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            candidates.push({ format: sorted[0], via: it.client, ua: it.userAgent });
          }
        } catch (e) {
          log("innertube : échec (" + (e?.message || e) + ")");
        }
      }

      return candidates;
    }

    async tryDecipher(jsUrl, pageAudio, out, log) {
      const label = jsUrl.includes("_es5.") ? "base.js es5" : "base.js";
      log("déchiffrement : récupération de " + label + "…");
      try {
        const resp = await withTimeout(
          fetch(jsUrl, { signal: AbortSignal.timeout(10000) }), 10000, label + " (réponse)"
        );
        const baseJs = await withTimeout(resp.text(), 15000, label + " (lecture)");
        log(label + " chargé (" + Math.round(baseJs.length / 1024) + " Ko)");
        const cands = pageAudio
          .filter((f) => f.signatureCipher || f.cipher)
          .sort((a, b) => (b.bitrate || b.averageBitrate || 0) - (a.bitrate || a.averageBitrate || 0));
        for (const f of cands) {
          const cipherText = f.signatureCipher || f.cipher;
          const solved = VocalisCipher.solve(baseJs, cipherText);
          if (solved) {
            const withSolved = { ...f, url: solved.url };
            out.via = "web-pc";
            if ((f.mimeType || "").startsWith("audio/mp4") && !out.m4a) out.m4a = withSolved;
            out.best = out.best || withSolved;
            log("déchiffrement : URL audio PC reconstituée (" + label + ")");
            return out;
          }
        }
        log("déchiffrement : aucun format résolu avec " + label);
      } catch (e) {
        log("déchiffrement : échec " + label + " (" + (e?.message || e) + ")");
      }
      return null;
    }

    /* ---------------------------------------------------------- */
    /* Démarrage                                                   */
    /* ---------------------------------------------------------- */

    async start() {
      this.running = true;

      this.phase("response");
      this.hooks.onLog && this.hooks.onLog("attente du playerResponse…");
      const payload = await this.getPlayerResponse();
      if (this.aborted) return;
      const pr = payload?.pr;
      this.extras = payload || {};

      const urlParams = new URLSearchParams(window.location.search);
      const urlVideoId = urlParams.get("v") || (window.location.pathname.startsWith("/shorts/") ? window.location.pathname.split("/")[2] : null);
      const videoId = pr?.videoDetails?.videoId || urlVideoId;

      this.hooks.onLog && this.hooks.onLog(videoId
        ? "vidéo détectée : " + videoId + (pr ? " (playerResponse OK)" : " (via URL)")
        : "playerResponse VIDE et aucune vidéo dans l'URL");

      if (!videoId) {
        this.hooks.onError && this.hooks.onError("Impossible de lire le lecteur YouTube.");
        return;
      }
      if (pr?.videoDetails?.isLive) {
        this.hooks.onError && this.hooks.onError("Les directs ne sont pas encore gérés.");
        return;
      }
      this.duration = parseFloat(pr?.videoDetails?.lengthSeconds) || this.video?.duration || 0;
      this.nChunks = Math.max(1, Math.ceil(this.duration / CHUNK));
      this.cacheEnabled = this.nChunks * CHUNK * SR * 2 * 2 <= CACHE_CAP;

      /* Worker IA : créé maintenant, initialisé EN PARALLÈLE du flux */
      this.phase("model");
      this.hooks.onLog && this.hooks.onLog("lancement du worker IA…");
      this.spawnWorker();

      let candidates;
      try {
        candidates = await this.resolveAudioSources(pr, videoId);
      } catch (e) {
        this.hooks.onLog && this.hooks.onLog("ERREUR recherche de flux : " + (e?.message || e));
        this.hooks.onError &&
          this.hooks.onError("Impossible de trouver le flux audio (" + (e?.message || "erreur") + ").");
        return;
      }

      if (!candidates.length) {
        this.hooks.onError &&
          this.hooks.onError(
            "Aucun flux audio utilisable (couches testées : déchiffrement page, direct, innertube)."
          );
        return;
      }
      this.videoId = videoId;

      this.mode = "legacy";
      await this.startPipelineAudio(candidates);
      if (this.aborted || this.fatal) return;

      if (this.started) this.hooks.onReady && this.hooks.onReady(this.duration);
    }

    /* ---------------- Téléchargement complet résilient ---------------- */

    arrayBufferToBase64(buffer) {
      let binary = "";
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      const chunk = 8192;
      for (let i = 0; i < len; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
      }
      return btoa(binary);
    }

    base64ToArrayBuffer(base64) {
      const binaryString = atob(base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes.buffer;
    }

    async downloadFullAudio(url, expectedTotalBytes = 0) {
      this.hooks.onLog && this.hooks.onLog("démarrage du téléchargement audio résilient…");
      const CHUNK_SIZE = 1024 * 1024; // 1 Mo par tranche
      const chunks = [];
      let received = 0;
      let total = expectedTotalBytes || 0;
      let start = 0;
      let isComplete = false;

      // Nettoie l'URL de tout paramètre range conflictuel
      let cleanUrl = url;
      try {
        const u = new URL(url);
        u.searchParams.delete("range");
        cleanUrl = u.toString();
      } catch {}

      // Télécharge une tranche : 1er essai direct (page/CORS), 2nd essai via l'extension (service worker)
      const fetchChunk = async (s, e) => {
        const rangeHeader = e != null ? `bytes=${s}-${e}` : `bytes=${s}-`;
        try {
          const resp = await fetch(cleanUrl, {
            headers: { Range: rangeHeader },
            signal: AbortSignal.timeout(10000),
          });
          if (resp.ok || resp.status === 206) {
            const buf = await resp.arrayBuffer();
            const cr = resp.headers.get("content-range");
            let t = 0;
            const m = cr && cr.match(/\/(\d+)$/);
            if (m) t = parseInt(m[1], 10);
            return { buf, total: t };
          }
        } catch {
          // Erreur CORS / Failed to fetch : repli automatique vers l'extension ci-dessous
        }

        // Repli service worker (100 % hors CORS, permissions d'extension)
        const bgRes = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: "vocalis:fetch-range", url: cleanUrl, start: s, end: e },
            (res) => resolve(res || { ok: false })
          );
        });

        if (bgRes && bgRes.ok && bgRes.base64) {
          const buf = this.base64ToArrayBuffer(bgRes.base64);
          return { buf, total: bgRes.total || 0 };
        }

        const errDetail = bgRes?.status ? `HTTP ${bgRes.status}` : bgRes?.error || "échec";
        throw new Error(`tranche ${Math.round(s / 1048576)} Mo (${errDetail})`);
      };

      // 1. Première tranche
      const first = await fetchChunk(0, CHUNK_SIZE - 1);
      if (this.aborted) return null;
      if (!first.buf || first.buf.byteLength === 0) {
        throw new Error("tranche 0 vide");
      }
      chunks.push(new Uint8Array(first.buf));
      received += first.buf.byteLength;
      if (first.total && first.total > first.buf.byteLength) {
        total = first.total;
      }
      start = received;

      if (total) this.phase("download", Math.round((received / total) * 100));

      // Vérifie si le fichier tient entièrement dans la première tranche
      if ((first.buf.byteLength < CHUNK_SIZE && !total) || (total && received >= total)) {
        isComplete = true;
      } else {
        // 2. Tranches suivantes : on télécharge tant qu'on n'a pas atteint la fin du flux
        while (total ? start < total : true) {
          if (this.aborted) return null;
          const end = total ? Math.min(start + CHUNK_SIZE - 1, total - 1) : start + CHUNK_SIZE - 1;
          let chunk;
          try {
            chunk = await fetchChunk(start, end);
          } catch (e) {
            // Si la tranche échoue (par ex. bride CDN à 1 Mo), on s'arrête sans crasher si on a déjà du contenu
            this.hooks.onLog &&
              this.hooks.onLog(`fin de flux ou bride atteinte à ${Math.round(received / 1024)} Ko (${e?.message || e})`);
            break;
          }
          if (this.aborted || !chunk || !chunk.buf || chunk.buf.byteLength === 0) break;
          chunks.push(new Uint8Array(chunk.buf));
          received += chunk.buf.byteLength;
          if (chunk.total && chunk.total > total) total = chunk.total;
          start += chunk.buf.byteLength;
          if (total) this.phase("download", Math.round((received / total) * 100));
          if (chunk.buf.byteLength < CHUNK_SIZE || (total && received >= total)) {
            isComplete = true;
            break;
          }
        }
      }

      const combined = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        combined.set(c, off);
        off += c.byteLength;
      }
      this.hooks.onLog && this.hooks.onLog(`audio reçu (${(received / (1024 * 1024)).toFixed(1)} Mo, complet=${isComplete})`);
      return { buf: combined.buffer, complete: isComplete };
    }

    async startPipelineAudio(candidates) {
      this.phase("download", 0);
      let arrayBuf = null;
      let successVia = null;
      let partialBuf = null;
      let partialVia = null;

      for (const cand of candidates) {
        this.via = cand.via;
        this.hooks.onLog && this.hooks.onLog("tentative téléchargement via : " + cand.via);
        if (cand.ua) {
          await chrome.runtime
            .sendMessage({ type: "vocalis:set-stream-ua", ua: cand.ua })
            .catch(() => {});
        }
        try {
          const expectedTotal = parseInt(cand.format?.contentLength || "0", 10);
          const res = await this.downloadFullAudio(cand.format.url, expectedTotal);
          if (res && res.buf && res.buf.byteLength > 64000) {
            if (res.complete) {
              arrayBuf = res.buf;
              successVia = cand.via;
              break;
            } else if (!partialBuf) {
              partialBuf = res.buf;
              partialVia = cand.via;
            }
          }
        } catch (e) {
          this.hooks.onLog &&
            this.hooks.onLog("échec via " + cand.via + " (" + (e?.message || e) + "), essai suivant…");
        }
      }

      if (!arrayBuf && partialBuf) {
        arrayBuf = partialBuf;
        successVia = partialVia;
        this.hooks.onLog &&
          this.hooks.onLog("utilisation du flux partiel reçu via : " + successVia);
      }

      if (!arrayBuf) {
        this.fatal = true;
        this.hooks.onError &&
          this.hooks.onError("Impossible de télécharger le flux audio (toutes les sources ont échoué).");
        return;
      }

      this.via = successVia;
      this.hooks.onLog && this.hooks.onLog("audio prêt via : " + successVia);

      if (this.aborted) return;

      this.phase("decode");
      let decoded;
      const probe = new AudioContext();
      try {
        decoded = await probe.decodeAudioData(arrayBuf);
      } catch (e) {
        this.hooks.onError &&
          this.hooks.onError("Décodage de l'audio impossible (" + (e?.message || e) + ").");
        return;
      } finally {
        probe.close();
      }
      if (this.aborted) return;
      if (!this.duration || decoded.duration < this.duration) {
        this.duration = decoded.duration;
        this.nChunks = Math.max(1, Math.ceil(this.duration / CHUNK));
      }

      this.phase("resample");
      let left, right;
      if (decoded.sampleRate === SR && decoded.numberOfChannels >= 2) {
        left = decoded.getChannelData(0);
        right = decoded.getChannelData(1);
      } else {
        const off = new OfflineAudioContext(2, Math.ceil(decoded.duration * SR), SR);
        const s = off.createBufferSource();
        s.buffer = decoded;
        s.connect(off.destination);
        s.start();
        const rendered = await off.startRendering();
        left = rendered.getChannelData(0);
        right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
        decoded = null;
      }
      if (this.aborted) return;
      this.audio44 = { left, right };

      this.phase("prepare", 0);
      const readyP = new Promise((res) => { this.startResolve = res; });
      this.setPriority(0);
      await readyP;
    }

    /* ---------------------------------------------------------- */
    /* Worker IA + file de traitement                              */
    /* ---------------------------------------------------------- */

    spawnWorker() {
      // Un content script ne peut pas créer de Worker chrome-extension:// :
      // le proxy le fait naître dans le document offscreen de l'extension.
      const w = new VocalisWorkerProxy();
      this.worker = w;
      w.onmessage = (e) => this.onWorkerMessage(e.data);
      w.onerror = (e) => {
        this.fatal = true;
        this.hooks.onError &&
          this.hooks.onError("Échec du moteur IA : " + (e.message || "worker"));
        const r = this.startResolve;
        this.startResolve = null;
        r && r();
      };
      w.postMessage({ type: "init" });
    }

    onWorkerMessage(msg) {
      if (this.aborted) return;
      if (msg.type === "log") {
        this.hooks.onLog && this.hooks.onLog(msg.msg);
      } else if (msg.type === "model-download") {
        this.phase("model", msg.pct, msg);
      } else if (msg.type === "ready") {
        this.workerReady = true;
        this.pump();
      } else if (msg.type === "stream-download") {
        this.downloadedSec = msg.seconds || 0;
        this.phase("download", msg.pct, { seconds: msg.seconds });
      } else if (msg.type === "stream-error") {
        this.hooks.onLog &&
          this.hooks.onLog("flux fragmenté en échec : " + (msg.message || "inconnu"));
        this._fallback(msg.message);
      } else if (msg.type === "done") {
        if (this.processed.has(msg.index)) { this.pump(); return; }
        const leftBuf = msg.leftB64 ? this.base64ToArrayBuffer(msg.leftB64) : (msg.left instanceof ArrayBuffer ? msg.left : null);
        const rightBuf = msg.rightB64 ? this.base64ToArrayBuffer(msg.rightB64) : (msg.right instanceof ArrayBuffer ? msg.right : null);
        if (!leftBuf || leftBuf.byteLength === 0) {
          this.currentProcessing = null;
          this.workerBusy = false;
          this.pump();
          return;
        }
        this.onChunkDone(msg.index, new Float32Array(leftBuf), new Float32Array(rightBuf));
      } else if (msg.type === "error") {
        if (!this.workerReady) {
          this.fatal = true;
          this.hooks.onError && this.hooks.onError("Échec du modèle IA : " + msg.message);
          const r = this.startResolve;
          this.startResolve = null;
          r && r();
          return;
        }
        this.currentProcessing = null;
        this.workerBusy = false;
        this.pump();
      }
    }

    setPriority(fromIdx) {
      const wanted = [];
      for (let i = fromIdx; i < this.nChunks; i++) {
        if (!this.processed.has(i) && i !== this.currentProcessing) wanted.push(i);
      }
      this.procQueue = wanted;
      if (this.mode === "legacy") this.pump();
    }

    pump() {
      if (this.mode !== "legacy" || this.workerBusy || !this.workerReady) return;
      let idx = null;
      while (this.procQueue.length) {
        const i = this.procQueue.shift();
        if (!this.processed.has(i) && this.audio44) { idx = i; break; }
      }
      if (idx == null) return;
      const start = idx * CHUNK * SR;
      const len = Math.min(CHUNK * SR, this.audio44.left.length - start);
      if (len <= 0) { this.pump(); return; }
      this.workerBusy = true;
      this.currentProcessing = idx;
      const left = new Float32Array(this.audio44.left.subarray(start, start + len));
      const right = new Float32Array(this.audio44.right.subarray(start, start + len));
      this.worker.postMessage({
        type: "process",
        index: idx,
        leftB64: this.arrayBufferToBase64(left.buffer),
        rightB64: this.arrayBufferToBase64(right.buffer),
        samples: len,
      });
    }

    onChunkDone(idx, left, right) {
      this.currentProcessing = null;
      this.workerBusy = false;

      this.hooks.onLog &&
        this.hooks.onLog(`bloc ${idx + 1} prêt (${left.length} échantillons vocaux reçus)`);

      const pcm = new Int16Array(left.length * 2);
      for (let s = 0; s < left.length; s++) {
        const l = left[s], r = right[s];
        pcm[s * 2] = l < -1 ? -32768 : l > 1 ? 32767 : Math.round(l * 32767);
        pcm[s * 2 + 1] = r < -1 ? -32768 : r > 1 ? 32767 : Math.round(r * 32767);
      }
      this.mem.set(idx, pcm);
      this.processed.add(idx);
      if (this.cacheEnabled) {
        VocalisIDB.put({
          key: `${this.videoId}:${idx}`,
          videoId: this.videoId,
          index: idx,
          pcm,
          sampleRate: SR,
          channels: 2,
        }).catch(() => { this.cacheEnabled = false; });
      }

      this.hooks.onProcessed && this.hooks.onProcessed(this.ranges(), this.duration);

      if (!this.started) {
        const ready = this.processed.size * CHUNK;
        this.phase("prepare", Math.min(100, Math.round((ready / PRELOAD_S) * 100)));
        if (ready >= PRELOAD_S || this.processed.size >= this.nChunks) {
          this.started = true;
          this.hooks.onLog &&
            this.hooks.onLog(`pré-chargement terminé (${this.processed.size} blocs = ${ready} s), activation du son…`);
          const r = this.startResolve;
          this.startResolve = null;
          r && r();
        }
      }

      if (this.processed.size >= this.nChunks) this.audio44 = null;
      this.pump();
    }

    ranges() {
      const out = [];
      let s = null;
      for (let i = 0; i <= this.nChunks; i++) {
        const ok = i < this.nChunks && this.processed.has(i);
        if (ok && s === null) s = i * CHUNK;
        if (!ok && s !== null) {
          out.push([s, i * CHUNK]);
          s = null;
        }
      }
      return out;
    }

    /* ---------------------------------------------------------- */
    /* Relecture synchronisée                                      */
    /* ---------------------------------------------------------- */

    async bufferFor(i) {
      if (!this.ctx) return null;
      const cached = this.buffers.get(i);
      if (cached) return cached;
      let pcm = this.mem.get(i);
      if (!pcm && this.cacheEnabled) {
        const rec = await VocalisIDB.get(`${this.videoId}:${i}`).catch(() => null);
        if (rec) { pcm = rec.pcm; this.mem.set(i, pcm); }
      }
      if (!pcm) return null;
      const len = Math.floor(pcm.length / 2);
      const buf = this.ctx.createBuffer(2, len, SR);
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (let s = 0; s < len; s++) {
        L[s] = pcm[s * 2] / 32768;
        R[s] = pcm[s * 2 + 1] / 32768;
      }
      this.buffers.set(i, buf);
      this.trimMemory();
      return buf;
    }

    trimMemory() {
      if (this.mem.size <= MEM_WINDOW) return;
      const center = Math.floor((this.video.currentTime || 0) / CHUNK);
      const keys = [...this.mem.keys()].sort(
        (a, b) => Math.abs(a - center) - Math.abs(b - center)
      );
      for (const k of keys.slice(MEM_WINDOW)) {
        this.mem.delete(k);
        this.buffers.delete(k);
      }
    }

    stopSources() {
      for (const s of this.sources) {
        try { s.stop(); } catch { /* déjà arrêté */ }
      }
      this.sources = [];
      this.base = null;
    }

    initAudioContext() {
      if (!this.ctx) {
        try {
          this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
        } catch {
          try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
          } catch {}
        }
      }
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      if (!this.gain && this.ctx) {
        this.gain = this.ctx.createGain();
        let targetVol = 1.0;
        try {
          const p = document.getElementById("movie_player");
          if (p && typeof p.getVolume === "function") {
            const v = p.getVolume();
            if (typeof v === "number" && v > 0) targetVol = v / 100;
          }
        } catch {}
        this.gain.gain.value = targetVol;
        this.gain.connect(this.ctx.destination);
      }
    }

    reschedule() {
      if (this._rescheduleTimer) clearTimeout(this._rescheduleTimer);
      this._rescheduleTimer = setTimeout(() => {
        this._rescheduleTimer = null;
        this._executeReschedule();
      }, 40);
    }

    async _executeReschedule() {
      if (!this.active || !this.ctx || this.video.ended) return;

      if (this.ctx.state === "suspended") {
        await this.ctx.resume().catch(() => {});
      }
      if (this.ctx.state !== "running") return;

      if (this.video.paused) {
        this.stopSources();
        return;
      }

      const g = ++this.gen;
      this.stopSources();

      const t0 = this.video.currentTime;
      const i0 = Math.max(0, Math.floor(t0 / CHUNK));
      const iMax = Math.min(this.nChunks - 1, Math.floor((t0 + SCHEDULE_AHEAD) / CHUNK));
      const ctx0 = this.ctx.currentTime + 0.05;
      this.base = { ctx0, vid0: t0 };

      let scheduled = 0;
      for (let i = i0; i <= iMax; i++) {
        if (!this.processed.has(i)) continue;
        const buf = await this.bufferFor(i);
        if (g !== this.gen || !this.active || this.video.paused) return;
        if (!buf) continue;
        const segStart = i * CHUNK;
        const offset = Math.max(0, t0 - segStart);
        const when = ctx0 + Math.max(0, segStart - t0);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.gain);
        src.start(when, offset);
        this.sources.push(src);
        scheduled++;
      }
      this.hooks.onLog &&
        this.hooks.onLog(`relecture : ${scheduled} segment(s) actif(s) (t=${t0.toFixed(1)}s, ctx=${this.ctx.state})`);
    }

    downloadedTime() {
      return this.mode === "incr" ? this.downloadedSec : this.duration;
    }

    onVideoEvent = (ev) => {
      if (!this.active) return;
      switch (ev.type) {
        case "play":
        case "playing":
        case "seeked": {
          this.stalled = false;
          if (this.ctx && this.ctx.state === "suspended") {
            this.ctx.resume().catch(() => {});
          }
          if (this.active) {
            if (!this.video.muted) this.video.muted = true;
            try {
              const p = document.getElementById("movie_player");
              if (p && typeof p.mute === "function" && typeof p.isMuted === "function" && !p.isMuted()) {
                p.mute();
              }
            } catch {}
          }
          const t = this.video.currentTime;
          const idx = Math.floor(t / CHUNK);
          this.setPriorityIncr(idx);
          if (this.video.playbackRate === 1) this.reschedule();
          break;
        }
        case "pause":
        case "ended":
          this.stopSources();
          break;
        case "waiting":
          this.stalled = true;
          this.stopSources();
          break;
        case "ratechange":
          if (this.video.playbackRate !== 1) {
            this.stopSources();
            this.video.muted = false;
            try {
              const p = document.getElementById("movie_player");
              if (p && typeof p.unMute === "function") p.unMute();
            } catch {}
            if (!this.rateNoticeShown) {
              this.rateNoticeShown = true;
              this.hooks.onNotice &&
                this.hooks.onNotice("Vitesse ≠ ×1 : son original rétabli (pas de time-stretch).");
            }
          } else {
            this.video.muted = true;
            try {
              const p = document.getElementById("movie_player");
              if (p && typeof p.mute === "function") p.mute();
            } catch {}
            this.reschedule();
          }
          break;
        case "volumechange":
          if (this.gain) {
            let targetVol = 1.0;
            try {
              const p = document.getElementById("movie_player");
              if (p && typeof p.getVolume === "function") {
                const v = p.getVolume();
                if (typeof v === "number" && v > 0) targetVol = v / 100;
              }
            } catch {
              if (typeof this.video.volume === "number" && this.video.volume > 0) {
                targetVol = this.video.volume;
              }
            }
            this.gain.gain.value = targetVol;
          }
          break;
      }
    };

    setPriorityIncr(idx) {
      if (this.mode !== "incr") { this.setPriority(idx); return; }
      this.setPriority(idx);
      /* seek loin devant le téléchargement : on redémarre le flux à cet endroit */
      if (idx * CHUNK > this.downloadedTime() + 10 && !this.processed.has(idx)) {
        this._startStream(idx * CHUNK);
      }
    }

    async activate() {
      if (!this.started || this.active) return;
      if (this.video.playbackRate !== 1) {
        this.hooks.onNotice && this.hooks.onNotice("Vitesse ≠ ×1 : son original.");
        return;
      }

      this.initAudioContext();
      if (this.ctx && this.ctx.state === "suspended") {
        await this.ctx.resume().catch(() => {});
      }

      this.active = true;
      this.video.muted = true;
      try {
        const p = document.getElementById("movie_player");
        if (p && typeof p.mute === "function") p.mute();
      } catch {}

      const events = ["play", "playing", "pause", "waiting", "ended", "seeked", "ratechange", "volumechange"];
      this._bound = this.onVideoEvent;
      for (const e of events) this.video.addEventListener(e, this._bound);

      this.watchdog = setInterval(() => {
        if (!this.active || this.video.paused || this.stalled) return;
        if (this.video.playbackRate !== 1) return;

        // Force le silence sur YouTube tant que Vocalis est actif
        if (!this.video.muted) this.video.muted = true;
        try {
          const p = document.getElementById("movie_player");
          if (p && typeof p.mute === "function" && typeof p.isMuted === "function" && !p.isMuted()) {
            p.mute();
          }
        } catch {}

        if (this.ctx && this.ctx.state === "suspended") {
          this.ctx.resume().catch(() => {});
        }

        const cur = Math.floor(this.video.currentTime / CHUNK);
        if (!this.processed.has(cur)) {
          this.stopSources();
          this.setPriorityIncr(cur);
          this.hooks.onStall &&
            this.hooks.onStall(Math.round((this.processed.size / this.nChunks) * 100));
          return;
        }
        this.hooks.onStallClear && this.hooks.onStallClear();

        // Si aucune source n'est active alors que le bloc courant est prêt, on replanifie
        if (this.sources.length === 0 && !this.video.paused) {
          this.reschedule();
          return;
        }

        if (!this.base) { this.reschedule(); return; }
        const expected = this.base.vid0 + (this.ctx.currentTime - this.base.ctx0);
        if (Math.abs(this.video.currentTime - expected) > DRIFT_MAX) {
          this.reschedule();
        }
        this.trimMemory();
      }, 500);

      this.reschedule();
    }

    deactivate() {
      if (!this.active) return;
      this.active = false;
      this.stalled = false;
      this.gen++;
      if (this._rescheduleTimer) {
        clearTimeout(this._rescheduleTimer);
        this._rescheduleTimer = null;
      }
      this.stopSources();
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      if (this._bound) {
        for (const e of ["play", "playing", "pause", "waiting", "ended", "seeked", "ratechange", "volumechange"]) {
          this.video.removeEventListener(e, this._bound);
        }
        this._bound = null;
      }
      this.video.muted = false;
      try {
        const p = document.getElementById("movie_player");
        if (p && typeof p.unMute === "function") p.unMute();
      } catch {}
      if (this.ctx) this.ctx.close().catch(() => {});
      this.ctx = null;
      this.gain = null;
    }

    status() {
      return {
        started: this.started,
        active: this.active,
        videoId: this.videoId,
        duration: this.duration,
        mode: this.mode,
        via: this.via || null,
        processedPct: this.nChunks ? Math.round((this.processed.size / this.nChunks) * 100) : 0,
      };
    }

    destroy() {
      this.aborted = true;
      this.dead = true;
      this.deactivate();
      if (this.worker) this.worker.terminate();
      this.worker = null;
      this.mem.clear();
      this.buffers.clear();
      this.processed.clear();
    }
  }

  return Engine;
})();
