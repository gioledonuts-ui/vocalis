/**
 * Vocalis — pipeline incrémental MP4 (v0.4)
 *
 * Vit DANS le worker (content/worker.js) : un content script MV3 ne peut pas
 * charger de modules ES, mais un worker module, si.
 *
 * Au lieu de télécharger+décoder TOUT l'audio avant de commencer (v0.3) :
 *  - on télécharge le flux audio m4a par tranches de 4 Mo (Range requests) ;
 *  - mp4box.js démultiplexe au fil de l'eau ;
 *  - WebCodecs (AudioDecoder) décode les paquets AAC dès qu'ils arrivent ;
 *  - on assemble des segments de 30 s qui partent immédiatement au worker IA.
 *
 * Résultat : la lecture démarre après ~30 s de voix prêtes, le reste suit en
 * arrière-plan, et le téléchargement est borné (quelques minutes d'avance)
 * pour ne pas affamer la vidéo YouTube qui se charge en même temps.
 *
 * Toute erreur ici renvoie onError : le moteur bascule alors sur le chemin
 * « legacy » (téléchargement complet), qui reste le filet de sécurité.
 */

import * as MP4Box from "../lib/mp4box/mp4box.all.mjs";

self.VocalisStreamer = (() => {
  "use strict";

  const RANGE = 1024 * 1024;          // taille d'une tranche (1 Mo borné, accepté par tous les CDN)
  const SEG = 10;                     // durée d'un segment émis (s)
  const SR = 44100;                   // fréquence native de l'itag 140
  const LOOKAHEAD_S = 90;             // avance max de téléchargement sur le traitement

  /**
   * Synthétise un AudioSpecificConfig (2 octets, ISO 14496-3) pour AAC-LC
   * si la boîte esds de l'atome moov MP4 ne l'expose pas directement.
   */
  function makeAudioSpecificConfig(sampleRate, channels) {
    const freqs = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    ];
    let sfi = freqs.indexOf(sampleRate);
    if (sfi === -1) sfi = 4; // 44100 Hz par défaut
    const aot = 2; // AAC-LC
    const byte1 = (aot << 3) | ((sfi >> 1) & 0x07);
    const byte2 = ((sfi & 0x01) << 7) | ((channels & 0x0f) << 3);
    return new Uint8Array([byte1, byte2]);
  }

  class Streamer {
    constructor(url, hooks) {
      this.url = url;
      this.hooks = hooks;
      this.dead = false;
      this.total = 0;
      this.bps = 0;
      this.downloaded = 0;
      this.mp4 = null;
      this.decoder = null;
      this.decoderDone = false;
      this.ctl = null;

      this.segIdx = 0;
      this.segPos = 0;
      this.bufL = new Float32Array(SEG * SR);
      this.bufR = new Float32Array(SEG * SR);

      this.processedSecondsGetter = () => 0;
    }

    /* ---------------- démarrage ---------------- */

    async run(fromTime = 0) {
      this.segIdx = Math.floor(fromTime / SEG);
      this.segPos = Math.round((fromTime - this.segIdx * SEG) * SR);

      this.mp4 = MP4Box.createFile();
      this.mp4.onError = (e) => {
        if (!this.dead) this.hooks.onError && this.hooks.onError("Démultiplexage : " + e);
      };
      this.mp4.onReady = (info) => this._onReady(info);
      this.mp4.onSamples = (id, user, samples) => this._onSamples(samples);

      /* 1re tranche : elle contient le moov (index du fichier) */
      let first;
      try {
        first = await this._fetchRange(0, RANGE - 1);
      } catch (e) {
        if (!this.dead) this.hooks.onError &&
          this.hooks.onError("Première tranche refusée" +
            (e?.message ? " (" + e.message + ")" : "") + ".");
        return;
      }
      if (this.dead) return;
      this.mp4.appendBuffer(first);

      /* Téléchargement séquentiel borné */
      let pos = RANGE;
      while (!this.dead && pos < this.total) {
        /* ne pas affamer la vidéo : avance bornée sur le traitement */
        const downloadedTime = this.bps ? this.downloaded / this.bps : 0;
        if (downloadedTime > this.processedSecondsGetter() + LOOKAHEAD_S) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        const end = Math.min(this.total - 1, pos + RANGE - 1);
        let buf;
        try {
          buf = await this._fetchRange(pos, end);
        } catch (e) {
          if (!this.dead) this.hooks.onError &&
            this.hooks.onError("Téléchargement interrompu" +
              (e?.message ? " (" + e.message + ")" : "") + ".");
          return;
        }
        if (this.dead) return;
        this.mp4.appendBuffer(buf);
        pos = end + 1;
      }
      if (!this.dead && this.mp4) {
        try { this.mp4.flush(); } catch { /* déjà terminé */ }
      }
    }

    async _fetchRange(start, end) {
      this.ctl = new AbortController();
      const timer = setTimeout(() => this.ctl.abort(), 20000); // tranche qui traîne = erreur propre
      const headers = { Range: `bytes=${start}-${end}` };
      const resp = await fetch(this.url, {
        headers,
        signal: this.ctl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok && resp.status !== 206) {
        throw new Error("HTTP " + resp.status + (resp.statusText ? " " + resp.statusText : ""));
      }
      if (!this.total) {
        const cr = resp.headers.get("content-range");
        const m = cr && cr.match(/\/(\d+)$/);
        if (m) this.total = parseInt(m[1], 10);
        const cl = resp.headers.get("content-length");
        if (!this.total && cl) this.total = parseInt(cl, 10);
      }
      const buf = await resp.arrayBuffer();
      buf.fileStart = start;
      this.downloaded += buf.byteLength;
      if (this.total && this.bps) {
        this.hooks.onDownload &&
          this.hooks.onDownload(Math.min(100, Math.round((this.downloaded / this.total) * 100)), this.downloaded / this.bps);
      }
      return buf;
    }

    /* ---------------- démultiplexage + décodage ---------------- */

    _onReady(info) {
      if (this.dead) return;
      const track = info.tracks.find((t) => (t.codec || "").startsWith("mp4a"));
      if (!track) {
        this.hooks.onError && this.hooks.onError("Pas de piste AAC dans ce flux.");
        return;
      }
      this.bps = this.bps || (track.bitrate ? track.bitrate / 8 : this.total / (info.duration || 1));

      const sampleRate = track.audio?.sample_rate || SR;
      const channels = track.audio?.channel_count || 2;

      /* description AAC (AudioSpecificConfig) pour WebCodecs */
      let description;
      try {
        const trak = this.mp4.getTrackById(track.id);
        const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
        const descs = entry?.esds?.esd?.descs || [];
        const dcd = descs.find((d) => d.tag === 3) || entry?.esds?.esd;
        const inner = (dcd?.descs || descs).find((d) => d.tag === 5);
        if (inner?.data) description = inner.data;
      } catch { /* description absente : synthèse ci-dessous */ }

      // Filet de sécurité universel : si la boîte esds est absente/incomplète,
      // on synthétise la config AAC-LC standard (2 octets ISO 14496-3).
      if (!description) {
        description = makeAudioSpecificConfig(sampleRate, channels);
      }

      if (typeof AudioDecoder === "undefined") {
        this.hooks.onError && this.hooks.onError("WebCodecs (AudioDecoder) indisponible.");
        return;
      }

      this.decoder = new AudioDecoder({
        output: (ad) => this._onAudio(ad, sampleRate),
        error: (e) => {
          if (!this.dead) this.hooks.onError && this.hooks.onError("Décodage AAC : " + (e?.message || e));
        },
      });
      try {
        this.decoder.configure({
          codec: track.codec || "mp4a.40.2",
          sampleRate,
          numberOfChannels: channels,
          description,
        });
      } catch (e) {
        this.hooks.onError && this.hooks.onError("Configuration AAC : " + (e?.message || e));
        return;
      }

      this.mp4.setExtractionOptions(track.id, null, { nbSamples: 4096 });
      if (this.segIdx > 0 || this.segPos > 0) {
        try { this.mp4.seek(this.segIdx * SEG + this.segPos / SR, false); } catch { /* départ 0 */ }
      }
      this.mp4.start();
    }

    _onSamples(samples) {
      if (this.dead || !this.decoder) return;
      for (const s of samples) {
        if (this.decoder.state === "closed") return;
        try {
          this.decoder.decode(
            new EncodedAudioChunk({
              type: "key",
              timestamp: (s.cts / s.timescale) * 1e6,
              duration: (s.duration / s.timescale) * 1e6,
              data: s.data,
            })
          );
        } catch {
          /* paquet corrompu : on saute */
        }
      }
    }

    _onAudio(ad, sampleRate) {
      if (this.dead) { ad.close(); return; }
      const frames = ad.numberOfFrames;
      const L = new Float32Array(frames);
      const R = new Float32Array(frames);
      try {
        ad.copyTo(L, { planeIndex: 0 });
        if (ad.numberOfChannels > 1) ad.copyTo(R, { planeIndex: 1 });
        else R.set(L);
      } finally {
        ad.close();
      }
      if (sampleRate !== SR) {
        /* l'itag 140 est 44,1 kHz ; sinon on refuse proprement → legacy */
        this.hooks.onError && this.hooks.onError("Fréquence inattendue : " + sampleRate);
        return;
      }

      let off = 0;
      while (off < frames) {
        const space = this.bufL.length - this.segPos;
        const n = Math.min(space, frames - off);
        this.bufL.set(L.subarray(off, off + n), this.segPos);
        this.bufR.set(R.subarray(off, off + n), this.segPos);
        this.segPos += n;
        off += n;
        if (this.segPos === this.bufL.length) {
          this.hooks.onSegment && this.hooks.onSegment(this.segIdx, this.bufL, this.bufR);
          this.segIdx++;
          this.segPos = 0;
          this.bufL = new Float32Array(SEG * SR);
          this.bufR = new Float32Array(SEG * SR);
        }
      }
    }

    /** Émet le dernier segment partiel (fin de vidéo). */
    flushTail() {
      if (this.segPos > 0 && !this.dead) {
        this.hooks.onSegment && this.hooks.onSegment(this.segIdx, this.bufL, this.bufR);
        this.segPos = 0;
      }
    }

    destroy() {
      this.dead = true;
      if (this.ctl) this.ctl.abort();
      try { this.decoder && this.decoder.state !== "closed" && this.decoder.close(); } catch { /* */ }
      try { this.mp4 && this.mp4.stop(); } catch { /* */ }
      this.decoder = null;
      this.mp4 = null;
    }
  }

  return Streamer;
})();
