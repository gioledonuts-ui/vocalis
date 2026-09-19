@echo off
setlocal EnableExtensions
title Vocalis - Modele IA

rem ============================================================
rem  Telecharge UNE fois le modele IA (~172 Mo, Hugging Face,
rem  depot PUBLIC) dans extension\models\. Ensuite l'extension
rem  le lit LOCALEMENT, sans rien telecharger.
rem  Ce fichier n'est jamais ecrase par les mises a jour
rem  (dossier non suivi par git).
rem ============================================================

set "DEST=%~dp0extension\models\htdemucs_embedded.onnx"

if exist "%DEST%" (
    echo   Le modele est deja la : %DEST%
    echo   Rien a faire.
    pause
    exit /b 0
)

mkdir "%~dp0extension\models" 2>nul
where curl.exe >nul 2>&1 || ( echo [ERREUR] curl.exe introuvable. & pause & exit /b 1 )

echo.
echo   VOCALIS - telechargement du modele IA (~172 Mo)
echo   Source : Hugging Face (public). Ca peut prendre quelques minutes.
echo.
curl.exe -fL --progress-bar -o "%DEST%" "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx"
if errorlevel 1 (
    echo.
    echo   [ERREUR] Telechargement impossible. Relance quand tu as une bonne connexion.
    if exist "%DEST%" del "%DEST%"
    pause
    exit /b 1
)

echo.
echo   Modele installe : %DEST%
echo   L'extension l'utilisera sans rien telecharger.
echo.
pause
exit /b 0
