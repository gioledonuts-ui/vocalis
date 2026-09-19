# Architecture de Vocalis

> Objectif : retirer la musique de fond d'une vidéo YouTube, en local, avec le
> minimum de latence perçue et une qualité audio élevée.

## Vue d'ensemble

```
┌─────────────────────────── Page YouTube ───────────────────────────┐
│                                                                    │
│  ┌────────────┐   ┌───────────────────────────────────────────┐    │
│  │  Popup     │   │  Script de contenu (content/content.js)   │    │
│  │  Chrome    │──▶│  · overlay de chargement                  │    │
│  │ (activer)  │   │  · barre « son traité »                   │    │
│  └────────────┘   │  · orchestration du pipeline ▼            │    │
│                   └───────────────────────────────────────────┘    │
│                                                                    │
│   1. Récupération du flux audio original de la vidéo               │
│      (ytInitialPlayerResponse → format adaptatif audio seul)       │
│                       │                                            │
│   2. Découpage en segments (fenêtre ~10 s, recouvrement ~1 s)      │
│                       │                                            │
│   3. Séparation voix/musique par modèle IA (ONNX Runtime Web)      │
│      WebGPU si dispo, sinon WASM                                   │
│                       │                                            │
│   4. Cache IndexedDB (clé : videoId + index de segment)            │
│      · conservé tant qu'on reste sur la vidéo                      │
│      · purgé quand on quitte la page / on change de vidéo          │
│                       │                                            │
│   5. Relecture : vidéo mise en sourdine, le son traité est         │
│      rejoué via Web Audio, resynchronisé sur video.currentTime     │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Pourquoi deux modes de fonctionnement

La séparation source de qualité (Demucs et équivalents) n'est pas
instantanée : elle demande des calculs importants. Deux modes sont prévus :

1. **Mode « pré-chargement » (v0.2 → v0.4, mode par défaut)** — celui décrit
   dans le besoin initial : on clique sur Activer, un écran de chargement
   apparaît, l'extension traite assez de secondes pour démarrer la lecture,
   puis continue de traiter **en arrière-plan** pendant qu'on regarde. Tant
   que le traitement reste plus rapide que la lecture, tout est fluide.
2. **Mode « live » (v0.5, si les performances le permettent)** : traitement
   au fil de l'eau avec une petite latence (1 à 3 s), sans clic préalable.
   Réservé aux machines rapides (WebGPU). Pas une promesse, une exploration.

## Choix techniques clés

### 1. Récupérer l'audio : flux adaptatif, pas capture du `<video>`

YouTube sert la vidéo et l'audio séparément (formats adaptatifs). Au lieu de
capturer le son du lecteur (`captureStream()`), on lit
`ytInitialPlayerResponse.streamingData.adaptiveFormats`, on choisit le format
**audio seul** de meilleure qualité (ex. itag 251/Opus ou 140/AAC) et on le
télécharge nous-mêmes via `fetch()` (même origine youtube.com, donc pas de
problème CORS).

Avantages :
- on travaille sur l'audio **original complet**, découpable à volonté ;
- pas de dépendance au routage audio du lecteur ;
- on peut muter la vidéo et remplacer son son proprement.

### 2. Découpage et pré-chargement

- Segments d'environ **10 s** avec **~1 s de recouvrement** (fondu croisé
  entre segments pour éviter tout « clic » aux jointures).
- Avant de lancer la lecture : traiter **N secondes d'avance** (réglable,
  défaut envisagé : 20–30 s).
- Pendant la lecture : le pipeline traite en continu pour garder toujours
  ~60 s d'avance sur la tête de lecture.
- Si on avance (seek) dans une zone non traitée : l'overlay réapparaît le
  temps de traiter la zone ; si on revient sur une zone **déjà traitée**,
  relecture instantanée depuis le cache.

### 3. Cache : cycle de vie strict

- Stockage : **IndexedDB**, segments en PCM 16 bits (moitié moins lourd que
  le flottant, aucune perte audible pour cet usage).
- Clé : `videoId + indexSegment`.
- **Conservé** pendant toute la session sur la vidéo (seek arrière gratuit).
- **Purgé** sur : `pagehide`, `yt-navigate-start` (navigation SPA YouTube)
  et changement de vidéo détecté dans le lecteur.
- Garde-fou : plafond de volume par vidéo (ex. 2–3 Go), au-delà on purge les
  segments les plus anciens très en amont de la tête de lecture.
- Les URLs audio YouTube étant temporaires/signées, le cache ne stocke que le
  son **déjà traité** — pas de problème d'expiration.

### 4. Synchronisation audio/vidéo

- Le `<video>` est mis en sourdine (`muted`) mais continue de tourner.
- Les segments traités sont planifiés via l'horloge de l'`AudioContext`,
  recalée en permanence sur `video.currentTime` (tolérance ~50 ms,
  re-sync au-delà).
- Sur seek : on arrête les sources programmées, on reprend depuis le segment
  correspondant (cache si dispo).

### 5. Où tourne le modèle ?

- **WebGPU** (via ONNX Runtime Web) si disponible : c'est la cible
  principale, une carte graphique récente traite plusieurs secondes de son
  en une seconde ou moins.
- **WASM** sinon, en simple thread (les threads WASM exigent un contexte
  « cross-origin isolated » que la page YouTube n'offre pas ; des pistes
  existent via offscreen document, à étudier en v0.3).
- Les poids du modèle (plusieurs dizaines de Mo) ne sont **jamais dans git** :
  l'extension les télécharge au premier lancement (depuis les assets de
  release GitHub) et les conserve dans le cache du navigateur.

### 6. Interface

- **Popup Chrome** : activer/désactiver sur l'onglet courant, statut,
  réglages (v0.4).
- **Overlay** : écran de chargement au design soigné (logo animé, barre de
  progression, estimation du temps restant à partir de la v0.2).
- **Barre « son traité »** : fine barre colorée posée juste au-dessus de la
  barre rouge YouTube, montrant les plages dont le son est prêt — même
  principe visuel que la barre grise de buffer de YouTube.

## Réalité v0.2 (ce qui est implémenté aujourd'hui)

- Le flux audio est lu via un pont « main world » (`bridge.js`) qui appelle
  `movie_player.getPlayerResponse()` — fiable y compris en navigation SPA.
- Téléchargement `fetch()` du format audio au plus haut débit (permission
  `*://*.googlevideo.com/*`), décodage `decodeAudioData`, découpage en
  segments de 10 s en PCM16, écriture IndexedDB en arrière-plan.
