/**
 * Vocalis — moteur audio v0.3 : la musique disparaît vraiment
 *
 * Pipeline :
 *  1. playerResponse (pont main-world) → meilleur flux audio ;
 *  2. téléchargement (progression) + décodage ;
 *  3. remise à 44,1 kHz stéréo (le format du modèle) ;
 *  4. worker IA (HTDemucs ONNX, WebGPU/WASM) : chaque bloc de 30 s est
 *     séparé, on ne garde que les VOIX ;
 *  5. pré-chargement : la lecture démarre dès ~60 s de voix prêtes, le
 *     reste se traite en arrière-plan pendant qu'on regarde ;
 *  6. cache IndexedDB (blocs de 30 s, PCM16) : retour arrière instantané,
 *     purge en quittant la vidéo ;
 *  7. relecture Web Audio synchronisée sur video.currentTime.
 *
 * Si on avance dans une zone pas encore traitée : écran « traitement »
 * jusqu'à ce que la zone soit prête (file prioritaire sur la tête de lecture).
 */

self.VocalisEngine = (() => {
  "use strict";

  const CHUNK = 30;                 // durée d'un bloc traité (s)
  const SR = 44100;                 // fréquence du modèle
  const PRELOAD_S = 60;             // secondes de voix prêtes avant lecture
  const SCHEDULE_AHEAD = 60;        // secondes d'audio programmées d'avance
  const MEM_WINDOW = 60;            // blocs gardés en RAM (~30 min)
  const CACHE_CAP = 1_500_000_000;  // plafond IndexedDB par vidéo (~1,5 Go)
  const DRIFT_MAX = 0.09;           // écart audio/vidéo toléré (s)

  class Engine {
    constructor(video, hooks = {}) {
      this.video = video;
      this.hooks = hooks;

      this.aborted = false;
      this.running = false;
      this.started = false;
      this.active = false;
      this.stalled = false;
      this.rateNoticeShown = false;

      this.videoId = null;
      this.duration = 0;
      this.nChunks = 0;

      this.audio44 = null;          // { left, right } Float32 masters
      this.mem = new Map();         // index -> Int16Array (voix, PCM16 entrelacé)
      this.buffers = new Map();     // index -> AudioBuffer
      this.processed = new Set();

      this.worker = null;
      this.workerReady = false;
      this.workerBusy = false;
      this.queue = [];
      this.pending = new Map();     // index -> resolve()

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

    pickFormat(pr) {
      const formats = pr?.streamingData?.adaptiveFormats || [];
      const audio = formats.filter(
        (f) => f.url && (f.mimeType || "").startsWith("audio/")
      );
      if (!audio.length) return null;
      audio.sort(
        (a, b) => (b.bitrate || b.averageBitrate || 0) - (a.bitrate || a.averageBitrate || 0)
      );
      return audio[0];
    }

    /**
     * Cascade d'obtention d'une URL audio utilisable :
     *  1. URLs en clair du playerResponse de la page ;
     *  2. requête youtubei/v1/player avec des clients TV/Android
     *     (reçoivent souvent des URLs en clair) ;
     *  3. déchiffrement signatureCipher + paramètre n depuis base.js.
     */
    async resolveAudioSource(pr) {
      const direct = this.pickFormat(pr);
      if (direct) return { fmt: direct, via: "page" };

      const apiKey =
        this.extras?.apiKey || "AIzaSyAO_FJ2SlqU8Q4STEHLNlTpqUcavnZbsC8";
      const it = await VocalisInnertube.query(pr.videoDetails.videoId, apiKey);
      if (it) {
        const formats = it.formats.sort(
          (a, b) => (b.bitrate || b.averageBitrate || 0) - (a.bitrate || a.averageBitrate || 0)
        );
        return { fmt: formats[0], via: it.client };
      }

      const jsUrl = this.extras?.playerJsUrl;
      if (jsUrl) {
        try {
          const baseJs = await (await fetch(jsUrl)).text();
          const cands = (pr?.streamingData?.adaptiveFormats || [])
            .filter(
              (f) => f.signatureCipher && (f.mimeType || "").startsWith("audio/")
            )
            .sort(
              (a, b) => (b.bitrate || b.averageBitrate || 0) - (a.bitrate || a.averageBitrate || 0)
            );
          for (const f of cands) {
            const solved = VocalisCipher.solve(baseJs, f.signatureCipher);
            if (solved) return { fmt: { ...f, url: solved.url }, via: "déchiffrement" };
          }
        } catch {
          /* déchiffrement indisponible */
        }
      }

      return { fmt: null };
    }

    /* ---------------------------------------------------------- */
    /* Pipeline                                                    */
    /* ---------------------------------------------------------- */

    async start() {
      this.running = true;

      this.phase("response");
      const payload = await this.getPlayerResponse();
      if (this.aborted) return;
      const pr = payload?.pr;
      this.extras = payload || {};
      if (!pr?.videoDetails?.videoId) {
        this.hooks.onError && this.hooks.onError("Impossible de lire le lecteur YouTube.");
        return;
      }
      if (pr.videoDetails.isLive) {
        this.hooks.onError && this.hooks.onError("Les directs ne sont pas encore gérés (v0.3).");
        return;
      }
      const { fmt, via } = await this.resolveAudioSource(pr);
      if (!fmt) {
        this.hooks.onError &&
          this.hooks.onError(
            "Aucun flux audio utilisable (couches testées : page, innertube, déchiffrement). " +
              "Vidéo protégée, ou YouTube a changé ses verrous — signale-le avec ce message."
          );
        return;
      }
      this.via = via;
      this.videoId = pr.videoDetails.videoId;

      /* Téléchargement */
      this.phase("download", 0);
      let arrayBuf;
      try {
        const resp = await fetch(fmt.url);
        if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status);
        const total = parseInt(resp.headers.get("content-length") || "0", 10);
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (this.aborted) return;
          chunks.push(value);
          received += value.length;
          if (total) this.phase("download", Math.round((received / total) * 100), { received, total });
        }
        arrayBuf = await new Blob(chunks).arrayBuffer();
      } catch {
        this.hooks.onError && this.hooks.onError("Téléchargement de l'audio impossible.");
        return;
      }
      if (this.aborted) return;

      /* Décodage */
      this.phase("decode");
      let decoded;
      const probe = new AudioContext();
      try {
        decoded = await probe.decodeAudioData(arrayBuf);
      } catch {
        this.hooks.onError && this.hooks.onError("Décodage de l'audio impossible.");
        return;
      } finally {
        probe.close();
      }
      if (this.aborted) return;
      this.duration = decoded.duration;
      this.nChunks = Math.max(1, Math.ceil(this.duration / CHUNK));
      this.cacheEnabled = this.nChunks * CHUNK * SR * 2 * 2 <= CACHE_CAP;

      /* 44,1 kHz stéréo */
      this.phase("resample");
      let left, right;
      if (decoded.sampleRate === SR && decoded.numberOfChannels >= 2) {
        left = decoded.getChannelData(0);
        right = decoded.getChannelData(1);
      } else if (decoded.numberOfChannels === 1) {
        const off = new OfflineAudioContext(2, Math.ceil(decoded.duration * SR), SR);
        const src = off.createBufferSource();
        src.buffer = decoded;
        src.connect(off.destination);
        src.start();
        const rendered = await off.startRendering();
        left = rendered.getChannelData(0);
        right = left;
        decoded = null;
      } else {
        const off = new OfflineAudioContext(2, Math.ceil(decoded.duration * SR), SR);
        const src = off.createBufferSource();
        src.buffer = decoded;
        src.connect(off.destination);
        src.start();
        const rendered = await off.startRendering();
        left = rendered.getChannelData(0);
        right = rendered.getChannelData(1);
        decoded = null;
      }
      if (this.aborted) return;
      this.audio44 = { left, right };

      /* Worker IA */
      this.phase("model");
      await this.initWorker().catch(() => {});
      if (this.aborted || this.fatal) return;

      /* Pré-chargement : traiter jusqu'à PRELOAD_S puis lancer la lecture */
      this.phase("prepare", 0);
      await new Promise((resolve) => {
        this.preloadResolve = resolve;
        this.setPriority(0);
      });
      if (this.aborted) return;

      this.started = true;
      this.hooks.onReady && this.hooks.onReady(this.duration);
    }

    initWorker() {
      return new Promise((resolve, reject) => {
        const w = new Worker(chrome.runtime.getURL("content/worker.js"), { type: "module" });
        this.worker = w;
        w.onmessage = (e) => this.onWorkerMessage(e.data, resolve);
        w.onerror = (e) => {
          this.fatal = true;
          this.hooks.onError &&
            this.hooks.onError("Échec du moteur IA : " + (e.message || "worker"));
          reject(e);
        };
        w.postMessage({ type: "init" });
      });
    }

    onWorkerMessage(msg, initResolve) {
      if (this.aborted) return;
      if (msg.type === "model-download") {
        this.phase("model", msg.pct, msg);
      } else if (msg.type === "ready") {
        this.workerReady = true;
        initResolve && initResolve();
      } else if (msg.type === "done") {
        this.onChunkDone(msg.index, new Float32Array(msg.left), new Float32Array(msg.right));
        } else if (msg.type === "error") {
        if (!this.workerReady) {
          this.hooks.onError && this.hooks.onError("Échec du modèle IA : " + msg.message);
          initResolve && initResolve(); // débloque start(), qui verra started=false
          this.fatal = true;
          return;
        }
        // Échec sur un bloc : on le saute (trou de son ponctuel).
        const idx = this.currentProcessing;
        this.pending.delete(idx);
        this.currentProcessing = null;
        this.workerBusy = false;
        this.pump();
      }
    }

    /* ---------------- File de traitement ---------------- */

    setPriority(fromIdx) {
      const wanted = [];
      for (let i = fromIdx; i < this.nChunks; i++) {
        if (!this.processed.has(i) && !this.pending.has(i) && i !== this.currentProcessing) {
          wanted.push(i);
        }
      }
      this.queue = wanted;
      this.pump();
    }

    pump() {
      if (this.workerBusy || !this.workerReady || !this.queue.length) return;
      const idx = this.queue.shift();
      if (this.processed.has(idx)) { this.pump(); return; }
      this.workerBusy = true;
      this.currentProcessing = idx;

      const start = idx * CHUNK * SR;
      const len = Math.min(CHUNK * SR, this.audio44.left.length - start);
      const left = new Float32Array(this.audio44.left.subarray(start, start + len));
      const right = new Float32Array(this.audio44.right.subarray(start, start + len));
      this.pending.set(idx, true);
      this.worker.postMessage(
        { type: "process", index: idx, left: left.buffer, right: right.buffer },
        [left.buffer, right.buffer]
      );
    }

    onChunkDone(idx, left, right) {
      this.pending.delete(idx);
      this.currentProcessing = null;
      this.workerBusy = false;

      /* PCM16 entrelacé */
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

      /* Pré-chargement atteint ? */
      if (this.preloadResolve) {
        const ready = this.processed.size * CHUNK;
        this.phase("prepare", Math.min(100, Math.round((ready / PRELOAD_S) * 100)));
        if (ready >= PRELOAD_S || this.processed.size >= this.nChunks) {
          const r = this.preloadResolve;
          this.preloadResolve = null;
          r();
        }
      }

      /* Tout est traité : libère les masters */
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

    /* ---------------- Lecture des blocs traités ---------------- */

    lastIndex() { return this.nChunks - 1; }

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
      const iMax = Math.min(this.lastIndex(), Math.floor((t0 + SCHEDULE_AHEAD) / CHUNK));
      const ctx0 = this.ctx.currentTime + 0.08;
      this.base = { ctx0, vid0: t0 };

      for (let i = i0; i <= iMax; i++) {
        if (!this.processed.has(i)) continue; // zone pas prête : trou assumé + stall géré
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

    onVideoEvent = (ev) => {
      if (!this.active) return;
      switch (ev.type) {
        case "play":
          this.stalled = false;
          this.setPriority(Math.floor(this.video.currentTime / CHUNK));
          if (this.video.playbackRate === 1) this.reschedule();
          break;
        case "seeked":
          this.setPriority(Math.floor(this.video.currentTime / CHUNK));
          if (this.video.playbackRate === 1 && !this.stalled) this.reschedule();
          break;
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
                this.hooks.onNotice("Vitesse ≠ ×1 : son original rétabli (pas de time-stretch en v0.3).");
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

    async activate() {
      if (!this.started || this.active) return;
      if (this.video.playbackRate !== 1) {
        this.hooks.onNotice && this.hooks.onNotice("Vitesse ≠ ×1 : son original (v0.3).");
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

        /* Zone non traitée sous la tête de lecture → écran « traitement » */
        const cur = Math.floor(this.video.currentTime / CHUNK);
        if (!this.processed.has(cur)) {
          this.stopSources();
          this.setPriority(cur);
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
        via: this.via || null,
        processedPct: this.nChunks ? Math.round((this.processed.size / this.nChunks) * 100) : 0,
      };
    }

    destroy() {
      this.aborted = true;
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
