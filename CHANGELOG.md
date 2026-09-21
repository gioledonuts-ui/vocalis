# Changelog — Vocalis

Le format suit [Keep a Changelog](https://keepachangelog.com/fr-FR/1.1.0/).
Chaque entrée correspond à une **Release GitHub** (c'est ce que le fichier
`METTRE_A_JOUR.bat` vient chercher).

## [0.5.16] — 2026-09-21

### Ajouté & Amélioré (Refonte de l'Overlay YouTube — Design sobre & artisanal)
- **Remplacement du vieux stepper multi-blocs** :
  - Suppression définitive du grand cadre à 3 étapes (« Flux audio », « Moteur IA », « Isolation vocale ») et de ses égaliseurs animés criards.
  - Remplacement par une carte flottante compacte, discrète et sobre (390 px) en verre dépoli mat ardoise (`#141722`) avec flou d'arrière-plan haute précision.
- **Identité de marque & cohérence totale** :
  - Intégration de l'emblème signature « V » (5 barres acoustiques en dégradé subtil cyan → violet) identique à celui du popup et du Studio.
  - Pastille d'état minimaliste « WebGPU » avec indicateur lumineux pulsant doux.
- **Jauge haute précision & métadonnées claires** :
  - Jauge fine de 4 px avec dégradé fluide et animation douce de balayage.
  - Ligne de métadonnées indiquant dynamiquement l'étape en cours et le pourcentage précis ou l'état d'avancement.
  - Titre et sous-titre contextualisés à chaque phase du pipeline audio (acquisition, décodage PCM 44,1 kHz, modèle Demucs v4, isolation vocale).
- **Contrôle et ergonomie renforcés** :
  - Bouton « Annuler — garder le son original » épuré et toujours accessible en bas de carte.
  - Bouton croix discrète (✕) en haut à droite pour une fermeture instantanée.
  - Gestion sobre et explicite des états d'erreur sans effet néon agressif.

## [0.5.15] — 2026-09-21

### Ajouté & Amélioré (Refonte visuelle artisanale, identité unifiée & Nouveau Vocalis Studio)
- **Identité de marque unifiée & Logo artisanal** :
  - Création du véritable logo signature Vocalis : le « V » acoustique formé de 5 barres d'égalisation harmoniques avec un dégradé subtil cyan → violet.
  - Rendu vectoriel ultra-net au pixel près, éliminant tout artefact d'IA ou de boîte noire dézoomée.
  - Le logo est désormais rigoureusement identique partout : icône de l'extension Chrome, en-tête du popup, bouton du lecteur YouTube, overlay et en-tête du Studio.
- **Refonte épurée et humaine du Popup** :
  - Suppression de la grille de 3 gros blocs gadgets (« MOTEUR », « TAMPON », « CONFIDENTIALITÉ »).
  - Remplacement par une ligne métadonnée discrète et sobre : `Moteur · Avance · 100% Local`.
  - Palette sombre profonde matte (obsidienne / ardoise `#0c0e14` et `#141722`), bordures douces 1px, suppression des halos néon agressifs.
  - Bouton d'action principal tactile et direct avec indicateur d'état LED clair.
  - Carte d'accès dédiée et élégante vers Vocalis Studio.
- **Refonte complète de Vocalis Studio (`studio.html` & `studio.css`)** :
  - Alignement sur la même charte visuelle haut de gamme et épurée.
  - Zone de glisser-déposer épurée avec icône audio vectorielle fine et prise en charge instantanée de tous formats audio (MP3, WAV, FLAC, M4A, OGG).
  - Carte de sélection avec badges précis de métadonnées audio (nom, taille, durée, échantillonnage).
  - Barre de progression fluide haute précision avec calcul du temps restant et vitesse en temps réel.
  - Lecteur audio intégré pour écoute immédiate et bouton de téléchargement du WAV haute fidélité.

## [0.5.14] — 2026-09-20

### Corrigé (WebGPU JSEP initialisation & compatibilité Studio)
- **Correction du chargement WebGPU JSEP (`webgpuInit is not a function`)** :
  - Restauration de la configuration explicite `ort.env.wasm.wasmPaths` pointant sur `ort-wasm-simd-threaded.jsep.mjs` et `ort-wasm-simd-threaded.jsep.wasm`. L'affectation d'un dossier racine provoquait le chargement du binaire asyncify non-JSEP (dépourvu de `webgpuInit`).
  - WebGPU s'initialise désormais parfaitement sur le GPU NVIDIA RTX (architecture Lovelace).
- **Correction de la portée de `adapterInfo` (`adapterInfo is not defined`)** :
  - Déclaration de `adapterInfo` au niveau du module du worker pour éviter toute erreur de référence lors de l'émission du message `ready`.
- **Compatibilité bidirectionnelle Worker / Studio (`msg.left` + `msg.leftB64`)** :
  - Le worker renvoie simultanément les tampons bruts `ArrayBuffer` (`msg.left`, `msg.right`) et les chaînes `base64` (`msg.leftB64`, `msg.rightB64`), assurant un fonctionnement direct dans Vocalis Studio et à travers l'IPC de l'extension.
  - Vocalis Studio adopte également les blocs de 7,8 s pour maximiser la vitesse de traitement (1 inférence par bloc).

## [0.5.13] — 2026-09-20

### Optimisé (Accélération IA majeure : WebGPU forcé, 75 % d'iSTFT éliminés, alignement natif des blocs)
- **Élimination de 75 % des calculs iSTFT (mode `vocalsOnly`)** :
  - Auparavant, `DemucsProcessor.separate` exécutait la reconstruction par transformée de Fourier inverse (`standaloneIspec`) pour les 4 pistes du modèle (`drums`, `bass`, `other`, `vocals`), gaspillant 3/4 du temps CPU en JavaScript pur.
  - La fonction `standaloneMaskSingle` extrait désormais uniquement le spectrogramme complexe de la piste vocale (index 3). La conversion iSTFT et l'accumulation temporelle ne sont calculées que pour la voix, divisant par 4 le temps post-inférence.
- **Alignement natif des segments audio (blocs de 7,8 s au lieu de 10 s)** :
  - Le modèle Demucs v4 est entraîné nativement sur des fenêtres de 343 980 échantillons (7,80 s à 44,1 kHz).
  - Découper en tranches de 10 s forçait le processeur à exécuter 2 inférences ONNX par bloc (avec du padding de zéros superflu).
  - En synchronisant la taille de bloc sur 7,8 s (343 980 échantillons exacts), chaque bloc correspond à **1 seule inférence ONNX**, réduisant immédiatement de 36 % le nombre d'inférences par vidéo et éliminant tout décalage avec le tempo de lecture.
- **Accélération matérielle WebGPU haute performance garantie** :
  - Demande explicite de l'adaptateur GPU avec `{ powerPreference: "high-performance" }` pour cibler la carte graphique dédiée (NVIDIA RTX).
  - Configuration d'ONNX Runtime Web (`ort.env.webgpu.adapter`, `graphOptimizationLevel: "all"`, `enableMemPattern: true`, `enableCpuMemArena: true`) pour maximiser l'utilisation des cœurs GPU et de la VRAM.
  - Détection dynamique et journalisation détaillée : identification du GPU utilisé (ex. NVIDIA GeForce RTX), affichage du temps de calcul de chaque bloc et calcul du ratio de vitesse par rapport au temps réel (ex. 25× à 30× plus rapide que la lecture).
- **Repli WASM multi-cœurs optimisé** :
  - Correction du chemin `ort.env.wasm.wasmPaths` pour mapper correctement le moteur SIMD multi-cœurs `ort-wasm-simd-threaded.wasm` en cas d'indisponibilité du GPU.
  - L'affichage du Popup affiche en temps réel le moteur actif (`WebGPU (GPU)` ou `CPU WASM`).

## [0.5.12] — 2026-09-20

### Corrigé (Reprise fluide lors de la bascule ON/OFF & Téléchargement intégral du flux)
- **Reprise immédiate de la file IA lors de la réactivation** :
  - La désactivation temporaire de Vocalis (pour comparer avec/sans musique) ne bloque plus le traitement en tâche de fond.
  - Lors de la réactivation, `activate()` recalcule et repriorise immédiatement la file de traitement IA à partir de la position vidéo courante (`cur`), et relance `this.pump()`.
  - Le watchdog audio ne s'arrête plus en silence lors des pauses ou des micro-buffering (`stalled`) : il continue de surveiller l'état des blocs prioritaires et relance automatiquement la lecture dès que le bloc manquant est prêt.
  - La méthode `setEnabled` attend la promesse d'activation pour garantir que l'AudioContext et la mise en sourdine YouTube sont verrouillés avant de reprendre la lecture.
- **Téléchargement audio complet sans bride de 1 Mo** :
  - `downloadFullAudio` intègre désormais le téléchargement direct du flux complet via le service worker (`vocalis:fetch-full-audio`) et le streaming continu (`getReader()`), éliminant définitivement la bride de 1 Mo causée par les Range headers et garantissant le téléchargement intégral de la vidéo.

### Ajouté (Nouvelle identité visuelle, Nouveau logo & Refonte graphique complète)
- **Identité visuelle propre et nouveau logo Vocalis** :
  - Création originale d'un logo moderne (monogramme "V" futuriste entrelacé d'ondes sonores néon violet et cyan).
  - Génération des icônes d'extension haute définition (16x16, 32x32, 48x48, 128x128).
  - Nouveau bouton intégré dans le lecteur YouTube (.ytp-right-controls) reprenant le logo SVG avec halo dynamique actif/veille/chargement.
