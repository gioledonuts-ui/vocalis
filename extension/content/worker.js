/**
 * Vocalis — worker de séparation voix/musique (v0.3)
 *
 * Fait tourner HTDemucs exporté en ONNX (demucs-web, MIT) via
 * onnxruntime-web : WebGPU en priorité, repli WASM.
 *
 * Le modèle (~172 Mo) est téléchargé UNE fois depuis Hugging Face puis
 * conservé dans IndexedDB : les fois suivantes, il charge depuis le PC.
 * Jamais stocké dans git, jamais envoyé ailleurs.
 *
 * Messages reçus :
 *  - { type:"init" }                     → charge le modèle, répond "ready"
 *  - { type:"process", index, left, right } (Float32 44,1 kHz stéréo, transférés)
 *      → répond { type:"done", index, left, right } (voix seule, transférés)
 * Messages émis aussi : "model-download" (progression %), "error".
 */

import * as ort from "../lib/ort/ort.webgpu.min.mjs";
import { DemucsProcessor } from "../lib/demucs-web/processor.js";

ort.env.wasm.wasmPaths = new URL("../lib/ort/", import.meta.url).href;
ort.env.logLevel = "error";

const MODEL_URL =
  "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx";
const MODEL_ID = "htdemucs_embedded_v1";

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

/* ---------------- Téléchargement avec progression ---------------- */

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

/* ---------------- Session ONNX ---------------- */

let processor = null;

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
    await processor.loadModel(buf); // EP par défaut : webgpu puis wasm
  } catch (err) {
    // Repli explicite WASM seul (machines sans WebGPU).
    processor = new DemucsProcessor({
      ort,
      sessionOptions: { executionProviders: ["wasm"], graphOptimizationLevel: "basic" },
    });
    await processor.loadModel(buf);
  }
}

/* ---------------- Boucle de messages ---------------- */

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      await ensureReady();
      post({ type: "ready" });
    } else if (msg.type === "process") {
      if (!processor) throw new Error("modèle non chargé");
      const left = new Float32Array(msg.left);
      const right = new Float32Array(msg.right);
      const res = await processor.separate(left, right);
      post(
        { type: "done", index: msg.index, left: res.vocals.left.buffer, right: res.vocals.right.buffer },
        [res.vocals.left.buffer, res.vocals.right.buffer]
      );
    }
  } catch (err) {
    post({ type: "error", where: msg?.type, message: String((err && err.message) || err) });
  }
};
