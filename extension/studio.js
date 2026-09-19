/**
 * Vocalis Studio — Nettoyeur audio local (voix seules)
 *
 * Fonctionne 100% sur la machine de l'utilisateur :
 * 1. Lit et décode le fichier audio sélectionné (MP3, WAV, etc.) via l'API Web Audio
 * 2. Découpe en segments de 10 s (fréquence Demucs 44,1 kHz)
 * 3. Envoie chaque segment au worker IA (HTDemucs ONNX, WebGPU / RTX)
 * 4. Réassemble les segments de voix pures
 * 5. Encode en fichier WAV 16-bit PCM téléchargeable directement.
 */

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileInfo = document.getElementById("file-info");
const fileNameEl = document.getElementById("file-name");
const fileDetailsEl = document.getElementById("file-details");
const startBtn = document.getElementById("start-btn");
const changeBtn = document.getElementById("change-btn");

const progressCard = document.getElementById("progress-card");
const progressStatus = document.getElementById("progress-status");
const progressPct = document.getElementById("progress-pct");
const progressBarFill = document.getElementById("progress-bar-fill");
const progressSubtext = document.getElementById("progress-subtext");
const progressEta = document.getElementById("progress-eta");

const resultCard = document.getElementById("result-card");
const resultTiming = document.getElementById("result-timing");
const audioPreview = document.getElementById("audio-preview");
const downloadBtn = document.getElementById("download-btn");
const restartBtn = document.getElementById("restart-btn");

const journalLogs = document.getElementById("journal-logs");
const journalToggle = document.getElementById("journal-toggle");
const journalArrow = document.getElementById("journal-arrow");

let currentFile = null;
let currentWorker = null;

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  journalLogs.textContent += line + "\n";
  journalLogs.scrollTop = journalLogs.scrollHeight;
}

journalToggle.addEventListener("click", () => {
  const isHidden = journalLogs.classList.toggle("hidden");
  journalArrow.textContent = isHidden ? "▶" : "▼";
});

/* ---------------- Gestion du glisser-déposer ---------------- */

dropZone.addEventListener("click", () => fileInput.click());

["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
  });
});

dropZone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files?.length) {
    handleFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) {
    handleFile(fileInput.files[0]);
  }
});

changeBtn.addEventListener("click", () => {
  currentFile = null;
  fileInput.value = "";
  fileInfo.classList.add("hidden");
  dropZone.classList.remove("hidden");
});

restartBtn.addEventListener("click", () => {
  resultCard.classList.add("hidden");
  progressCard.classList.add("hidden");
  currentFile = null;
  fileInput.value = "";
  fileInfo.classList.add("hidden");
  dropZone.classList.remove("hidden");
});

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " Ko";
  return (bytes / (1024 * 1024)).toFixed(1) + " Mo";
}

