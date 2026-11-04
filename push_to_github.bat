@echo off
title Push DuoSave to GitHub
echo ========================================================
echo           PUSHING DUOSAVE TO GITHUB
echo           Repository: https://github.com/NziX/Duasaving
echo ========================================================
echo.

set "PATH=C:\Users\HP\.gemini\antigravity\scratch\mingit\cmd;%PATH%"
cd /d "C:\Users\HP\.gemini\antigravity\scratch\couple-savings-tracker"

git add .
git commit -m "update: sync couple savings tracker changes"
git push -u origin main

echo.
echo ========================================================
echo Complete! Press any key to exit.
echo ========================================================
pause
