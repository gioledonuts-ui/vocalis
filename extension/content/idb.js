/**
 * Vocalis — cache IndexedDB des segments audio traités
 *
 * Règle produit (décidée avec le streamer) :
 *  - le cache vit tant qu'on reste sur la vidéo (retour arrière instantané) ;
 *  - il est purgé dès qu'on quitte la vidéo (pas d'accumulation de Go).
 *
 * Chaque segment = ~10 s de son en PCM 16 bits, clé « videoId:index ».
 */

self.VocalisIDB = (() => {
  "use strict";

  const DB_NAME = "vocalis";
  const STORE = "segments";
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const rq = indexedDB.open(DB_NAME, 1);
        rq.onupgradeneeded = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "key" })
              .createIndex("videoId", "videoId", { unique: false });
          }
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
    }
    return dbPromise;
  }

  const done = (r) =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

  const txDone = (tx) =>
    new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onabort = resolve;
      tx.onerror = resolve;
    });

  return {
    /** Enregistre un segment : { key, videoId, index, pcm, sampleRate, channels } */
    async put(rec) {
      const db = await open();
      return done(db.transaction(STORE, "readwrite").objectStore(STORE).put(rec));
    },

    /** Lit un segment (ou undefined). */
    async get(key) {
      const db = await open();
      return done(db.transaction(STORE, "readonly").objectStore(STORE).get(key));
    },

    /** Purge TOUS les segments d'une vidéo. */
    async deleteVideo(videoId) {
      if (!videoId) return;
      const db = await open();
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const keys = await done(store.index("videoId").getAllKeys(videoId));
      for (const k of keys) store.delete(k);
      return txDone(tx);
    },
  };
})();
