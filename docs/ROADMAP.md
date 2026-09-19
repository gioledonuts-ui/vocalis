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

## ⏳ v0.2 — Pipeline audio « bout en bout », sans modèle
Valider toute la tuyauterie avec le son **original** (identité, pas encore
de séparation) :
- [ ] Extraction du flux audio adaptatif depuis `ytInitialPlayerResponse`.
- [ ] Découpage en segments + relecture via Web Audio, vidéo muette.
- [ ] Synchronisation robuste sur `video.currentTime` (seek, pause, vitesse ×2…).
- [ ] Cache IndexedDB complet : conservation pendant la vidéo, purge à la sortie.
- [ ] Overlay avec vraie progression (secondes traitées / pré-chargement).
- [ ] Barre « son traité » alimentée en direct au-dessus de la barre YouTube.

> Pourquoi cette étape : si le pipeline fonctionne avec l'audio original,
> l'ajout du modèle en v0.3 ne touchera qu'un seul bloc (le traitement).

## ⏳ v0.3 — La musique disparaît vraiment
- [ ] Téléchargement du modèle ONNX au premier lancement (asset de release).
- [ ] ONNX Runtime Web : WebGPU d'abord, repli WASM.
- [ ] Sortie « voix uniquement » (ou « musique uniquement » inversée) avec
      recouvrement + fondu entre segments.
- [ ] Benchmark sur machine réelle (×temps réel selon GPU/CPU) et réglage de
      la fenêtre de pré-chargement en conséquence.
- [ ] Qualité audio validée : pas de voix métallique, pas d'artefacts aux
      jointures.

## ⏳ v0.4 — Réglages et robustesse
- [ ] Options : secondes de pré-chargement, qualité du modèle, plafonds cache.
- [ ] Statistiques dans le popup (avance du traitement, vitesse).
- [ ] Gestion des cas tordus : vidéos très longues, lives, changement
      automatique de vidéo, onglets multiples.

## 💭 v0.5 — Mode « live » (exploration)
- [ ] Traitement au fil de l'eau, latence 1–3 s, sans clic préalable.
- [ ] Uniquement si les mesures de perf le permettent (WebGPU).

## Hors périmètre (décidé)
- ❌ Envoyer l'audio sur un serveur par défaut (confidentialité).
- ❌ Stocker les modèles IA dans git.
- ❌ Créer des pull requests pour livrer le code : le travail arrive sur
  `main` via des merges locaux / fast-forward (règle de la session).
