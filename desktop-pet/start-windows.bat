@echo off
chcp 65001 >nul
rem 撫子桌寵：雙擊啟動（第一次會先安裝 Electron）
cd /d "%~dp0app"
if not exist node_modules\electron\dist\electron.exe (
  echo 第一次啟動，正在安裝 Electron，請稍等...
  call npm install
  if not exist node_modules\electron\dist\electron.exe node node_modules\electron\install.js
)
start "" "node_modules\electron\dist\electron.exe" .
