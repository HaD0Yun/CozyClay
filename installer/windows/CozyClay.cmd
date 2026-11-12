@echo off
rem CozyClay launcher (installer/windows): runs the Studio with the Node.js that came with the installer.
rem It always starts the newest release. Extra arguments go to cozyclay (for example --no-open).
title CozyClay
set "PATH=%~dp0node;%PATH%"
echo.
echo   Starting CozyClay. The Studio opens in your browser.
echo   Keep this window open while you work. Close it to stop CozyClay.
echo   The first start downloads CozyClay and can take a few minutes.
echo.
call "%~dp0node\npx.cmd" --yes cozyclay@latest --via installer %*
if errorlevel 1 (
  echo.
  echo   CozyClay stopped with an error. Check your internet connection and start it again.
  pause
)
