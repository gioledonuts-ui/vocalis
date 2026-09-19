@echo off
setlocal EnableExtensions
title Vocalis - Mise a jour

rem ============================================================
rem  VOCALIS - MISE A JOUR EN 1 CLIC (Windows 10/11)
rem
rem  Tout est fait avec des outils fournis par Windows :
rem    curl.exe (telechargement), tar.exe (extraction),
rem    robocopy.exe (copie), PowerShell (lecture du JSON GitHub).
rem  Aucun git, aucune commande a copier.
rem
rem  Anti-ecrasement : ce fichier se copie d'abord dans %TEMP%
rem  et s'execute depuis la-bas, ce qui lui permet de mettre a
rem  jour TOUS les fichiers du dossier, y compris lui-meme.
rem ============================================================

rem --- bootstrap : lance sans argument (double-clic) ---
if not "%~1"=="" goto MAIN
where curl.exe >nul 2>&1 || ( echo [ERREUR] curl.exe introuvable : Windows 10 (1803) ou plus recent requis. & pause & exit /b 1 )
copy /y "%~f0" "%TEMP%\vocalis-run.bat" >nul 2>&1
if errorlevel 1 ( echo [ERREUR] Preparation impossible. & pause & exit /b 1 )
call "%TEMP%\vocalis-run.bat" "%~dp0"
exit /b %errorlevel%

:MAIN
set "TARGET=%~1"
set "REPO=gioledonuts-ui/vocalis"
set "TMPD=%TEMP%\vocalis-up-%RANDOM%%RANDOM%"
mkdir "%TMPD%" 2>nul

echo.
echo   VOCALIS - mise a jour depuis GitHub
echo   Dossier : %TARGET%
echo.

rem --- 1) derniere release, sinon branche main ---
set "ZIPURL="
set "VERSION="
curl.exe -fsSL -H "User-Agent: vocalis-updater" "https://api.github.com/repos/%REPO%/releases/latest" -o "%TMPD%\rel.json" 2>nul
if exist "%TMPD%\rel.json" (
    for /f "usebackq delims=" %%L in (`powershell -NoProfile -Command "$j = Get-Content -Raw -Encoding UTF8 '%TMPD%\rel.json' | ConvertFrom-Json; $a = $j.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1; if ($a) { $a.browser_download_url } else { $j.zipball_url }; $j.tag_name"`) do (
        if not defined ZIPURL (set "ZIPURL=%%L") else (set "VERSION=%%L")
    )
)
if not defined ZIPURL (
    echo   Aucune release trouvee : bascule sur la branche main.
    set "ZIPURL=https://codeload.github.com/%REPO%/zip/refs/heads/main"
    set "VERSION=main"
)
echo   Version : %VERSION%

rem --- 2) telechargement ---
echo   Telechargement...
curl.exe -fSL -H "User-Agent: vocalis-updater" "%ZIPURL%" -o "%TMPD%\v.zip"
if errorlevel 1 (
    echo.
    echo   [ERREUR] Telechargement impossible. Verifie ta connexion internet.
    pause
    exit /b 1
)

rem --- 3) extraction ---
echo   Extraction...
tar -xf "%TMPD%\v.zip" -C "%TMPD%"
if errorlevel 1 ( echo   [ERREUR] Extraction impossible. & pause & exit /b 1 )

rem --- 4) racine du projet dans l'archive ---
set "ROOT="
if exist "%TMPD%\extension\manifest.json" set "ROOT=%TMPD%"
if not defined ROOT (
    for /d %%D in ("%TMPD%\*") do (
        if exist "%%~D\extension\manifest.json" set "ROOT=%%~D"
    )
)
if not defined ROOT ( echo   [ERREUR] Archive invalide. & pause & exit /b 1 )

rem --- 5) synchronisation du dossier (le .git eventuel est preserve) ---
echo   Mise a jour des fichiers...
robocopy "%ROOT%" "%TARGET%" /MIR /XD ".git" /NFL /NDL /NJH /NJS
if errorlevel 8 ( echo   [ERREUR] Copie impossible. & pause & exit /b 1 )

rmdir /s /q "%TMPD%" 2>nul

echo.
echo   Mise a jour terminee (%VERSION%).
echo   Ouvre chrome://extensions et clique sur "Actualiser" pour Vocalis.
echo.
pause
exit /b 0
