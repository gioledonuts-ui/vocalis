/**
 * Vocalis — moteur audio v0.2 (pipeline complet, SANS modèle de séparation)
 *
 * Étapes :
 *  1. Récupère le playerResponse via le pont main-world (bridge.js) ;
 *  2. Choisit le meilleur flux audio adaptatif (le plus haut débit) ;
 *  3. Le télécharge (progression en streaming) ;
 *  4. Le décode (decodeAudioData) ;
 *  5. Le découpe en segments de 10 s (PCM 16 bits) → mémoire + IndexedDB ;
 *  6. Rejoue le son via Web Audio, vidéo en sourdine, synchronisation
 *     permanente sur video.currentTime (seek, pause, mise en tampon…).
 *
 * En v0.2 le « traitement » est l'identité (son original) : on valide toute
 * la tuyauterie. En v0.3, un modèle ONNX s'insérera entre l'étape 4 et 5.
 *
 * Limites connues de la v0.2 (documentées) :
 *  - décodage complet en mémoire : vidéos très longues (> 2 h) gourmandes ;
 *  - vitesse de lecture ≠ 1 : on repasse au son original (pas de time-stretch) ;
 *  - directs (lives) non gérés.
 */

self.VocalisEngine = (() => {
  "use strict";

  const SEG = 10;                 // durée d'un segment (s)
  const SCHEDULE_AHEAD = 45;      // secondes d'audio programmées d'avance
  const MEM_WINDOW = 120;         // segments gardés en RAM (~20 min)
  const CACHE_CAP = 1_500_000_000; // plafond IndexedDB par vidéo (~1,5 Go)
  const DRIFT_MAX = 0.09;         // écart audio/vidéo toléré avant re-sync (s)

  class Engine {
    constructor(video, hooks = {}) {
      this.video = video;
      this.hooks = hooks;

      this.aborted = false;
      this.running = false;   // un start() est en cours
      this.started = false;   // pipeline terminé, segments prêts
      this.active = false;    // relecture par Vocalis en cours
      this.stalled = false;   // vidéo en tampon (« waiting »)
      this.rateNoticeShown = false;

      this.videoId = null;
      this.duration = 0;
      this.sampleRate = 48000;
      this.channels = 2;

      this.mem = new Map();     // index -> Int16Array (PCM entrelacé)
      this.buffers = new Map(); // index -> AudioBuffer (pour Web Audio)

      this.ctx = null;
      this.gain = null;
      this.sources = [];
      this.base = null;         // { ctx0, vid0 } pour le contrôle de dérive
      this.gen = 0;             // garde anti-reschedules concurrents
      this.watchdog = null;

      this.cacheEnabled = true;
      this._bound = null;
    }

    /* ---------------------------------------------------------- */
    /* Pipeline                                                    */
    /* ---------------------------------------------------------- */

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

    async start() {
      this.running = true;
      /* 1 — playerResponse */
      this.phase("response");
      const pr = await this.getPlayerResponse();
      if (this.aborted) return;
      if (!pr?.videoDetails?.videoId) {
        this.hooks.onError && this.hooks.onError("Impossible de lire le lecteur YouTube.");
        return;
      }
      if (pr.videoDetails.isLive) {
        this.hooks.onError &&
          this.hooks.onError("Les directs ne sont pas encore gérés (v0.2).");
        return;
      }

      /* 2 — format audio */
      const fmt = this.pickFormat(pr);
      if (!fmt) {
        this.hooks.onError &&
          this.hooks.onError("Aucun flux audio accessible (vidéo protégée ?).");
        return;
      }
      this.videoId = pr.videoDetails.videoId;

      /* 3 — téléchargement (progression réelle) */
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
          if (total) {
            this.phase("download", Math.round((received / total) * 100), { received, total });
          }
        }
        arrayBuf = await new Blob(chunks).arrayBuffer();
      } catch (err) {
        this.hooks.onError && this.hooks.onError("Téléchargement de l'audio impossible.");
        return;
      }
      if (this.aborted) return;

      /* 4 — décodage */
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
      this.sampleRate = decoded.sampleRate;
      this.channels = decoded.numberOfChannels;

      /* 5 — découpage en segments PCM16 + cache */
      this.phase("prepare", 0);
      const n = Math.max(1, Math.ceil(this.duration / SEG));
      const segBytes = SEG * this.sampleRate * this.channels * 2;
      this.cacheEnabled = n * segBytes <= CACHE_CAP;

      const chans = [];
      for (let c = 0; c < this.channels; c++) chans.push(decoded.getChannelData(c));
      const totalSamples = chans[0].length;
      decoded = null; // libère au plus tôt

      for (let i = 0; i < n; i++) {
        if (this.aborted) return;
        const off0 = Math.round(i * SEG * this.sampleRate);
        const len = Math.min(Math.round(SEG * this.sampleRate), totalSamples - off0);
        if (len <= 0) break;
        const pcm = new Int16Array(len * this.channels);
        let p = 0;
        for (let s = 0; s < len; s++) {
          for (let c = 0; c < this.channels; c++) {
            const v = chans[c][off0 + s];
            pcm[p++] = v < -1 ? -32768 : v > 1 ? 32767 : Math.round(v * 32767);
          }
        }
        this.mem.set(i, pcm);
        if (this.cacheEnabled) {
          // Écriture IndexedDB en arrière-plan (le segment reste en RAM).
          VocalisIDB.put({
            key: `${this.videoId}:${i}`,
            videoId: this.videoId,
            index: i,
            pcm,
            sampleRate: this.sampleRate,
            channels: this.channels,
          }).catch(() => { this.cacheEnabled = false; });
        }
        if (i % 5 === 0) {
          this.phase("prepare", Math.round(((i + 1) / n) * 100));
          await new Promise((r) => setTimeout(r, 0)); // laisse respirer l'UI
        }
      }
      if (this.aborted) return;

      this.started = true;
      this.hooks.onReady && this.hooks.onReady(this.duration);
    }

    /* ---------------------------------------------------------- */
    /* Relecture synchronisée                                      */
    /* ---------------------------------------------------------- */

    lastIndex() {
      return Math.max(0, Math.ceil(this.duration / SEG) - 1);
    }

    async bufferFor(i) {
      const cached = this.buffers.get(i);
      if (cached) return cached;

      let pcm = this.mem.get(i);
      let sampleRate = this.sampleRate;
      let channels = this.channels;
      if (!pcm && this.cacheEnabled) {
        const rec = await VocalisIDB.get(`${this.videoId}:${i}`).catch(() => null);
        if (rec) {
          pcm = rec.pcm;
          sampleRate = rec.sampleRate;
          channels = rec.channels;
          this.mem.set(i, pcm);
        }
      }
      if (!pcm) return null;

      const len = Math.floor(pcm.length / channels);
      const buf = this.ctx.createBuffer(channels, len, sampleRate);
      for (let c = 0; c < channels; c++) {
        const out = buf.getChannelData(c);
        for (let s = 0; s < len; s++) out[s] = pcm[s * channels + c] / 32768;
      }
      this.buffers.set(i, buf);
      this.trimMemory();
      return buf;
    }

    trimMemory() {
      if (this.mem.size <= MEM_WINDOW) return;
      const center = Math.floor((this.video.currentTime || 0) / SEG);
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
      const i0 = Math.max(0, Math.floor(t0 / SEG));
      const iMax = Math.min(this.lastIndex(), Math.floor((t0 + SCHEDULE_AHEAD) / SEG));
      const ctx0 = this.ctx.currentTime + 0.08;
      this.base = { ctx0, vid0: t0 };

      for (let i = i0; i <= iMax; i++) {
        const buf = await this.bufferFor(i);
        if (g !== this.gen || !this.active || this.video.paused) return;
        if (!buf) continue; // segment pas encore prêt : trou (v0.2 : rare)
        const segStart = i * SEG;
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
        case "seeked":
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
          // La vidéo bufferise : on coupe le son remplacé, il repartira
          // tout seul sur « playing ».
          this.stalled = true;
          this.stopSources();
          break;
        case "ratechange":
          if (this.video.playbackRate !== 1) {
            // Pas de time-stretch en v0.2 : on rend le son original
            // (surtout pas un écran muet pendant la vitesse ×2).
            this.stopSources();
            this.video.muted = false;
            if (!this.rateNoticeShown) {
              this.rateNoticeShown = true;
              this.hooks.onNotice &&
                this.hooks.onNotice(
                  "Vitesse ≠ ×1 : son original rétabli (pas encore de time-stretch en v0.2)."
                );
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
        this.hooks.onNotice &&
          this.hooks.onNotice("Vitesse ≠ ×1 : son original (v0.2).");
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
        if (this.video.playbackRate !== 1) return; // géré par ratechange
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

    /* ---------------------------------------------------------- */

    status() {
      return {
        started: this.started,
        active: this.active,
        videoId: this.videoId,
        duration: this.duration,
      };
    }

    destroy() {
      this.aborted = true;
      this.deactivate();
      this.mem.clear();
      this.buffers.clear();
    }
  }

  return Engine;
})();
