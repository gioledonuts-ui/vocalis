# Vocalis 🎙️

**Regarder des vidéos YouTube… sans la musique de fond.**

Vocalis est une extension Chrome pensée pour les streamers (et tous ceux qui
n'aiment pas la musique inutile) : elle retire la musique de fond des vidéos
YouTube pour ne garder que les voix et les sons utiles — directement sur ton
PC, sans envoyer tes données nulle part.

> ⚠️ **Statut : v0.2 — pipeline audio en place.**
> L'extension remplace déjà le son de la vidéo par sa version re-synchronisée
> (cache, seek instantané, barre « son traité », overlay de chargement) —
> mais joue pour l'instant le son **original**. Le modèle qui retire la
> musique s'insère en v0.3 sans rien changer au reste
> (voir la [feuille de route](docs/ROADMAP.md)).

---

## Pourquoi ?

Beaucoup de vidéos (documentaires, interviews, clips…) contiennent une musique
d'arrière-plan qui n'apporte rien et peut même gêner — notamment en stream, où
la musique pose aussi des questions de droits. Cette musique est **non
obligatoire** : ce qu'on veut entendre, c'est le contenu. Vocalis la supprime,
à la volée ou avec un court temps de chargement, pendant que la vidéo continue
de se charger en arrière-plan.

## Ce que fera l'extension (objectif final)

- 🎛️ Un bouton dans la barre d'extensions Chrome pour activer/désactiver
  Vocalis sur la vidéo en cours.
- ⏳ Un écran de chargement élégant sur le lecteur YouTube pendant la
  préparation du son, avec barre de progression.
- 🚄 Un chargement en arrière-plan pendant la lecture : la vidéo est jouable
  dès qu'assez de son est traité, le reste se traite pendant que tu regardes.
- 🔁 Pas de rechargement inutile : si tu reviens en arrière sur une partie déjà
  traitée, ça repart instantanément (cache conservé tant que tu restes sur la
  vidéo).
- 🧹 Cache vidé automatiquement quand tu quittes la vidéo (pas de dizaines de
  gigas qui traînent sur le disque).
- 📊 Une barre « son chargé » visible juste au-dessus de la barre rouge
  YouTube (comme la barre grise de buffer, mais pour le son traité).
- 🎚️ Un modèle d'IA de **bonne qualité** (pas le plus compressé) pour que les
  voix restent propres.

## Installation (première fois)

1. Télécharge ce dossier (bouton **Code → Download ZIP** sur GitHub, ou une
   release) et décompresse-le où tu veux sur ton PC. Garde le dossier tel quel.
2. Ouvre Chrome puis `chrome://extensions`.
3. Active le **Mode développeur** (en haut à droite).
4. Clique sur **Charger l'extension non empaquetée** et sélectionne le
   sous-dossier `extension/` de ce projet.
5. Épingle Vocalis dans la barre d'extensions (icône puzzle → 📌).

## Mise à jour (sans rien réinstaller)

Double-clique sur :

- **Windows** : `METTRE_A_JOUR.bat`
- **macOS / Linux** : `mettre_a_jour.sh` (dans un terminal : `./mettre_a_jour.sh`)

Le fichier interroge GitHub, récupère la dernière version et met à jour tous
les fichiers du dossier automatiquement. Il suffit ensuite de cliquer sur
**Actualiser** dans `chrome://extensions`.

> 📌 Par convention : chaque étape validée du projet est publiée en
> **Release GitHub**. Le fichier de mise à jour pointe toujours sur la
> dernière release — c'est donc elle qui fait foi.
>
> ⚠️ Ne rajoute pas de fichiers personnels dans ce dossier : la mise à jour
> synchronise le dossier avec le dépôt officiel.

## Comment ça marchera (version courte)

1. L'extension récupère le **flux audio** de la vidéo YouTube.
2. Elle le découpe en morceaux et chaque morceau passe dans un **modèle d'IA
   de séparation source** (voix d'un côté, musique de l'autre), exécuté en
   local via ONNX (WebGPU si ta carte graphique le permet, sinon processeur).
3. Le son sans musique est rejoué à la place de l'original, parfaitement
   synchronisé avec l'image.
4. Les morceaux traités sont gardés en **cache** (IndexedDB) tant que tu restes
   sur la vidéo ; le cache est purgé quand tu quittes la page.

Les détails techniques sont dans [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
et le choix du modèle dans [`docs/MODELES.md`](docs/MODELES.md).

## Structure du dépôt

```
vocalis/
├── METTRE_A_JOUR.bat        # Mise à jour locale en 1 clic (Windows)
├── mettre_a_jour.sh         # Mise à jour locale (macOS / Linux)
├── README.md
├── CHANGELOG.md
├── docs/
│   ├── ARCHITECTURE.md      # Comment l'extension fonctionne (pipeline)
│   ├── ROADMAP.md           # v0.1 → v0.5 : ce qui est prévu
│   └── MODELES.md           # Comparatif des modèles de séparation audio
├── extension/               # ← LE dossier à charger dans Chrome
│   ├── manifest.json        # Manifeste MV3
│   ├── background/          # Service worker
│   ├── content/             # Injecté sur les pages YouTube (UI + pipeline)
│   ├── popup/               # Fenêtre du bouton dans la barre Chrome
│   └── icons/               # Icônes de l'extension
└── scripts/
    ├── update.ps1           # Logique de mise à jour (appelé par le .bat)
    ├── package_release.sh   # Prépare le zip d'une release GitHub
    └── make_icons.py        # Régénère les icônes si besoin
```

## Feuille de route (résumé)

| Version | Contenu | Statut |
|---|---|---|
| v0.1 | Structure, manifeste, popup, interface de base, mise à jour auto, docs | ✅ |
| v0.2 | Pipeline audio complet **sans** modèle (lecture de l'audio original via notre tuyauterie) + overlay + barre de cache | ⏳ |
| v0.3 | Modèle IA de séparation (ONNX, WebGPU/WASM) : la musique disparaît vraiment | ⏳ |
| v0.4 | Réglages (qualité, pré-chargement, choix du modèle), robustesse | ⏳ |
| v0.5 | Mode « live » quasi temps réel, si les perfs le permettent | 💭 |

Détail : [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Confidentialité

Objectif non négociable (décision prise) : **tout le traitement se fait sur
ton PC, aucun mode serveur, jamais**. Aucun audio ne quitte ta machine. Le
système est calibré pour un PC de stream Windows avec GPU récent
(RTX 30xx/40xx) via WebGPU ; sur une config sans GPU, mode dégradé
(pré-chargement plus long) — mais rien ne part en ligne.

## Signaler un problème

Ouvre une **issue** sur le dépôt GitHub avec : ce que tu as fait, ce qui s'est
passé, ta config (Windows/Mac, carte graphique, RAM).