- Relecture : vidéo `muted`, segments rejoués via Web Audio, programmation
  45 s à l'avance, watchdog anti-dérive (tolérance 90 ms), gestion de
  `waiting`/`playing`/`seeked`/`ratechange`.
- Fenêtre RAM d'environ 20 min de segments ; le reste vit en IndexedDB
  (retour arrière lointain = relecture depuis le cache).
- Limites connues : décodage complet en mémoire (mémoire proportionnelle à
  la durée — sera remplacé par un traitement segment par segment en v0.3,
  qui est de toute façon ce que demande le modèle), vitesse ≠ ×1 → retour au
  son original, directs non gérés.

### Réalité v0.3 (séparation effective)

- Worker dédié (`content/worker.js`, module ES) : onnxruntime-web 1.30
  embarqué dans `extension/lib/ort/` (~41 Mo, justifié : notre sandbox ne
  peut pas uploader d'assets binaires sur les releases, donc tout doit vivre
  dans le dépôt) + code de pré/post-traitement demucs-web (MIT).
- Modèle `htdemucs_embedded.onnx` (~172 Mo, HTDemucs exporté ONNX, parité
  vérifiée par demucs-web) téléchargé depuis Hugging Face au premier
  lancement, puis servi depuis IndexedDB (`vocalis-model`). Jamais dans git.
- EP : `['webgpu','wasm']` — WebGPU sur le GPU du streamer (RTX 30/40),
  repli WASM simple thread sinon.
- Audio remis à 44,1 kHz stéréo (OfflineAudioContext) avant traitement.
- Blocs de 30 s : chaque bloc part au worker, la sortie « vocals » est
  convertie en PCM16, mise en RAM + IndexedDB, puis rejouée. Le recouvrement
  entre segments internes du modèle (overlap-add + fenêtre triangulaire) est
  géré par demucs-web : pas de clic aux jointures.
- Pré-chargement 60 s → lecture ; le reste suit en arrière-plan. Seek vers
  une zone non traitée : la file de traitement est réordonnée sur la tête de
  lecture et un écran « traitement… » s'affiche le temps du bloc courant.

## Composants du dépôt

| Fichier | Rôle |
|---|---|
| `extension/manifest.json` | Manifeste MV3 : permissions, scripts, icônes |
| `extension/background/service-worker.js` | Badge, état des onglets, supervision (v0.2+) |
| `extension/popup/*` | Fenêtre du bouton Chrome |
| `extension/content/content.js` | UI page + orchestration du pipeline |
| `extension/content/vocalis.css` | Styles de l'overlay et de la barre de cache |

## Risques identifiés

| Risque | Réponse prévue |
|---|---|
| YouTube change la structure de `ytInitialPlayerResponse` | Versionner l'extraction, détecter les échecs et message clair |
| Traitement plus lent que la lecture (config sans GPU) | Mode dégradé : pré-chargement plus long + avertissement. Pas de mode serveur (décision : 100 % local) |
| URLs audio signées/expirantes | Re-téléchargement à la demande du flux si nécessaire |
| Poids du modèle | Téléchargement unique + asset de release, jamais dans git |
| Écart audio/image après seek | Re-sync systématique sur `video.currentTime` |
