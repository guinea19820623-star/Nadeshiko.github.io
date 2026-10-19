#!/bin/bash
# 撫子桌寵：雙擊啟動（第一次會先安裝 Electron）
cd "$(dirname "$0")/app" || exit 1
if [ ! -d node_modules/electron/dist ]; then
  npm install
  [ -d node_modules/electron/dist ] || node node_modules/electron/install.js
fi
nohup npx electron . >/dev/null 2>&1 &
