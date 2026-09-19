# Changelog — Vocalis

Le format suit [Keep a Changelog](https://keepachangelog.com/fr-FR/1.1.0/).
Chaque entrée correspond à une **Release GitHub** (c'est ce que le fichier
`METTRE_A_JOUR.bat` vient chercher).

## [0.3.1] — 2026-09-19

### Corrigé
- **Erreur « Aucun flux audio accessible » sur les vidéos normales** : YouTube
  ne donne plus d'URL en clair au lecteur web. Ajout de deux couches
  d'obtention du flux : requête youtubei/v1/player (clients TV/Android,
  URLs en clair) puis déchiffrement `signatureCipher` + paramètre `n` depuis
  le JS du lecteur (mini-bundler + eval du code public de Google).
- Message d'erreur précisant les couches testées, pour le diagnostic.

## [0.3.0] — 2026-09-19

### Ajouté
- **La musique disparaît vraiment** : HTDemucs en ONNX (demucs-web, MIT) dans
  un worker, WebGPU en priorité, repli WASM.
- Modèle (~172 Mo) téléchargé **une seule fois** depuis Hugging Face puis mis
  en cache IndexedDB — jamais dans git, jamais envoyé ailleurs.
- Blocs de 30 s séparés (voix uniquement), pré-chargement ~60 s puis
  traitement en arrière-plan pendant la lecture.
- Écran « traitement de cette zone… » si on avance dans une zone pas encore
  séparée (file prioritaire sur la tête de lecture).
- onnxruntime-web 1.30 embarqué dans `extension/lib/` (~41 Mo).

### Limites connues
- Décodage complet en mémoire avant traitement (vidéos > 2 h gourmandes).
- Vitesse ≠ ×1 → son original ; directs non gérés.
- Premier lancement : téléchargement du modèle selon ton débit.

## [0.2.0] — 2026-09-19

### Ajouté
- **Pipeline audio complet (sans modèle)** : téléchargement du flux audio
  adaptatif (meilleur débit), décodage, découpage en segments de 10 s.
- **Relecture remplacée et synchronisée** : vidéo en sourdine, son rejoué via
  Web Audio, re-sync permanente sur `video.currentTime` (seek, pause,
  mise en tampon, changement de vidéo).
- **Cache IndexedDB** : segments conservés pendant la vidéo (retour arrière
  instantané), purgés quand on quitte la vidéo. Plafond ~1,5 Go par vidéo.
- **Overlay à progression réelle** : téléchargement (%, Mo), analyse,
  préparation ; état d'erreur propre (vidéo protégée, direct…).
- **Barre « son traité »** alimentée en direct au-dessus de la barre YouTube.
- **Popup vivant** : phase et progression du pipeline affichées en direct.

### Limites connues (documentées, corrigées plus tard)
- Décodage complet en mémoire : vidéos > 2 h gourmandes (v0.3 passera en
  traitement segment par segment).
- Vitesse de lecture ≠ ×1 : son original rétabli (pas de time-stretch).
- Directs (lives) non gérés.
- Le son joué est l'original : la séparation voix/musique arrive en v0.3.

## [0.1.0] — 2026-09-19

### Ajouté
- Structure complète du projet et manifeste Chrome MV3 (`extension/`).
- Popup Vocalis : bouton activer/désactiver sur l'onglet YouTube en cours.
- Script de contenu : overlay de chargement (squelette), barre de cache
  « son traité » prête à être alimentée (invisible en v0.1).
- Système de mise à jour locale en un clic : `METTRE_A_JOUR.bat` (Windows)
  et `mettre_a_jour.sh` (macOS/Linux), basé sur les GitHub Releases.
- Documentation : `ARCHITECTURE.md`, `ROADMAP.md`, `MODELES.md`.
- Icônes de l'extension (16/32/48/128 px).