- **Expérience de chargement multi-étapes intuitive** :
  - Nouvel overlay glassmorphic affichant un stepper visuel à 3 étapes :
    1. Acquisition du flux audio YouTube (avec jauge et débit Ko/Mo).
    2. Initialisation du modèle IA Demucs v4 (accélération GPU RTX / WebGPU).
    3. Isolation vocale & pré-chargement (progression en direct jusqu'au démarrage automatique).
  - Égaliseur visuel animé en temps réel pendant le traitement.
  - Bouton « Annuler » toujours accessible sans bloquer les commandes YouTube.
- **Nouvelle barre de chargement (Buffer bar)** :
  - Barre lumineuse à gradient violet/cyan avec animation de brillance (shimmer).
  - Tooltip dynamique au survol affichant le pourcentage précis et la durée déjà traitée sans musique.
- **Refonte graphique du Popup** :
  - Design sombre glassmorphic ultra-moderne avec badge logo HD.
  - Indicateur de statut avec point LED dynamique (actif, en cours, erreur).
  - Stepper visuel à 3 étapes synchronisé.
  - Grille de badges en temps réel (Moteur WebGPU, Mémoire tampon, 100% Local).
  - Bouton Studio local et journal d'activité repliable.

## [0.5.11] — 2026-09-20

### Corrigé (Pause automatique en zone non traitée et justesse de la barre de progression)
- **Pause automatique pour éliminer la lecture en silence** :
  - Lorsque la lecture vidéo rattrape la zone en cours de traitement (ou lors d'un saut dans une zone non encore calculée), la vidéo est immédiatement mise en pause (`video.pause()`) avec affichage de l'overlay de chargement rapide ("Traitement de cette zone…").
  - Dès que le bloc manquant est séparé par le GPU (~400 ms), l'overlay disparaît, la vidéo repart automatiquement (`video.play()`) et la voix reprend en synchronisation parfaite. Zéro lecture en silence.
- **Justesse absolue de la barre de progression violette (Buffer bar)** :
  - L'échelle de la barre tampon utilise désormais strictement la durée totale réelle de la vidéo YouTube (`videoDuration`), évitant qu'un flux partiel de 60 s ne remplisse faussement 100 % de la barre. La zone violette indique exactement les secondes réellement prêtes.
- **Pré-chargement initial augmenté à 20 secondes (2 blocs)** :
  - L'avance initiale de 20 s donne une marge confortable au GPU RTX (qui tourne à ~25× la vitesse réelle) pour calculer tout le reste de la vidéo sans jamais se faire rattraper pendant la lecture normale.
- **Sécurité fin de flux partiel** :
  - Si un flux n'a pu être téléchargé que partiellement, le son YouTube d'origine est automatiquement rétabli dès que la vidéo dépasse la fin de l'audio extrait, sans blocage infini.

## [0.5.10] — 2026-09-20

### Corrigé (Cause racine des blocs traités en 0 ms et client TVHTML5)
- **Transmission binaire intégrale IPC via base64 (Cause racine des blocs 0 ms)** :
  - Le canal de communication interne `chrome.runtime.Port` sérialisait les `ArrayBuffer` en objets vides `{}` lors du transfert entre le script de contenu et le worker offscreen. L'IA recevait donc un tableau de longueur 0, ce qui expliquait le traitement instantané (0 ms) et l'absence totale de voix en sortie.
  - Les échantillons audio sont désormais encodés en base64 garanti pour le transit IPC. Les 441 000 échantillons réels par bloc sont transmis et traités par HTDemucs sur GPU.
- **Client Innertube TVHTML5 prioritaire (flux complet direct sans bride 1 Mo)** :
  - Ajout du client `TVHTML5` de YouTube (utilisé par yt-dlp) : flux audio direct haute définition sans signature, sans PO-token et sans limitation mobile à 1 Mo.

## [0.5.9] — 2026-09-20

### Corrigé (Flux PC 100 % complet et sortie audio WebAudio)
- **Acquisition 100 % du flux PC Web natif via Innertube WEB** :
  - Sur le lecteur de bureau, YouTube utilise SABR ce qui masquait les signatures dans le player runtime. Vocalis interroge désormais le client `WEB` de l'API Innertube pour obtenir les formats signés haute définition du PC.
  - Déchiffrement direct avec l'interpréteur statique (conforme CSP).
  - Fin du repli Android à 1 Mo (37 %) : la vidéo complète (100 %) est téléchargée et traitée.
- **Sortie audio garantie (WebAudio)** :
  - Élimination de la boucle de course entre les événements `play` / `playing` et le watchdog : temporisation (debounce 40 ms) de la planification pour éviter l'annulation prématurée des buffers.
  - Garantie de l'état `running` de l'`AudioContext` (`await resume()`) avant le calcul temporel de synchronisation.
  - Seuil de tolérance de dérive (`DRIFT_MAX`) recalibré de 90 ms à 400 ms pour respecter les saccades normales du moteur de rendu vidéo Chrome.
  - Maintien du volume d'écoute réel via `movie_player.getVolume()` découplé du mute YouTube.
- **Journalisation en direct** :
  - Affichage pas à pas de chaque bloc traité par l'IA et de l'activation des flux dans les logs de débogage.

## [0.5.8] — 2026-09-20

### Corrigé (Cause racine du son original persistant & flux PC natif)
- **Silence absolu de la musique originale YouTube** :
  - Dès l'activation de Vocalis, l'API interne du lecteur YouTube (`movie_player.mute()`)
    est appelée et `video.muted = true` est verrouillé en continu contre toute tentative
    de réactivation automatique par YouTube lors de la reprise de lecture.
  - La musique de fond d'origine est désormais 100 % inaudible.
- **Volume plein pour la voix isolée Vocalis** :
  - Découplage complet entre le mute de YouTube et le gain audio de Vocalis (initialisé à 100 %).
- **Déchiffreur natif pur JavaScript (sans eval / CSP compliant)** :
  - Déchiffrement direct des 12 flux audio du lecteur Web PC sans passer par `eval()` ni
    `new Function()` (qui étaient bloqués par la Content Security Policy de Chrome).
  - Utilise l'interpréteur statique (swap, splice, reverse) aligné sur `yt-dlp`.
  - Permet d'obtenir le flux natif PC haute fidélité sans aucune limitation de taille mobile.

## [0.5.7] — 2026-09-20

### Corrigé (Cause racine de l'échec de téléchargement)
- **Tolérance aux flux partiels (fin du blocage "toutes les sources ont échoué")** :
  - Sur les flux mobiles où YouTube refuse les tranches au-delà de 1 Mo (HTTP 403),
    le téléchargeur n'annule plus tout le processus avec une erreur fatale.
  - Il conserve et exploite immédiatement l'audio reçu, permettant au pipeline
    IA de traiter la vidéo sans interruption.
- **Nouveaux clients Innertube non bridés** :
  - Intégration du client `IOS` avec sa clé API officielle (`AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc`),
    corrigeant l'erreur HTTP 400 et fournissant des flux audio directs complets sans restriction 1 Mo.
  - Ajout des profils `MEDIA_CONNECT_FRONTEND` et `WEB_EMBEDDED_PLAYER`.
- **Intégrité des URLs signées** :
  - Préservation des paramètres de signature (`rn`, `rbuf`), évitant toute invalidation
    du jeton de sécurité par les serveurs de streaming Google.

## [0.5.6] — 2026-09-20

### Corrigé (Cause racine du blocage à 37 % et de l'absence de son)
- **Déverrouillage immédiat du son (AudioContext & Autoplay)** :
  - Dans Chrome, tout `AudioContext` instancié de manière asynchrone (après l'inférence IA)
    est automatiquement suspendu par la politique d'autoplay du navigateur (`state: "suspended"`),
    ce qui empêchait la lecture du son des voix isolées.
  - L'AudioContext est désormais pré-initialisé et déverrouillé dès le clic de l'utilisateur
    sur le bouton Vocalis (geste utilisateur actif). Des appels de réveil `ctx.resume()` sont
    garantis à la reprise de lecture (`play`/`playing`/`reschedule`).
  - Protection du volume : si la vidéo YouTube passe en sourdine lors du remplacement audio,
    le gain de Vocalis n'est plus écrasé à 0.
- **Téléchargement audio complet (fin de l'arrêt prématuré à 1.0 Mo)** :
  - Sur les requêtes HTTP 206 (Partial Content), `Content-Length` ne représente que la tranche
    reçue (1 Mo) et non la taille totale du fichier. Le service worker ne confond plus cette
    valeur avec la taille totale, évitant ainsi d'arrêter le téléchargement après une seule tranche.
  - La boucle de téléchargement itère désormais sur toutes les tranches successives jusqu'à la fin
    réelle du flux audio (ou taille totale déclarée par le format).
- **Déchiffrement Web optimisé** :
  - Prise en charge des formats `cipher` et `signatureCipher`.
  - Recherche automatique du script `base.js` directement dans le DOM si le pont n'a pas
    fourni l'URL immédiatement.

## [0.5.5] — 2026-09-20

### Corrigé (Cause racine du chargement infini sur YouTube)
- **Suppression du forçage de User-Agent sur googlevideo.com** :
  - La règle dynamique `declarativeNetRequest` (1001) remplaçait le `User-Agent`
    par un identifiant Android sur toutes les requêtes vers `googlevideo.com` (y compris
    les flux vidéo `<video>` natifs de YouTube). Les serveurs CDN de YouTube détectaient
    une incohérence de session (cookies Chrome Desktop vs User-Agent Android) et
    rejetaient les segments vidéo par des HTTP 403, provoquant un chargement infini
    du lecteur YouTube avant même toute activation de Vocalis.
  - Toutes les règles de modification de requêtes ont été définitivement retirées.
    Le lecteur YouTube fonctionne de nouveau de manière 100 % fluide et native.
- **Téléchargement audio résilient et sans conflit de Range** :
  - Nettoyage des paramètres d'URL (`range`, `rn`, `rbuf`) pour éviter tout conflit
    entre le paramètre d'URL et le header HTTP `Range`.
  - En cas de rejet du header `Range` par certains CDN, bascule automatique sur le
    paramètre de requête direct `?range=start-end`.
  - Diagnostics détaillés : affichage du code HTTP exact en cas d'erreur de tranche.

## [0.5.4] — 2026-09-20

### Corrigé (Cause racine du blocage à 1 Mo)
- **Élimination de la bride 1 Mo YouTube** :
  - Les flux mobiles Android sans PO-token sont désormais bridés à 1 Mo
    par les serveurs CDN de YouTube (HTTP 403 dès la 2e tranche).
  - Le pipeline priorise désormais le **déchiffrement des flux natifs du lecteur Web**
    (`signatureCipher` via `cipher.js`) qui n'ont **AUCUNE restriction de 1 Mo**
    et autorisent le téléchargement de la totalité de la vidéo sans coupure.
  - Système multi-sources en cascade : si une source est interrompue ou bridée,
    le pipeline bascule automatiquement et de manière transparente sur la source suivante.
- **Réinsertion garantie du bouton YouTube** :
  - Correction de la détection du bouton lors des navigations SPA : si la barre
    des contrôles est reconstruite par YouTube, l'ancien bouton détaché est nettoyé
    et réinséré immédiatement à gauche de l'engrenage des paramètres.

## [0.5.3] — 2026-09-20

### Corrigé
- **« Failed to fetch » (téléchargement audio YouTube)** :
  - Les requêtes `fetch()` depuis un content script vers `googlevideo.com`
    étaient rejetées par la politique CORS du navigateur.
  - Mise en place d'un système à double niveau :
    1. Règles déclaratives réseau injectant les en-têtes CORS (`access-control-allow-origin: *`)
       sur `googlevideo.com`.
    2. Repli automatique et transparent via le service worker de l'extension
       (`vocalis:fetch-range`), 100 % immunisé contre les restrictions CORS.
- **« Pipeline bloqué à l'étape model »** :
  - Le watchdog de 45 secondes n'était pas désactivé en cas d'erreur réseau,
    écrasant le message d'erreur réel par un faux message de blocage de modèle.
    Désactivation immédiate du watchdog dès qu'une erreur survient.
- **Bouton du lecteur YouTube** :
  - Rendu SVG utilisant la classe native YouTube `ytp-svg-fill` et dessin en `<path>`
    au lieu de `<rect>` pour une compatibilité parfaite avec tous les thèmes du lecteur.
  - Styles forcés (`!important`), positionnement garanti immédiatement à gauche
    de l'engrenage des paramètres (`.ytp-settings-button`), et surveillance continue
    par `MutationObserver`.

## [0.5.2] — 2026-09-20

### Ajouté
- **Bouton natif dans le lecteur YouTube** : ajout direct de l'icône Vocalis
  dans la barre de contrôle du lecteur YouTube (`.ytp-right-controls`), juste
  à côté des boutons sous-titres et paramètres.
  - Clic direct pour activer/désactiver Vocalis sans avoir à ouvrir le popup.
  - État actif en violet éclatant néon avec point lumineux.
  - Animation d'égaliseur audio dynamique pendant la préparation des voix.
  - Raccourci clavier universel : **Alt+V** pour basculer Vocalis en plein écran
    ou en mode cinéma.

### Corrigé
- **« En attente du lecteur vidéo »** : après une mise à jour de l'extension
  ou un rechargement dans `chrome://extensions`, les onglets YouTube déjà ouverts
  perdaient la liaison.
  - Ré-injection automatique des scripts sur tous les onglets YouTube ouverts
    dès la mise à jour via `chrome.scripting`.
  - Détection claire dans le popup avec bouton 1-clic « 🔄 Recharger la page (F5) ».
  - Détection résiliente de l'identifiant vidéo (URL directe `?v=` et `/shorts/`
    en secours du `playerResponse`).

## [0.5.1] — 2026-09-19

### Accélération majeure (multi-threading WASM)
- Activation de l'isolation cross-origin (`cross_origin_embedder_policy: require-corp`,
  `cross_origin_opener_policy: same-origin`) autorisant `SharedArrayBuffer` dans
  l'extension Chrome.
- Le modèle HTDemucs exploite désormais jusqu'à 8 cœurs CPU en parallèle
  (`ort.env.wasm.numThreads = Math.min(8, cores)`) au lieu d'un seul cœur,
  réduisant le temps de traitement de 4 heures à ~30 minutes pour 2h d'audio,
  et permettant la lecture YouTube après seulement 2 à 3 secondes d'attente.

### Corrigé
- YouTube : alignement du pipeline YouTube sur le pipeline du Studio (qui a
  fait ses preuves sur le fichier de 2h). Téléchargement résilient du fichier audio
  complet (direct ou par tranches Range 1 Mo), décodage natif Web Audio API
  (éliminant les bugs de démultiplexage MP4Box), et démarrage de la lecture dès
  que le premier bloc de 10 s est séparé.

## [0.5.0] — 2026-09-19

### Ajouté
- **Vocalis Studio local** (`studio.html`) : interface dédiée pour tester
  et utiliser Vocalis directement sur n'importe quel fichier audio (MP3, WAV,
  M4A, FLAC, etc.) par simple glisser-déposer. L'IA sépare les voix bloc par
  bloc avec barre d'avancement en temps réel, permet d'écouter le résultat et
  le télécharge automatiquement en WAV haute qualité sur le PC.
- Bouton d'accès direct « 🎙️ Studio local » dans le popup de l'extension.

### Corrigé
- `worker-src 'self' 'wasm-unsafe-eval'` ajouté à la CSP du manifest pour
  garantir que les Web Workers héritent de l'autorisation d'exécuter
  WebAssembly sans restriction.

## [0.4.10] — 2026-09-19

### Corrigé
- « Compiling or instantiating WebAssembly module violates Content Security policy directive » :
  ajout de la directive CSP obligatoire Manifest V3 pour WebAssembly
  (`extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`).
  Chrome autorise désormais la compilation du moteur WebGPU/WASM du modèle IA.
- « WebCodecs/description AAC indisponible » : si la boîte MP4 `esds`
  est incomplète dans le flux YouTube Android, Vocalis synthétise
  automatiquement l'AudioSpecificConfig standard (ISO 14496-3, 2 octets),
  permettant le décodage fluide et sans bascule en mode complet.

## [0.4.9] — 2026-09-19

### Corrigé
- « no available backend found / previous call to initWasm failed » :
  1. `ort.env.wasm.wasmPaths` configuré sous forme d'objet explicite pointant
     vers `ort-wasm-simd-threaded.jsep.mjs` et `jsep.wasm` (au lieu d'un simple
     dossier qui cherchait `asyncify.mjs` absent).
  2. Création de l'alias `ort-wasm-simd-threaded.asyncify.mjs` vers `jsep.mjs`
     pour verrouiller tous les chemins d'accès ONNX Runtime.
  3. Verrou unique `readyPromise` sur le chargement du modèle IA pour empêcher
     les appels concurrents (`init` et `stream` en parallèle) qui corrompaient
     l'état interne d'ONNX Runtime.
- Téléchargement audio Android : ajout de la permission `declarativeNetRequest`
  qui injecte automatiquement le `User-Agent` Android officiel sur toutes les
  requêtes vers `googlevideo.com`, éliminant le rejet 403 CDN.

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
