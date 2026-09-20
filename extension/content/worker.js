/**
 * Vocalis — worker IA + streaming incrémental (v0.4)
 *
 * Deux rôles :
 *  1. Séparation voix/musique : HTDemucs ONNX (demucs-web, MIT) via
 *     onnxruntime-web (WebGPU puis WASM). Modèle ~172 Mo téléchargé une
 *     fois depuis Hugging Face, mis en cache IndexedDB.
 *  2. Pipeline incrémental (mode par défaut) : télécharge le flux m4a par
 *     tranches, démultiplexe (mp4box.js), décode (WebCodecs), sépare chaque
 *     bloc de 30 s dès qu'il existe et renvoie les voix au moteur.
 *
 * Messages reçus :
 *  - { type:"init" }
 *  - { type:"stream", url, fromTime, skip[] }      démarre le flux incrémental
 *  - { type:"stream-restart", url, fromTime, skip[] }  reprend à fromTime
 *  - { type:"stream-stop" }
 *  - { type:"process", index, left, right }        (chemin legacy)
 * Messages émis : ready, model-download, stream-download, done, stream-error,
 * error.
 */

import * as ort from "../lib/ort/ort.webgpu.min.mjs";
import { DemucsProcessor } from "../lib/demucs-web/processor.js";
import "../content/streamer.js"; // expose self.VocalisStreamer

ort.env.wasm.wasmPaths = {
  mjs: new URL("../lib/ort/ort-wasm-simd-threaded.jsep.mjs", import.meta.url).href,
  wasm: new URL("../lib/ort/ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href,
};
const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
ort.env.wasm.numThreads = Math.min(8, cores);
ort.env.wasm.simd = true;
ort.env.logLevel = "error";

const MODEL_URL =
  "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx";
const MODEL_ID = "htdemucs_embedded_v1";
const SEG_S = 7.8;

const post = (msg, transfer = []) => self.postMessage(msg, transfer);
const log = (msg) => post({ type: "log", msg });

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunk = 8192;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/* ---------------- Cache IndexedDB du modèle ---------------- */

function openModelDB() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open("vocalis-model", 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains("model")) {
        db.createObjectStore("model", { keyPath: "id" });
      }
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function getCachedModel() {
  const db = await openModelDB();
  return await new Promise((resolve) => {
    const rq = db.transaction("model", "readonly").objectStore("model").get(MODEL_ID);
    rq.onsuccess = () => resolve(rq.result?.buf || null);
    rq.onerror = () => resolve(null);
  });
}

async function putCachedModel(buf) {
  const db = await openModelDB();
  return await new Promise((resolve) => {
    const tx = db.transaction("model", "readwrite");
    tx.objectStore("model").put({ id: MODEL_ID, buf });
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

async function downloadModel() {
  const resp = await fetch(MODEL_URL);
  if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status);
  const total = parseInt(resp.headers.get("content-length") || "0", 10);
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) {
      post({ type: "model-download", pct: Math.round((received / total) * 100), received, total });
    }
  }
  return await new Blob(chunks).arrayBuffer();
}

/* ---------------- Séparation ---------------- */

let processor = null;
let doneCount = 0;
let backend = "webgpu";
let adapterInfo = null;
let firstSep = true;
let readyPromise = null;

function ensureReady() {
  if (processor) return Promise.resolve();
  if (readyPromise) return readyPromise;
  readyPromise = doEnsureReady().catch((err) => {
    readyPromise = null;
    throw err;
  });
  return readyPromise;
}

async function doEnsureReady() {
  /* 1 — fichier local fourni avec l'extension (TELECHARGER_MODELE.bat) */
  let buf = null;
  let source = null;
  try {
    const local = await fetch(new URL("../models/htdemucs_embedded.onnx", import.meta.url).href);
    if (local.ok && (local.headers.get("content-length") === null ||
        parseInt(local.headers.get("content-length"), 10) > 1_000_000)) {
      buf = await local.arrayBuffer();
      source = "dossier local";
    }
  } catch { /* pas de fichier local */ }

  /* 2 — cache navigateur (IndexedDB) */
  if (!buf) { buf = await getCachedModel(); if (buf) source = "cache navigateur"; }
  if (buf) {
    post({ type: "model-download", pct: 100, cached: true });
  } else {
    /* 3 — téléchargement Hugging Face (une seule fois) */
    source = "Hugging Face";
    buf = await downloadModel();
    await putCachedModel(buf).catch(() => {});
  }
  log("modèle chargé depuis : " + source + " (" + Math.round(buf.byteLength / 1048576) + " Mo)");

  const t0 = performance.now();
  let useWebGPU = false;

  // 1. Détection adaptateur WebGPU (haute performance, discret / NVIDIA RTX)
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter) {
        ort.env.webgpu.adapter = adapter;
        ort.env.webgpu.powerPreference = "high-performance";
        const info = adapter.info || {};
        adapterInfo = info.description || info.device || info.architecture || "GPU haute performance";
        log("Accélération matérielle détectée : " + adapterInfo + (info.vendor ? " (" + info.vendor + ")" : ""));
        useWebGPU = true;
      } else {
        log("Adaptateur GPU non renvoyé par le navigateur (requestAdapter=null)");
      }
    } catch (e) {
      log("Vérification GPU : " + (e?.message || e));
    }
  } else {
    log("WebGPU non disponible dans le contexte Worker");
  }

  // 2. Initialisation WebGPU explicite
  if (useWebGPU) {
    try {
      processor = new DemucsProcessor({
        ort,
        sessionOptions: {
          executionProviders: ["webgpu", "wasm"],
          graphOptimizationLevel: "all",
          enableCpuMemArena: true,
          enableMemPattern: true,
        },
      });
      await processor.loadModel(buf);
      backend = "webgpu";
      log(`Session IA prête en ${Math.round(performance.now() - t0)} ms — WebGPU ACTIF (${adapterInfo || "GPU"})`);
    } catch (gpuErr) {
      log(`WebGPU a échoué (${gpuErr?.message || gpuErr}) -> bascule sur CPU WASM…`);
      useWebGPU = false;
    }
  }

  // 3. Repli WASM multi-cœurs
  if (!useWebGPU) {
    const threadCount = ort.env.wasm.numThreads || 4;
    processor = new DemucsProcessor({
      ort,
      sessionOptions: {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
        enableCpuMemArena: true,
        enableMemPattern: true,
      },
    });
    await processor.loadModel(buf);
    backend = "wasm";
    log(`Session IA prête en ${Math.round(performance.now() - t0)} ms — Mode CPU WASM (${threadCount} cœurs)`);
  }
}