function formatSec(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m} min ${s.toString().padStart(2, "0")} s`;
}

function handleFile(file) {
  currentFile = file;
  dropZone.classList.add("hidden");
  fileInfo.classList.remove("hidden");
  fileNameEl.textContent = file.name;
  fileDetailsEl.textContent = `${formatBytes(file.size)} · Analyse en cours…`;
  log(`Fichier sélectionné : ${file.name} (${formatBytes(file.size)})`);

  // Pré-analyse rapide de la durée audio
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await audioCtx.decodeAudioData(reader.result);
      fileDetailsEl.textContent = `${formatBytes(file.size)} · ${formatSec(decoded.duration)}`;
      audioCtx.close();
    } catch {
      fileDetailsEl.textContent = `${formatBytes(file.size)}`;
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ---------------- Rééchantillonnage 44,1 kHz stéréo ---------------- */

async function toStereo44100(decoded) {
  if (decoded.sampleRate === 44100 && decoded.numberOfChannels === 2) {
    return {
      left: decoded.getChannelData(0),
      right: decoded.getChannelData(1),
      duration: decoded.duration,
    };
  }

  log(`Rééchantillonnage de ${decoded.sampleRate} Hz (${decoded.numberOfChannels} ch) vers 44 100 Hz (stéréo)…`);
  const targetSamples = Math.ceil(decoded.duration * 44100);
  const offlineCtx = new OfflineAudioContext(2, targetSamples, 44100);
  const src = offlineCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offlineCtx.destination);
  src.start(0);
  const resampled = await offlineCtx.startRendering();

  return {
    left: resampled.getChannelData(0),
    right: resampled.getChannelData(1),
    duration: resampled.duration,
  };
}

/* ---------------- Encodeur WAV 16-bit PCM ---------------- */

function audioBufferToWav(left, right, sampleRate) {
  const numChannels = 2;
  const numSamples = left.length;
  const bytesPerSample = 2; // 16 bits
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let sL = Math.max(-1, Math.min(1, left[i]));
    view.setInt16(offset, sL < 0 ? sL * 0x8000 : sL * 0x7fff, true);
    offset += 2;

    let sR = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, sR < 0 ? sR * 0x8000 : sR * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/* ---------------- Pipeline de nettoyage ---------------- */

startBtn.addEventListener("click", async () => {
  if (!currentFile) return;

  startBtn.disabled = true;
  changeBtn.disabled = true;
  progressCard.classList.remove("hidden");
  resultCard.classList.add("hidden");

  progressStatus.textContent = "Décodage de l'audio…";
  progressPct.textContent = "0 %";
  progressBarFill.style.width = "0%";
  progressSubtext.textContent = "Lecture du fichier dans le navigateur…";

  const tStart = performance.now();

  try {
    const arrayBuf = await currentFile.arrayBuffer();
    log(`Décodage audio du fichier (${formatBytes(arrayBuf.byteLength)})…`);
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const rawDecoded = await audioCtx.decodeAudioData(arrayBuf);
    audioCtx.close();

    const { left, right, duration } = await toStereo44100(rawDecoded);
    log(`Audio prêt : ${formatSec(duration)} (${left.length} échantillons à 44,1 kHz)`);

    const SEG_S = 10;
    const SEG_SAMPLES = SEG_S * 44100;
    const totalSamples = left.length;
    const nSegments = Math.ceil(totalSamples / SEG_SAMPLES);

    const outVocalL = new Float32Array(totalSamples);
    const outVocalR = new Float32Array(totalSamples);

    progressStatus.textContent = "Chargement du modèle IA…";
    progressSubtext.textContent = "Initialisation du moteur ONNX (WebGPU/RTX)…";

    // Lance le worker IA standard de Vocalis
    currentWorker?.terminate();
    const worker = new Worker("content/worker.js", { type: "module" });
    currentWorker = worker;

    let modelReady = false;
    let currentSegIdx = 0;

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "log") {
        log(msg.msg);
        if (msg.msg.includes("backend :")) {
          progressSubtext.textContent = msg.msg;
        }
      } else if (msg.type === "model-download") {
        progressPct.textContent = `${msg.pct} %`;
        progressBarFill.style.width = `${msg.pct}%`;
        progressSubtext.textContent = msg.cached
          ? "Modèle chargé depuis le cache/dossier local."
          : `Téléchargement du modèle : ${msg.pct} %`;
      } else if (msg.type === "ready") {
        modelReady = true;
        log(`Modèle IA prêt — début de la séparation (${nSegments} blocs de 10 s)`);
        sendNextSegment();
      } else if (msg.type === "done") {
        const segIdx = msg.index;
        const start = segIdx * SEG_SAMPLES;
        const actualLength = Math.min(SEG_SAMPLES, totalSamples - start);

        const vL = new Float32Array(msg.left).subarray(0, actualLength);
        const vR = new Float32Array(msg.right).subarray(0, actualLength);
        outVocalL.set(vL, start);
        outVocalR.set(vR, start);

        const doneCount = segIdx + 1;
        const pct = Math.min(100, Math.round((doneCount / nSegments) * 100));
        progressBarFill.style.width = `${pct}%`;
        progressPct.textContent = `${pct} %`;
        progressStatus.textContent = `Séparation bloc ${doneCount}/${nSegments} (${pct} %)…`;

        const elapsedSec = (performance.now() - tStart) / 1000;
        const secPerBloc = elapsedSec / doneCount;
        const remainSec = Math.round((nSegments - doneCount) * secPerBloc);
        progressEta.textContent = `Temps restant estimé : ~${remainSec} s`;

        if (currentSegIdx < nSegments) {
          sendNextSegment();
        } else {
          // Tous les blocs terminés !
          finishProcessing();
        }
      } else if (msg.type === "error") {
        log(`ERREUR : ${msg.message}`);
        progressStatus.textContent = "Erreur pendant le traitement";
        progressSubtext.textContent = msg.message;
        startBtn.disabled = false;
        changeBtn.disabled = false;
      }
    };

    worker.onerror = (err) => {
      log(`Erreur Worker : ${err?.message || err}`);
      progressStatus.textContent = "Échec du Worker IA";
      progressSubtext.textContent = err?.message || "Erreur interne";
      startBtn.disabled = false;
      changeBtn.disabled = false;
    };

    function sendNextSegment() {
      if (currentSegIdx >= nSegments) return;
      const idx = currentSegIdx++;
      const start = idx * SEG_SAMPLES;
      const end = Math.min(start + SEG_SAMPLES, totalSamples);

      const segL = new Float32Array(SEG_SAMPLES);
      const segR = new Float32Array(SEG_SAMPLES);
      segL.set(left.subarray(start, end));
      segR.set(right.subarray(start, end));

      worker.postMessage(
        { type: "process", index: idx, left: segL.buffer, right: segR.buffer },
        [segL.buffer, segR.buffer]
      );
    }

    function finishProcessing() {
      const totalSec = Math.round((performance.now() - tStart) / 1000);
      log(`Traitement terminé avec succès en ${totalSec} secondes !`);

      progressStatus.textContent = "Génération du fichier audio WAV…";
      const wavBuffer = audioBufferToWav(outVocalL, outVocalR, 44100);
      const blob = new Blob([wavBuffer], { type: "audio/wav" });
      const wavUrl = URL.createObjectURL(blob);

      audioPreview.src = wavUrl;
      const baseName = currentFile.name.replace(/\.[^.]+$/, "");
      const cleanName = `${baseName}-voix-seules.wav`;
      downloadBtn.href = wavUrl;
      downloadBtn.download = cleanName;

      resultTiming.textContent = `Terminé en ${totalSec} s (${nSegments} blocs)`;
      progressCard.classList.add("hidden");
      resultCard.classList.remove("hidden");

      startBtn.disabled = false;
      changeBtn.disabled = false;

      // Déclenche le téléchargement automatique
      downloadBtn.click();
    }

    // Demande l'initialisation du modèle
    worker.postMessage({ type: "init" });

  } catch (err) {
    log(`Erreur globale : ${err?.message || err}`);
    progressStatus.textContent = "Erreur de traitement";
    progressSubtext.textContent = err?.message || String(err);
    startBtn.disabled = false;
    changeBtn.disabled = false;
  }
});
