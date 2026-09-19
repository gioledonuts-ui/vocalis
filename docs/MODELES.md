# Choix du modèle de séparation audio

> Contrainte forte du projet : **bonne qualité audible**. On ne veut pas du
> modèle le plus léger si c'est pour des voix métalliques ou de la musique
> résiduelle. La vitesse compte aussi, car tout tourne sur le PC du streamer
> pendant qu'il regarde la vidéo.

## Ce qu'on demande au modèle

1. Séparer **voix** (dialogue, narration) et **musique de fond**.
2. Qualité : SDR élevé sur les voix, peu d'artefacts (« musical noise »).
3. Vitesse : idéalement plus rapide que le temps réel sur un GPU récent
   (mode pré-chargement), sinon le plus proche possible.
4. Exécutable en local dans le navigateur : export **ONNX**, via
   [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) (WebGPU/WASM).
5. Licence compatible (MIT/Apache ou équivalent).

## Comparatif (état des lieux)

| Modèle | Qualité voix | Vitesse | Taille approx. | Licence | Remarques |
|---|---|---|---|---|---|
| **Demucs v4 (htdemucs)** | Très bonne (~8,8 dB SDR) | Moyenne | ~80 Mo (ONNX) | MIT | Référence robuste, exports ONNX connus |
| **Demucs v4 fine-tuned (htdemucs_ft)** | Excellente (~10 dB+) | Plus lent (×4 passes) | ~80 Mo (ONNX) | MIT | Le meilleur des Demucs ; lourd en CPU |
| **BS-RoFormer / Mel-Band RoFormer** (type UVR) | Excellente sur les voix | Rapide | 50–150 Mo selon variante | À vérifier par checkpoint | Très bons résultats sur voix/narration, plusieurs variantes communautaires |
| **Spleeter 2 stems** | Moyenne | Rapide | ~30 Mo | MIT | Historique, artefacts audibles ; écarté vu l'exigence qualité |

## Décision actée (v0.3, livrée)

- **`htdemucs_embedded.onnx`** (export ONNX de HTDemucs par
  [demucs-web](https://github.com/timcsy/demucs-web), MIT) : le seul export
  ONNX de Demucs avec parité vérifiée et chemin onnxruntime-web documenté.
  Hébergé sur Hugging Face (`timcsy/demucs-web-onnx`), téléchargé au premier
  lancement, mis en cache IndexedDB.
- Exécution WebGPU (machine cible RTX 30/40) avec repli WASM.
- **Challenger v0.4 : BS-RoFormer / Mel-Band RoFormer en ONNX** (ex. exports
  HF `silverdaw/*`, `bgkb/bs_polarformer` — SDR ~11) à benchmarker sur la
  machine du streamer ; s'il gagne à qualité égale, il devient le défaut ou
  une option « qualité max ».

## Machine cible (décidé)

PC de stream **Windows 11** avec **GPU récent (RTX 30xx/40xx)** → l'axe
principal est **WebGPU**, où htdemucs tourne plusieurs fois plus vite que le
temps réel : le mode « pré-chargement puis arrière-plan » sera confortable et
le mode « live » (v0.5) est très plausible. Le repli WASM (sans GPU) reste
prévu mais n'est pas le cas nominal.

## Implications concrètes

- Le modèle est téléchargé **une seule fois** au premier usage (asset de
  release GitHub), jamais stocké dans git.
- Les segments (~10 s) sont traités par lots ; sur un GPU récent (WebGPU),
  une seconde de calcul doit traiter plusieurs secondes d'audio → le mode
  « pré-chargement puis arrière-plan » est confortable.
- Sur CPU seul (WASM simple thread), le traitement peut être plus lent que
  la lecture : l'interface devra l'afficher clairement et proposer un
  pré-chargement plus généreux. C'est le principal point d'attention.
