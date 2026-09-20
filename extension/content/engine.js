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
  const DRIFT_MAX = 0.09;           // écart audio/vidéo toléré (s)

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

    async resolveAudioSource(pr, videoId) {
      const log = (m) => this.hooks.onLog && this.hooks.onLog(m);
      const out = { m4a: null, best: null, via: "page" };

      if (pr) {
        const fmts = pr?.streamingData?.adaptiveFormats || [];
        const pageAudio = fmts.filter((f) => (f.mimeType || "").startsWith("audio/"));
        const withUrl = pageAudio.filter((f) => f.url);
        log("flux page : " + pageAudio.length + " formats audio, " +
            withUrl.length + " avec URL directe");

        out.m4a = this.pickAudio(pr, "audio/mp4");
        out.best = this.pickAudio(pr, "audio/");
        if (out.best) return out;
      }

      log("recherche du flux via l'API Innertube (VisionOS / Android)…");
      const apiKey = this.extras?.apiKey || "AIzaSyAO_FJ2SlqU8Q4STEHLNlTpqUcavnZbsC8";
      const targetId = videoId || pr?.videoDetails?.videoId;
      let it = null;
      try {
        it = await withTimeout(
          VocalisInnertube.query(targetId, apiKey, log), 20000, "innertube"
        );
      } catch (e) {
        log("innertube : échec global (" + (e?.message || e) + ")");
      }
      if (it) {
        const f = (list) =>
          list.sort((a, b) => (b.bitrate || b.averageBitrate || 0) - (a.bitrate || a.averageBitrate || 0))[0];
        out.m4a = f(it.formats.filter((x) => (x.mimeType || "").startsWith("audio/mp4"))) || null;
        out.best = f(it.formats);
        out.via = it.client;
        out.ua = it.userAgent;
        if (out.best) return out;
      }

      const jsUrl = this.extras?.playerJsUrl;
      const fmts = pr?.streamingData?.adaptiveFormats || [];
      const pageAudio = fmts.filter((f) => (f.mimeType || "").startsWith("audio/"));
      if (jsUrl && pageAudio.length) {
        // base.js principal, puis variante ES5 (syntaxe classique que notre
        // mini-bundler comprend à coup sûr) si le premier ne résout rien.
        const variants = [jsUrl];
        const es5 = jsUrl.replace("/player_ias.vflset/", "/player_ias_es5.vflset/");
        if (es5 !== jsUrl) variants.push(es5);
        for (const v of variants) {
          const solved = await this.tryDecipher(v, pageAudio, out, log);
          if (solved) return solved;
        }
      } else {
        log("base.js introuvable ou aucun format à déchiffrer");
      }
      return out;
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
          .filter((f) => f.signatureCipher)
          .sort((a, b) => (b.bitrate || b.averageBitrate || 0) - (a.bitrate || a.averageBitrate || 0));
        for (const f of cands) {
          const solved = VocalisCipher.solve(baseJs, f.signatureCipher);
          if (solved) {
            const withSolved = { ...f, url: solved.url };
            out.via = "déchiffrement";
            if ((f.mimeType || "").startsWith("audio/mp4") && !out.m4a) out.m4a = withSolved;
            out.best = out.best || withSolved;
            log("déchiffrement : URL audio reconstituée (" + label + ")");
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

      let src;
      try {
        src = await this.resolveAudioSource(pr, videoId);
      } catch (e) {
        this.hooks.onLog && this.hooks.onLog("ERREUR recherche de flux : " + (e?.message || e));
        this.hooks.onError &&
          this.hooks.onError("Impossible de trouver le flux audio (" + (e?.message || "erreur") + ").");
        return;
      }
      this.via = src.via;
      this.hooks.onLog && this.hooks.onLog("flux audio obtenu via : " + src.via);
      if (!src.best) {
        this.hooks.onError &&
          this.hooks.onError(
            "Aucun flux audio utilisable (couches testées : page, innertube, déchiffrement). " +
              "Vidéo protégée, ou YouTube a changé ses verrous — signale-le avec ce message."
          );
        return;
      }
      this.videoId = videoId;

      /* Worker IA : créé maintenant, initialisé EN PARALLÈLE du flux */
      this.phase("model");
      this.hooks.onLog && this.hooks.onLog("lancement du worker IA…");
      this.spawnWorker();

      // mp4box vit DANS le worker (module ES) : ici on ne vérifie que
      // WebCodecs ; si le worker n'a pas mp4box, il émettra stream-error.
      const incrOk = src.m4a && typeof AudioDecoder !== "undefined";
      this.streamUA = src.ua || null;
      this.hooks.onLog && this.hooks.onLog("WebCodecs dispo (page) : " +
        (typeof AudioDecoder !== "undefined"));

      if (src.ua) {
        await chrome.runtime
          .sendMessage({ type: "vocalis:set-stream-ua", ua: src.ua })
          .catch(() => {});
      }

      this.mode = "legacy";
      await this.startPipelineAudio(src.best);
      if (this.aborted || this.fatal) return;

      if (this.started) this.hooks.onReady && this.hooks.onReady(this.duration);
    }

    /* ---------------- Téléchargement complet résilient ---------------- */

    async downloadFullAudio(url) {
      // 1. Essai direct (rapide si le CDN l'accepte)
      try {
        const resp = await fetch(url);
        if (resp.ok && resp.body) {
          const total = parseInt(resp.headers.get("content-length") || "0", 10);
          const reader = resp.body.getReader();
          const chunks = [];
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (this.aborted) return null;
            chunks.push(value);
            received += value.length;
            if (total) this.phase("download", Math.round((received / total) * 100));
          }
          return await new Blob(chunks).arrayBuffer();
        }
      } catch {
        /* Repli sur Range ci-dessous */
      }

      // 2. Repli tranches Range 1 Mo bornées (accepté par tous les CDN googlevideo)
      this.hooks.onLog && this.hooks.onLog("téléchargement par tranches bornées de 1 Mo…");
      const CHUNK_SIZE = 1024 * 1024;
      let start = 0;
      let total = 0;
      const chunks = [];
      let received = 0;

      const firstResp = await fetch(url, { headers: { Range: `bytes=0-${CHUNK_SIZE - 1}` } });
      if (!firstResp.ok && firstResp.status !== 206) {
        throw new Error("HTTP " + firstResp.status);
      }
      const cr = firstResp.headers.get("content-range");
      const m = cr && cr.match(/\/(\d+)$/);
      if (m) total = parseInt(m[1], 10);
      const firstBuf = await firstResp.arrayBuffer();
      chunks.push(new Uint8Array(firstBuf));
      received += firstBuf.byteLength;
      start = CHUNK_SIZE;
      if (total) this.phase("download", Math.round((received / total) * 100));

      while (start < total) {
        if (this.aborted) return null;
        const end = Math.min(start + CHUNK_SIZE - 1, total - 1);
        const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
        if (!r.ok && r.status !== 206) throw new Error("HTTP " + r.status);
        const b = await r.arrayBuffer();
        chunks.push(new Uint8Array(b));
        received += b.byteLength;
        start = end + 1;
        if (total) this.phase("download", Math.round((received / total) * 100));
      }

      const combined = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        combined.set(c, off);
        off += c.byteLength;
      }
      return combined.buffer;
    }

    async startPipelineAudio(fmt) {
      this.phase("download", 0);
      let arrayBuf;
      try {
        arrayBuf = await this.downloadFullAudio(fmt.url);
        if (!arrayBuf || this.aborted) return;
      } catch (e) {
        if (this.aborted) return;
        this.fatal = true;
        this.hooks.onLog &&
          this.hooks.onLog("ERREUR téléchargement : " + (e?.message || e));
        this.hooks.onError &&
          this.hooks.onError("Téléchargement de l'audio impossible (" + (e?.message || e) + ").");
        return;
      }
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
      if (!this.duration) {
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
        this.onChunkDone(msg.index, new Float32Array(msg.left), new Float32Array(msg.right));
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
      this.worker.postMessage(
        { type: "process", index: idx, left: left.buffer, right: right.buffer },
        [left.buffer, right.buffer]
      );
    }

    onChunkDone(idx, left, right) {
      this.currentProcessing = null;
      this.workerBusy = false;

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

    async reschedule() {
      const g = ++this.gen;
      this.stopSources();
      if (!this.active || !this.ctx || this.video.paused || this.video.ended) return;

      const t0 = this.video.currentTime;
      const i0 = Math.max(0, Math.floor(t0 / CHUNK));
      const iMax = Math.min(this.nChunks - 1, Math.floor((t0 + SCHEDULE_AHEAD) / CHUNK));
      const ctx0 = this.ctx.currentTime + 0.08;
      this.base = { ctx0, vid0: t0 };

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
      }
    }

    downloadedTime() {
      return this.mode === "incr" ? this.downloadedSec : this.duration;
    }

    onVideoEvent = (ev) => {
      if (!this.active) return;
      switch (ev.type) {
        case "play":
        case "seeked": {
          this.stalled = false;
          const t = this.video.currentTime;
          const idx = Math.floor(t / CHUNK);
          this.setPriorityIncr(idx);
          if (this.video.playbackRate === 1) this.reschedule();
          break;
        }
        case "playing":
          this.stalled = false;
          if (this.video.playbackRate === 1) this.reschedule();
          break;
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
            if (!this.rateNoticeShown) {
              this.rateNoticeShown = true;
              this.hooks.onNotice &&
                this.hooks.onNotice("Vitesse ≠ ×1 : son original rétabli (pas de time-stretch).");
            }
          } else {
            this.video.muted = true;
            this.reschedule();
          }
          break;
        case "volumechange":
          if (this.gain) this.gain.gain.value = this.video.volume;
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

      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.video.volume;
      this.gain.connect(this.ctx.destination);

      this.active = true;
      this.video.muted = true;

      const events = ["play", "playing", "pause", "waiting", "ended", "seeked", "ratechange", "volumechange"];
      this._bound = this.onVideoEvent;
      for (const e of events) this.video.addEventListener(e, this._bound);

      this.watchdog = setInterval(() => {
        if (!this.active || this.video.paused || this.stalled) return;
        if (this.video.playbackRate !== 1) return;

        const cur = Math.floor(this.video.currentTime / CHUNK);
        if (!this.processed.has(cur)) {
          this.stopSources();
          this.setPriorityIncr(cur);
          this.hooks.onStall &&
            this.hooks.onStall(Math.round((this.processed.size / this.nChunks) * 100));
          return;
        }
        this.hooks.onStallClear && this.hooks.onStallClear();

        if (!this.base) { this.reschedule(); return; }
        const expected = this.base.vid0 + (this.ctx.currentTime - this.base.ctx0);
        if (Math.abs(this.video.currentTime - expected) > DRIFT_MAX) this.reschedule();
        this.trimMemory();
      }, 400);

      await this.reschedule();
    }

    deactivate() {
      if (!this.active) return;
      this.active = false;
      this.stalled = false;
      this.gen++;
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
