@echo off
title Couple Savings Tracker (10,000 RWF)
cd /d "%~dp0"
echo ========================================================
echo   Launching Couple Shared Savings & Loan Tracker...
echo ========================================================
echo.
echo Target Rule: 10,000 RWF per month each
echo Opening in browser: http://localhost:3000
echo.
start http://localhost:3000
node server.js
pause
