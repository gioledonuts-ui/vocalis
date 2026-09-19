# Feuille de route Vocalis

Chaque version = une **Release GitHub** (c'est ce que récupère
`METTRE_A_JOUR.bat`).

## ✅ v0.1 — Structure (celle-ci)
- [x] Dépôt organisé, manifeste Chrome MV3 fonctionnel.
- [x] Popup activer/désactiver par onglet, badge sur l'icône.
- [x] Script de contenu : overlay de chargement (squelette) + barre
      « son traité » prête à recevoir ses données.
- [x] Mise à jour locale en un clic (`METTRE_A_JOUR.bat` / `.sh`).
- [x] Documentation : architecture, roadmap, comparatif des modèles.

## ✅ v0.2 — Pipeline audio « bout en bout », sans modèle
Valider toute la tuyauterie avec le son **original** (identité, pas encore
de séparation) :
- [x] Extraction du flux audio adaptatif (pont main-world →
      `getPlayerResponse()`, meilleur débit audio).
- [x] Découpage en segments 10 s (PCM16) + relecture via Web Audio, vidéo muette.
- [x] Synchronisation robuste sur `video.currentTime` (seek, pause, mise en
      tampon, vitesse ×2 → son original, re-sync anti-dérive).
- [x] Cache IndexedDB complet : conservation pendant la vidéo, purge à la
      sortie (+ plafond ~1,5 Go, fenêtre RAM ~20 min).
- [x] Overlay avec vraie progression (téléchargement %/Mo, analyse, préparation).
- [x] Barre « son traité » alimentée en direct au-dessus de la barre YouTube.
- [x] Popup vivant (phase + progression en direct).

> Limites assumées : décodage complet en mémoire (vidéos > 2 h gourmandes),
> pas de time-stretch (vitesse ≠ 1 → son original), directs non gérés.
> La v0.3 remplace l'étape « identité » par le modèle, segment par segment.

## ✅ v0.3 — La musique disparaît vraiment
- [x] onnxruntime-web 1.30 embarqué (WebGPU + WASM), worker dédié.
- [x] Modèle HTDemucs ONNX (demucs-web, MIT) téléchargé au premier lancement
      depuis Hugging Face, mis en cache IndexedDB.
- [x] Séparation par blocs de 30 s, voix uniquement, PCM16 en cache.
- [x] Pré-chargement ~60 s puis traitement en arrière-plan pendant la lecture.
- [x] Seek vers zone non traitée : écran « traitement… » + file prioritaire.
- [x] Barre « son traité » = plages réellement séparées.

> Limites assumées : décodage complet en mémoire avant traitement (optimisation
> segment par segment prévue plus tard), vitesse ≠ ×1 → son original, directs
> non gérés. Challenger BS-RoFormer à benchmarker en v0.4.

## ✅ v0.4 — Chargement fragmenté + updater fiabilisé
- [x] Pipeline incrémental : tranches 4 Mo, mp4box.js + WebCodecs, segments
      30 s traités dès leur arrivée ; lecture après ~30 s de voix prêtes.
- [x] Téléchargement borné (~90 s d'avance) : ne ralentit plus la vidéo.
- [x] Seek lointain : reprise du flux à l'endroit voulu (pas de re-téléchargement).
- [x] `METTRE_A_JOUR.bat` réécrit sans `for /f` (il se fermait aussitôt).
- [x] Chemin « legacy » (téléchargement complet) conservé en filet de sécurité.

## 💭 v0.5 — Réglages + mode « live »
- [ ] Options : secondes de pré-chargement, plafonds cache, modèle challenger
      (BS-RoFormer ONNX) en option qualité max.
- [ ] Statistiques dans le popup (avance du traitement, backend WebGPU/WASM).
- [ ] Mode « live » latence 1–3 s, si les perfs le permettent (WebGPU).
- [ ] Cas tordus : lives, changement auto de vidéo, onglets multiples.

## Hors périmètre (décidé)
- ❌ Envoyer l'audio sur un serveur, même en option : 100 % local, point final.
- ❌ Stocker les modèles IA dans git.
- ❌ Créer des pull requests pour livrer le code : le travail arrive sur
  `main` via des merges locaux / fast-forward (règle de la session).
