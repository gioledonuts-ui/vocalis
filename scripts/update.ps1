# ============================================================
#  VOCALIS - Mise a jour locale depuis GitHub
#  Appele par METTRE_A_JOUR.bat (Windows) ou directement :
#    powershell -ExecutionPolicy Bypass -File scripts\update.ps1
# ============================================================
param(
    [string]$TargetDir = ""
)

$ErrorActionPreference = "Stop"
$repo = "gioledonuts-ui/vocalis"
$headers = @{ "User-Agent" = "vocalis-updater"; "Accept" = "application/vnd.github+json" }

if (-not $TargetDir) { $TargetDir = Split-Path -Parent $PSScriptRoot }
$TargetDir = (Resolve-Path $TargetDir).Path.TrimEnd('\','/')

Write-Host ""
Write-Host "  VOCALIS - mise a jour depuis GitHub" -ForegroundColor Cyan
Write-Host "  Dossier cible : $TargetDir" -ForegroundColor DarkGray
Write-Host ""

# ------------------------------------------------------------
# 1) Trouver quoi telecharger : derniere release sinon main
# ------------------------------------------------------------
$zipUrl = $null
$version = $null
try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
    $asset = $rel.assets | Where-Object { $_.name -like "*.zip" } | Select-Object -First 1
    if ($asset) { $zipUrl = $asset.browser_download_url } else { $zipUrl = $rel.zipball_url }
    $version = $rel.tag_name
} catch {
    Write-Host "  Aucune release trouvee, bascule sur la branche main..." -ForegroundColor Yellow
    $zipUrl = "https://codeload.github.com/$repo/zip/refs/heads/main"
    $version = "main"
}

Write-Host "  Version detectee : $version" -ForegroundColor DarkGray
Write-Host "  Telechargement..."

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("vocalis-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp "vocalis.zip"

try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zip -Headers $headers
} catch {
    Write-Host "  [ERREUR] Telechargement impossible : $_" -ForegroundColor Red
    Write-Host "  Verifie ta connexion internet puis relance." -ForegroundColor Yellow
    Read-Host "  Appuie sur Entree pour fermer"
    exit 1
}

# ------------------------------------------------------------
# 2) Extraire et trouver la racine du projet
# ------------------------------------------------------------
Write-Host "  Extraction..."
Expand-Archive -Path $zip -DestinationPath $tmp -Force

$root = $tmp
if (-not (Test-Path (Join-Path $root "extension" "manifest.json"))) {
    $candidate = Get-ChildItem -Path $tmp -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName "extension" "manifest.json") } |
        Select-Object -First 1
    if ($candidate) { $root = $candidate.FullName }
    else {
        Write-Host "  [ERREUR] extension/manifest.json introuvable dans l'archive." -ForegroundColor Red
        Read-Host "  Appuie sur Entree pour fermer"
        exit 1
    }
}

# ------------------------------------------------------------
# 3) Synchroniser le dossier local avec la version telechargee
#    (/MIR = miroir ; .git est preserve si le dossier est un clone)
# ------------------------------------------------------------
Write-Host "  Mise a jour des fichiers..."
& robocopy $root $TargetDir /MIR /XD ".git" /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) {
    Write-Host "  [ERREUR] La copie des fichiers a echoue (robocopy $LASTEXITCODE)." -ForegroundColor Red
    Read-Host "  Appuie sur Entree pour fermer"
    exit 1
}

Write-Host ""
Write-Host "  ✔ Mise a jour terminee ($version)." -ForegroundColor Green
Write-Host "  Ouvre chrome://extensions et clique sur 'Actualiser' pour Vocalis." -ForegroundColor Yellow
Write-Host "  (La page des extensions va s'ouvrir.)" -ForegroundColor DarkGray
Write-Host ""
Start-Process "chrome.exe" "chrome://extensions" -ErrorAction SilentlyContinue
Read-Host "  Appuie sur Entree pour fermer"
