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

ort.env.wasm.wasmPaths = new URL("../lib/ort/", import.meta.url).href;
ort.env.logLevel = "error";

const MODEL_URL =
  "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx";
const MODEL_ID = "htdemucs_embedded_v1";
const SEG_S = 10;

const post = (msg, transfer = []) => self.postMessage(msg, transfer);

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
let initStarted = false;

async function ensureReady() {
  if (processor) return;
  let buf = await getCachedModel();
  if (!buf) {
    buf = await downloadModel();
    await putCachedModel(buf).catch(() => {});
  } else {
    post({ type: "model-download", pct: 100, cached: true });
  }
  processor = new DemucsProcessor({ ort });
  try {
    await processor.loadModel(buf);
  } catch {
    processor = new DemucsProcessor({
      ort,
      sessionOptions: { executionProviders: ["wasm"], graphOptimizationLevel: "basic" },
    });
    await processor.loadModel(buf);
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
      const res = await processor.separate(L, R);
      doneCount++;
      post(
        { type: "done", index: idx, left: res.vocals.left.buffer, right: res.vocals.right.buffer },
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

function startStream(url, fromTime, skipList) {
  skip.clear();
  for (const i of skipList || []) skip.add(i);
  streamer?.destroy();
  streamer = new self.VocalisStreamer(url, {
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
      post({ type: "ready" });
      pumpSeg();
    } else if (msg.type === "stream" && !processor && !initStarted) {
      initStarted = true;
      ensureReady().then(() => { post({ type: "ready" }); pumpSeg(); }).catch((e) => {
        post({ type: "error", message: String((e && e.message) || e) });
      });
      startStream(msg.url, msg.fromTime || 0, msg.skip);
    } else if (msg.type === "stream") {
      startStream(msg.url, msg.fromTime || 0, msg.skip);
    } else if (msg.type === "stream-restart") {
      segQueue.length = 0;
      startStream(msg.url, msg.fromTime || 0, msg.skip);
    } else if (msg.type === "stream-stop") {
      streamer?.destroy();
      streamer = null;
    } else if (msg.type === "process") {
      if (!processor) throw new Error("modèle non chargé");
      const left = new Float32Array(msg.left);
      const right = new Float32Array(msg.right);
      const res = await processor.separate(left, right);
      doneCount++;
      post(
        { type: "done", index: msg.index, left: res.vocals.left.buffer, right: res.vocals.right.buffer },
        [res.vocals.left.buffer, res.vocals.right.buffer]
      );
    }
  } catch (err) {
    post({ type: "error", where: msg?.type, message: String((err && err.message) || err) });
  }
};