/* File de segments à séparer (arrivée au fil de l'eau) */
const segQueue = [];
let separating = false;
const skip = new Set();

async function pumpSeg() {
  if (separating || !processor || !segQueue.length) return;
  separating = true;
  const { idx, L, R } = segQueue.shift();
  try {
    if (!skip.has(idx)) {
      const t0 = performance.now();
      const res = await processor.separate(L, R, { vocalsOnly: true });
      const dt = Math.round(performance.now() - t0);
      const audioSec = (L.length / 44100).toFixed(1);
      const speedX = (audioSec / (dt / 1000)).toFixed(1);
      if (firstSep) {
        firstSep = false;
        log(`1er bloc (${audioSec} s) séparé en ${dt} ms [${backend.toUpperCase()}] — vitesse ${speedX}× temps réel`);
      }
      doneCount++;
      post(
        { type: "done", index: idx, left: res.vocals.left.buffer, right: res.vocals.right.buffer, backend, dt },
        [res.vocals.left.buffer, res.vocals.right.buffer]
      );
    }
  } catch (err) {
    post({ type: "error", message: String((err && err.message) || err) });
  }
  separating = false;
  pumpSeg();
}

/* ---------------- Streaming incrémental ---------------- */

let streamer = null;

function startStream(url, fromTime, skipList, ua) {
  log("flux incrémental démarré à " + Math.round(fromTime) + " s");
  skip.clear();
  for (const i of skipList || []) skip.add(i);
  streamer?.destroy();
  streamer = new self.VocalisStreamer(url, {
    ua,
    onDownload: (pct, seconds) => post({ type: "stream-download", pct, seconds }),
    onSegment: (idx, L, R) => {
      segQueue.push({ idx, L: new Float32Array(L), R: new Float32Array(R) });
      pumpSeg();
    },
    onError: (message) => post({ type: "stream-error", message }),
  });
  streamer.processedSecondsGetter = () => doneCount * SEG_S;
  streamer.run(fromTime).then(() => {
    if (streamer) streamer.flushTail();
  });
}

/* ---------------- Boucle de messages ---------------- */

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      await ensureReady();
      post({ type: "ready", backend, gpu: adapterInfo });
      pumpSeg();
    } else if (msg.type === "stream") {
      ensureReady()
        .then(() => {
          post({ type: "ready", backend, gpu: adapterInfo });
          pumpSeg();
        })
        .catch((e) => {
          post({ type: "error", message: String((e && e.message) || e) });
        });
      startStream(msg.url, msg.fromTime || 0, msg.skip, msg.ua);
    } else if (msg.type === "stream-restart") {
      segQueue.length = 0;
      startStream(msg.url, msg.fromTime || 0, msg.skip, msg.ua);
    } else if (msg.type === "stream-stop") {
      streamer?.destroy();
      streamer = null;
    } else if (msg.type === "process") {
      if (!processor) await ensureReady();
      const leftBuf = msg.leftB64 ? base64ToArrayBuffer(msg.leftB64) : (msg.left instanceof ArrayBuffer ? msg.left : null);
      const rightBuf = msg.rightB64 ? base64ToArrayBuffer(msg.rightB64) : (msg.right instanceof ArrayBuffer ? msg.right : null);
      if (!leftBuf || leftBuf.byteLength === 0) {
        throw new Error("Tampon audio vide reçu par l'IA");
      }
      const left = new Float32Array(leftBuf);
      const right = new Float32Array(rightBuf);
      const audioSec = (left.length / 44100).toFixed(1);
      const t0 = performance.now();
      const res = await processor.separate(left, right, { vocalsOnly: true });
      const dt = Math.round(performance.now() - t0);
      const speedX = (parseFloat(audioSec) / (dt / 1000)).toFixed(1);
      doneCount++;
      log(`IA : bloc ${msg.index + 1} (${audioSec} s) terminé en ${dt} ms [${backend.toUpperCase()}] — vitesse ${speedX}× temps réel`);
      const leftResB64 = arrayBufferToBase64(res.vocals.left.buffer);
      const rightResB64 = arrayBufferToBase64(res.vocals.right.buffer);
      post({
        type: "done",
        index: msg.index,
        left: res.vocals.left.buffer,
        right: res.vocals.right.buffer,
        leftB64: leftResB64,
        rightB64: rightResB64,
        backend,
        dt,
      });
    }
  } catch (err) {
    post({ type: "error", where: msg?.type, message: String((err && err.message) || err) });
  }
};
