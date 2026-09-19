#!/usr/bin/env bash
# ============================================================
#  VOCALIS - Mise à jour locale depuis GitHub (macOS / Linux)
#  Usage : ./mettre_a_jour.sh
# ============================================================
set -euo pipefail

REPO="gioledonuts-ui/vocalis"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-$SCRIPT_DIR}"

echo ""
echo "  VOCALIS - mise à jour depuis GitHub"
echo "  Dossier cible : $TARGET_DIR"
echo ""

command -v curl >/dev/null || { echo "  [ERREUR] curl est requis."; exit 1; }
if ! command -v unzip >/dev/null; then
  echo "  [ERREUR] unzip est requis (ex: sudo apt install unzip)."
  exit 1
fi

# 1) Dernière release, sinon branche main
ZIP_URL=""
VERSION=""
if RELEASE_JSON=$(curl -fsSL -H "User-Agent: vocalis-updater" "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null); then
  ZIP_URL=$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*\.zip"' | head -n1 | cut -d'"' -f4 || true)
  if [ -z "$ZIP_URL" ]; then
    ZIP_URL=$(printf '%s' "$RELEASE_JSON" | grep -o '"zipball_url": *"[^"]*"' | head -n1 | cut -d'"' -f4 || true)
  fi
  VERSION=$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -n1 | cut -d'"' -f4 || true)
fi
if [ -z "$ZIP_URL" ]; then
  echo "  Aucune release trouvée, bascule sur la branche main..."
  ZIP_URL="https://codeload.github.com/$REPO/zip/refs/heads/main"
  VERSION="main"
fi

echo "  Version détectée : ${VERSION:-inconnue}"
echo "  Téléchargement..."

TMP="$(mktemp -d /tmp/vocalis.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
curl -fSL -H "User-Agent: vocalis-updater" -o "$TMP/vocalis.zip" "$ZIP_URL"

# 2) Extraire et trouver la racine du projet
echo "  Extraction..."
unzip -q "$TMP/vocalis.zip" -d "$TMP"
ROOT="$TMP"
if [ ! -f "$ROOT/extension/manifest.json" ]; then
  # Le zip GitHub contient un dossier préfixe (ex: vocalis-v0.1.0/) :
  # on cherche le manifest.json (profondeur 2 ou 3) et on remonte à la racine.
  ROOT="$(find "$TMP" -mindepth 2 -maxdepth 3 -type f -name manifest.json -path '*extension*' 2>/dev/null \
        | head -n1 | xargs -r dirname | xargs -r dirname || true)"
fi
if [ -z "${ROOT:-}" ] || [ ! -f "$ROOT/extension/manifest.json" ]; then
  echo "  [ERREUR] extension/manifest.json introuvable dans l'archive."
  exit 1
fi

# 3) Synchroniser (sans toucher à .git si le dossier est un clone)
echo "  Mise à jour des fichiers..."
rsync -a --delete --exclude '.git' "$ROOT/" "$TARGET_DIR/" 2>/dev/null || {
  # Repli sans rsync
  find "$TARGET_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
  cp -R "$ROOT/." "$TARGET_DIR/"
}

echo ""
echo "  ✔ Mise à jour terminée (${VERSION:-?})."
echo "  Ouvre chrome://extensions et clique sur « Actualiser » pour Vocalis."
echo ""
