# Changelog — Vocalis

Le format suit [Keep a Changelog](https://keepachangelog.com/fr-FR/1.1.0/).
Chaque entrée correspond à une **Release GitHub** (c'est ce que le fichier
`METTRE_A_JOUR.bat` vient chercher).

## [0.4.8] — 2026-09-19

### Corrigé
- « Téléchargement de l'audio impossible » : détection erronée du mode
  fragmenté (mp4box n'était vérifié qu'au niveau page alors qu'il vit
  dans le worker), ce qui forçait à tort le mode complet « legacy »
  et provoquait un 403 sur le CDN YouTube.
- Ajout du client `VISIONOS` (Apple Vision Pro) en tête de liste :
  client anonyme par défaut de yt-dlp 2026, URLs directes sans bot-check.
- Tranches de téléchargement fragmenté réduites à 1 Mo (conforme aux
  limites googlevideo CDN).
- Protocole offscreen document stabilisé via un port bidirectionnel
  `chrome.runtime.connect` direct (évite l'appel interdit à chrome.tabs
  depuis une page offscreen).

## [0.4.7] — 2026-09-19

### Corrigé
- « Failed to construct 'Worker' » : un script de contenu ne peut PAS
  créer de Worker chrome-extension:// (origine = page YouTube). Le
  worker IA naît désormais dans un document « offscreen » de
  l'extension (origine extension, tous les droits : imports, wasm,
  WebGPU, modèle local) et les messages sont relayés proprement.
  Toute la chaîne audio débloquée jusqu'au bout.

## [0.4.6] — 2026-09-19

### Corrigé
- CRITIQUE : innertube.js et cipher.js n'étaient pas listés dans le
  manifest → « VocalisInnertube is not defined » et déchiffrement mort.
  Les deux scripts sont maintenant chargés.
- Innertube : clients alignés sur l'état de l'art 2026 (ANDROID_VR,
  ANDROID « sdkless », IOS, TV) — pas de PO-token, URLs en clair.
- Déchiffrement : balayage des fonctions signature (forme a.split /
  a.join) indépendant des sites d'appel + variante ES5 de base.js en
  repli si le lecteur principal ne résout rien.
- METTRE_A_JOUR.bat : le « \ » final du chemin avalait la fin de la
  commande git (« cannot change to … ») → corrigé.

## [0.4.5] — 2026-09-19

### Corrigé
- Le pipeline pouvait rester bloqué juste après « playerResponse OK » sans
  aucune erreur ni log : recherche du flux audio entièrement réécrite.
  - chaque étape est journalisée (formats page, Innertube TV/Android,
    base.js, déchiffrement) ;
  - toutes les attentes réseau sont bornées (le `.json()` Innertube et la
    lecture de base.js n'avaient AUCUN timeout) ;
  - toute exception remonte désormais en message d'erreur visible au lieu
    d'un chargement infini silencieux.
- Garde-fou global : si une phase reste figée 45 s, un message le dit
  explicitement (au lieu d'une barre infinie).
- base.js (déchiffrement) : retrouvé aussi via la balise <script> de la
  page quand le playerResponse n'a pas d'assets.

## [0.4.4] — 2026-09-19

### Ajouté
- Popup : bloc debug permanent (état/phase/mode/voie + journal) — une copie
  d'écran suffit à diagnostiquer n'importe quel blocage.
- Logs pré-worker (playerResponse, vidéo trouvée ou non, lancement worker).
- Détection « extension rechargée mais pas la page » : au lieu d'un pipeline
  mort en silence, message clair « Recharge la page (F5) ».
- Cas « aucun <video> trouvé » : message clair au lieu d'un retour silencieux.

## [0.4.3] — 2026-09-19

### Ajouté
- **Journal de bord dans le popup** (horodaté) : source du modèle, backend
  WebGPU/WASM + durée de chargement de la session, durée du 1er bloc séparé,
  voie du flux (page/innertube/déchiffrement), progression du téléchargement,
  bascules legacy. Permet de voir EXACTEMENT où ça traîne sur ta machine.
- Timeouts réseau partout (innertube 6 s, base.js 8 s, tranche flux 20 s) :
  plus aucune requête ne peut pendouiller silencieusement.

## [0.4.2] — 2026-09-19

### Corrigé (cause racine de TOUS les échecs du .bat depuis le début)
- Le dépôt GitHub est **PRIVÉ** : les téléchargements anonymes (API releases,
  codeload) renvoient 404 sans auth. Mon environnement de dev passait par un
  proxy authentifié, ce qui masquait le problème dans mes tests.
- `METTRE_A_JOUR.bat` utilise désormais **ton git** (fetch + reset sur la
  branche de travail) : fiable, authentifié, une touche.
- Si le dossier n'est pas un clone : message clair avec LA commande de clone
  à faire une fois.

### Ajouté
- **`TELECHARGER_MODELE.bat`** : télécharge le modèle IA (~172 Mo, Hugging
  Face public) dans `extension/models/`. Le worker lit ce fichier local en
  priorité (zéro réseau), puis le cache IndexedDB, puis Hugging Face.
- `extension/models/` ignoré par git et jamais touché par les mises à jour.

## [0.4.1] — 2026-09-19

### Corrigé
- **Pause + silence immédiats** au clic sur Vocalis : plus de son original
  qui tourne pendant le chargement ; la lecture reprend toute seule dès que
  les voix sont prêtes (et reste en pause si tu l'avais mise en pause).
- **Overlay non bloquant** : les contrôles YouTube restent cliquables autour
  de la carte, et un bouton « Annuler — garder le son original » est visible
  pendant TOUTES les phases (pas seulement en erreur).

### Accéléré
- Blocs de 10 s (au lieu de 30) et pré-chargement 10 s : la lecture sans
  musique démarre beaucoup plus vite.
- Le modèle IA se charge **en parallèle** du flux audio (au lieu d'attendre
  l'un puis l'autre).
- Bascule legacy signalée dans le popup (« mode legacy »), pour savoir
  précisément quel chemin tourne chez toi.

## [0.4.0] — 2026-09-19

### Ajouté
- **Chargement fragmenté** (demande du streamer) : le flux audio m4a est
  téléchargé par tranches de 4 Mo, démultiplexé (mp4box.js) et décodé
  (WebCodecs) au fil de l'eau. La lecture démarre après ~30 s de voix
  prêtes ; le reste se traite pendant qu'on regarde. Si on rattrape le
  traitement, l'écran « traitement… » revient le temps du bloc.
- **Téléchargement borné** (~90 s d'avance sur le traitement) : fini le
  téléchargement géant qui ralentissait le chargement de la vidéo YouTube.
- Seek loin devant : le flux redémarre à cet endroit au lieu de tout
  re-télécharger ; le cache rend les retours arrière instantanés.

### Corrigé
- `METTRE_A_JOUR.bat` se fermait aussitôt ouvert : une parenthèse PowerShell
  dans un `for /f` cassait l'analyse cmd. Réécrit sans `for /f` (PowerShell
  écrit dans des fichiers temporaires). Plus aucun scénario de fenêtre qui
  claque sans message.
- Texte périmé « v0.2 » dans l'overlay ; sous-titres de progression clarifiés.
- Mémoire : le chemin incrémental ne décode plus jamais la vidéo entière
  (le chemin complet reste en filet de sécurité « legacy »).

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
