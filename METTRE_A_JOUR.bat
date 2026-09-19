@echo off
setlocal EnableExtensions
title Vocalis - Mise a jour

rem ============================================================
rem  VOCALIS - MISE A JOUR EN 1 CLIC (Windows 10/11)
rem  Outils natifs Windows : curl.exe, tar.exe, robocopy.exe.
rem  PowerShell ne sert qu'a lire le petit JSON GitHub (ecrit
rem  dans des fichiers temporaires : AUCUN for /f, AUCUNE
rem  parenthese piege pour cmd).
rem  Anti-ecrasement : ce fichier se copie dans %TEMP% et
rem  s'execute depuis la-bas.
rem ============================================================

rem --- bootstrap (double-clic, sans argument) ---
if not "%~1"=="" goto MAIN
where curl.exe >nul 2>&1 || ( echo [ERREUR] curl.exe introuvable : Windows 10 1803+ requis. & pause & exit /b 1 )
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

rem --- 1) derniere release : JSON puis extraction via fichiers temporaires ---
set "ZIPURL="
set "VERSION="
curl.exe -fsSL -H "User-Agent: vocalis-updater" "https://api.github.com/repos/%REPO%/releases/latest" -o "%TMPD%\rel.json" 2>nul
if exist "%TMPD%\rel.json" powershell -NoProfile -Command "try { $j = Get-Content -Raw -Encoding UTF8 '%TMPD%\rel.json' | ConvertFrom-Json; $a = $j.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1; if ($a) { Set-Content -Encoding ASCII -Path '%TMPD%\url.txt' -Value $a.browser_download_url } else { Set-Content -Encoding ASCII -Path '%TMPD%\url.txt' -Value $j.zipball_url }; Set-Content -Encoding ASCII -Path '%TMPD%\ver.txt' -Value $j.tag_name } catch { exit 0 }"
if exist "%TMPD%\url.txt" set /p ZIPURL=<"%TMPD%\url.txt"
if exist "%TMPD%\ver.txt" set /p VERSION=<"%TMPD%\ver.txt"
if not defined ZIPURL set "ZIPURL=https://codeload.github.com/%REPO%/zip/refs/heads/main"
if not defined VERSION set "VERSION=main"
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

rem --- 5) synchronisation (le .git eventuel est preserve) ---
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
