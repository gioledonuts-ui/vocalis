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

## ⏳ v0.4 — Réglages et robustesse
- [ ] Options : secondes de pré-chargement, qualité du modèle, plafonds cache.
- [ ] Statistiques dans le popup (avance du traitement, vitesse).
- [ ] Gestion des cas tordus : vidéos très longues, lives, changement
      automatique de vidéo, onglets multiples.

## 💭 v0.5 — Mode « live » (exploration)
- [ ] Traitement au fil de l'eau, latence 1–3 s, sans clic préalable.
- [ ] Uniquement si les mesures de perf le permettent (WebGPU) — a priori
      très jouable sur la machine cible (RTX 30xx/40xx).

## Hors périmètre (décidé)
- ❌ Envoyer l'audio sur un serveur, même en option : 100 % local, point final.
- ❌ Stocker les modèles IA dans git.
- ❌ Créer des pull requests pour livrer le code : le travail arrive sur
  `main` via des merges locaux / fast-forward (règle de la session).
