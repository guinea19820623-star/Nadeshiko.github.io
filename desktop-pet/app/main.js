'use strict';
// 撫子桌寵：Electron 主程序
// 負責：透明視窗、點擊穿透切換、拖曳、右鍵選單、設定保存、輪詢 Claude 狀態檔。
const { app, BrowserWindow, ipcMain, Menu, Tray, screen, shell, nativeImage, powerMonitor, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const bridge = require('./lib/bridge');
const { layout } = require('./lib/statecore');

const BUBBLE_H = layout(250).bubbleH; // 視窗上方留給頭上小字的高度
const SIZE_PRESETS = [
  ['迷你', 140], ['小', 190], ['中', 250], ['大', 330], ['特大', 440],
];
const SIZE_MIN = 100;
const SIZE_MAX = 640;

const DEFAULT_SETTINGS = {
  size: 250,
  x: null,
  y: null,
  walk: true,
  fly: true,
  random: true,
  bubble: true,
  staminaAlways: false,
  voice: true,
  volume: 60,
  alwaysOnTop: true,
  hotkey: 'CommandOrControl+Alt+N',
  tiredAt: 85,
  faintAt: 100,
  napAt: 100,
};

let settings = { ...DEFAULT_SETTINGS };
let pet = null;
let panel = null;
let tray = null;
let forced = null;      // 測試用：強制顯示的狀態
let dragTimer = null;
let lastSnapshotJSON = '';
let saveTimer = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  const s = bridge.readJSON(settingsFile());
  if (s) settings = { ...DEFAULT_SETTINGS, ...s };
  settings.size = clampSize(settings.size);
}

function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { bridge.writeJSON(settingsFile(), settings); } catch (e) { console.error(e); }
  }, 400);
}

function clampSize(v) {
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(Number(v) || DEFAULT_SETTINGS.size)));
}

function winSize(size = settings.size) {
  const l = layout(size);
  return { width: l.width, height: l.height };
}

// 一律帶著固定寬高設定位置：Windows 在 125%/150% 縮放下，
// 對不可縮放的透明視窗反覆 setPosition 會讓視窗尺寸漂移，泡泡就跟角色對不上
function placePet(x, y) {
  if (!pet) return;
  const { width, height } = winSize();
  pet.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
}

function displayFor(bounds) {
  return screen.getDisplayMatching(bounds);
}

function createPet() {
  const { width, height } = winSize();
  const primary = screen.getPrimaryDisplay().workArea;
  let x = settings.x;
  let y = settings.y;
  // 記住的位置不在任何螢幕內（例如拔掉外接螢幕）就回到主螢幕右下
  const visible = x != null && screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return x + width / 2 >= w.x && x + width / 2 <= w.x + w.width && y + height / 2 >= w.y && y <= w.y + w.height;
  });
  if (!visible) {
    x = primary.x + primary.width - width - 40;
    y = primary.y + primary.height - height;
  }

  pet = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  applyOnTop();
  pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  pet.setIgnoreMouseEvents(true, { forward: true });
  pet.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  pet.on('closed', () => { pet = null; app.quit(); });
}

function send(channel, payload) {
  if (pet && !pet.isDestroyed()) pet.webContents.send(channel, payload);
}

function broadcastSettings() {
  send('pet:settings', settings);
  if (panel && !panel.isDestroyed()) panel.webContents.send('panel:settings', settings);
  rebuildTray();
}

function setSize(size) {
  size = clampSize(size);
  if (!pet) return;
  const b = pet.getBounds();
  const { width, height } = winSize(size);
  // 以腳底中心為基準縮放，人不會跳走
  const cx = b.x + b.width / 2;
  const bottom = b.y + b.height;
  pet.setBounds({ x: Math.round(cx - width / 2), y: Math.round(bottom - height), width, height });
  settings.size = size;
  saveSettingsSoon();
  broadcastSettings();
}

// 語音台詞表 + 實際存在的音檔（沒有音檔就只出字，不會壞）
function readVoice() {
  const dir = path.join(__dirname, 'voice');
  let lines = {};
  let files = [];
  try { lines = JSON.parse(fs.readFileSync(path.join(dir, 'lines.json'), 'utf8')); } catch (_) { /* 沒有台詞表就當沒有語音 */ }
  try { files = fs.readdirSync(dir); } catch (_) { /* ignore */ }
  return { lines, files };
}

function updateSetting(key, value) {
  settings[key] = value;
  if (key === 'alwaysOnTop' && pet) applyOnTop();
  if (key === 'size') return setSize(value);
  saveSettingsSoon();
  broadcastSettings();
}

// 「保持在最上層」：用最高的層級（screen-saver），瀏覽器或影片全螢幕時才比較不會被蓋住；
// macOS 另外讓她出現在全螢幕的桌面空間。Windows 上的實際效果仍取決於全螢幕程式的種類，見 README。
function applyOnTop() {
  if (!pet || pet.isDestroyed()) return;
  if (settings.alwaysOnTop) {
    pet.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    pet.moveTop();
  } else {
    pet.setAlwaysOnTop(false);
  }
}

// 視窗大小先差 1px 再改回來：實測螢幕休眠重啟後「拎不起來、重新調整尺寸就好」，
// 調尺寸會讓系統重新建立視窗的邊界與命中範圍，所以這裡做同樣的動作（透明視窗，看不出來）
function nudgeBounds() {
  if (!pet || pet.isDestroyed()) return;
  const b = pet.getBounds();
  const { width, height } = winSize();
  pet.setBounds({ x: b.x, y: b.y, width: width + 1, height });
  pet.setBounds({ x: b.x, y: b.y, width, height });
}

function recoverPet() {
  if (!pet || pet.isDestroyed()) return;
  clearInterval(dragTimer);
  dragTimer = null;
  nudgeBounds();
  pet.setIgnoreMouseEvents(true, { forward: true });
  if (!pet.isVisible()) pet.showInactive();
  applyOnTop();
  send('pet:recover');
}

// 喚醒：重整視窗、頂到最上層、人物醒來（躺著就爬起來，否則揮手）；人物在螢幕外就帶回右下角
function summonPet() {
  if (!pet || pet.isDestroyed()) return;
  const b = pet.getBounds();
  const onScreen = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x + b.width / 2 >= w.x && b.x + b.width / 2 <= w.x + w.width && b.y + b.height / 2 >= w.y && b.y + b.height / 2 <= w.y + w.height;
  });
  if (!onScreen) resetPosition();
  recoverPet();
  pet.moveTop();
  setTimeout(() => send('pet:summon'), 150);
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const key = settings.hotkey;
  if (!key) return;
  try {
    if (!globalShortcut.register(key, summonPet)) console.error(`快捷鍵 ${key} 被別的程式佔用，改 settings.json 的 hotkey 換一組`);
  } catch (e) {
    console.error('hotkey', e.message);
  }
}

// ---------- Claude 狀態檔輪詢 ----------
function pollSnapshot() {
  const snap = bridge.readSnapshot();
  const json = JSON.stringify(snap);
  if (json !== lastSnapshotJSON) {
    lastSnapshotJSON = json;
    send('pet:snapshot', snap);
    if (panel && !panel.isDestroyed()) panel.webContents.send('panel:snapshot', snap);
  }
}

// ---------- 選單 ----------
const TEST_STATES = [
  ['free', '精神飽滿（隨機行為）'],
  ['thinking', '思考中'],
  ['working', '工作中'],
  ['waiting', '等你確認'],
  ['done', '完成'],
  ['hello', '打招呼'],
  ['tired', '疲憊（用量 85%+）'],
  ['exhausted', '5 小時額度用完（睡覺）'],
  ['faint', '暈倒（週上限）'],
];
const ACTIONS = [
  ['walk', '走一走'], ['fly', '飛一圈'], ['yawn', '打哈欠'], ['stretch', '伸懶腰'],
  ['wave', '揮手'], ['curious', '東張西望'], ['cheer', '歡呼'], ['nap', '睡午覺'],
  ['sit', '坐下休息'], ['wake', '睡醒爬起來'],
];

function menuTemplate() {
  const sizeItems = SIZE_PRESETS.map(([label, v]) => ({
    label: `${label}（${v}px）`, type: 'radio', checked: settings.size === v, click: () => setSize(v),
  }));
  sizeItems.push({ type: 'separator' },
    { label: '放大一點', accelerator: 'CommandOrControl+Plus', click: () => setSize(settings.size * 1.1) },
    { label: '縮小一點', accelerator: 'CommandOrControl+-', click: () => setSize(settings.size / 1.1) },
    { label: '自訂…（控制面板）', click: openPanel });
  return [
    { label: `撫子 · ${settings.size}px`, enabled: false },
    { type: 'separator' },
    { label: '尺寸', submenu: sizeItems },
    { label: '動作', submenu: ACTIONS.map(([k, l]) => ({ label: l, click: () => send('pet:action', k) })) },
    {
      label: '測試狀態',
      submenu: [
        { label: '自動（跟 Claude 連動）', type: 'radio', checked: forced == null, click: () => setForced(null) },
        { type: 'separator' },
        ...TEST_STATES.map(([k, l]) => ({ label: l, type: 'radio', checked: forced === k, click: () => setForced(k) })),
      ],
    },
    { type: 'separator' },
    { label: '隨機動作', type: 'checkbox', checked: settings.random, click: (i) => updateSetting('random', i.checked) },
    { label: '在螢幕下緣走動', type: 'checkbox', checked: settings.walk, click: (i) => updateSetting('walk', i.checked) },
    { label: '偶爾飛起來', type: 'checkbox', checked: settings.fly, click: (i) => updateSetting('fly', i.checked) },
    { label: '語音', type: 'checkbox', checked: settings.voice, click: (i) => updateSetting('voice', i.checked) },
    {
      label: '音量',
      submenu: [20, 40, 60, 80, 100].map((v) => ({
        label: `${v}%`, type: 'radio', checked: Math.abs(settings.volume - v) < 10, click: () => updateSetting('volume', v),
      })),
    },
    { label: '頭上小字', type: 'checkbox', checked: settings.bubble, click: (i) => updateSetting('bubble', i.checked) },
    { label: '體力條常駐', type: 'checkbox', checked: settings.staminaAlways, click: (i) => updateSetting('staminaAlways', i.checked) },
    { label: '保持在最上層', type: 'checkbox', checked: settings.alwaysOnTop, click: (i) => updateSetting('alwaysOnTop', i.checked) },
    {
      label: '開機自動啟動', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }),
    },
    { type: 'separator' },
    { label: '控制面板與模擬器…', click: openPanel },
    { label: `喚醒（${(settings.hotkey || '').replace('CommandOrControl', 'Ctrl')}）`, click: summonPet },
    { label: '回到螢幕右下角', click: resetPosition },
    { label: '打開狀態資料夾', click: () => { fs.mkdirSync(bridge.stateDir(), { recursive: true }); shell.openPath(bridge.stateDir()); } },
    { type: 'separator' },
    { label: '結束', click: () => app.quit() },
  ];
}

function popupMenu() {
  Menu.buildFromTemplate(menuTemplate()).popup({ window: pet });
}

function rebuildTray() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function setForced(k) {
  forced = k;
  send('pet:force', k);
  if (panel && !panel.isDestroyed()) panel.webContents.send('panel:force', k);
  rebuildTray();
}

function resetPosition() {
  if (!pet) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const b = pet.getBounds();
  placePet(wa.x + wa.width - b.width - 40, wa.y + wa.height - b.height);
  send('pet:action', 'land');
}

function openPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  panel = new BrowserWindow({
    // 羊皮紙卷軸當窗框：無邊框、透明，內容限制在紙面內（比例 560:778）
    width: 560, height: 778, title: '撫子 控制面板', autoHideMenuBar: true,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  panel.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  panel.on('closed', () => { panel = null; });
}

// ---------- IPC ----------
function setupIPC() {
  ipcMain.handle('pet:init', () => ({
    settings,
    forced,
    bubbleH: BUBBLE_H,
    manifest: bridge.readJSON(path.join(__dirname, 'sprites', 'manifest.json')),
    snapshot: bridge.readSnapshot(),
    voice: readVoice(),
    stateDir: bridge.stateDir(),
  }));

  ipcMain.on('pet:set-ignore', (_e, ignore) => {
    if (pet) pet.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  ipcMain.handle('pet:geom', () => {
    if (!pet) return null;
    const b = pet.getBounds();
    return { bounds: b, workArea: displayFor(b).workArea, cursor: screen.getCursorScreenPoint() };
  });

  ipcMain.on('pet:move', (_e, x, y) => {
    if (!pet) return;
    placePet(x, y);
    settings.x = Math.round(x);
    settings.y = Math.round(y);
    saveSettingsSoon();
  });

  // 拖曳在主程序跟游標，滑鼠甩出視窗也不會掉
  ipcMain.on('pet:drag-start', (_e, gx, gy) => {
    if (!pet) return;
    nudgeBounds();
    clearInterval(dragTimer);
    let last = screen.getCursorScreenPoint();
    let lastT = Date.now();
    dragTimer = setInterval(() => {
      if (!pet) return;
      const c = screen.getCursorScreenPoint();
      const t = Date.now();
      const dt = Math.max(1, t - lastT);
      placePet(c.x - gx, c.y - gy);
      send('pet:drag-move', { vx: ((c.x - last.x) / dt) * 16, vy: ((c.y - last.y) / dt) * 16 });
      last = c; lastT = t;
    }, 16);
  });

  ipcMain.on('pet:drag-end', () => {
    clearInterval(dragTimer);
    dragTimer = null;
    if (pet) {
      const b = pet.getBounds();
      settings.x = b.x; settings.y = b.y;
      saveSettingsSoon();
    }
  });

  ipcMain.on('pet:menu', popupMenu);
  ipcMain.on('pet:resize-step', (_e, dir) => setSize(settings.size * (dir > 0 ? 1.08 : 1 / 1.08)));

  // 控制面板
  ipcMain.handle('panel:init', () => ({ settings, forced, snapshot: bridge.readSnapshot(), stateDir: bridge.stateDir(), sizeMin: SIZE_MIN, sizeMax: SIZE_MAX }));
  ipcMain.on('panel:set', (_e, key, value) => updateSetting(key, value));
  ipcMain.on('panel:force', (_e, k) => setForced(k || null));
  ipcMain.on('panel:action', (_e, k) => send('pet:action', k));
  // 模擬器：走跟真正 hooks 一樣的寫檔路徑
  ipcMain.on('sim:hook', (_e, input) => { bridge.applyHookEvent({ session_id: 'simulator', cwd: 'simulator', ...input }); pollSnapshot(); });
  ipcMain.on('sim:usage', (_e, five, week) => {
    const now = Math.floor(Date.now() / 1000);
    bridge.applyStatusline({
      rate_limits: {
        five_hour: { used_percentage: Number(five), resets_at: now + 2 * 3600 },
        seven_day: { used_percentage: Number(week), resets_at: now + 3 * 86400 },
      },
    });
    pollSnapshot();
  });
  ipcMain.on('sim:clear', () => {
    const d = bridge.stateDir();
    for (const f of ['usage.json', 'limit.json', path.join('sessions', 'simulator.json')]) {
      try { fs.unlinkSync(path.join(d, f)); } catch (_) {}
    }
    pollSnapshot();
  });
}

function makeTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    tray = new Tray(icon);
    tray.setToolTip('撫子');
    rebuildTray();
    tray.on('click', summonPet);
  } catch (e) {
    console.error('tray', e);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', summonPet);
  app.whenReady().then(() => {
    loadSettings();
    bridge.pruneSessions();
    setupIPC();
    createPet();
    makeTray();
    setInterval(pollSnapshot, 600);
    setInterval(() => { if (settings.alwaysOnTop && pet && !pet.isDestroyed() && pet.isVisible()) pet.moveTop(); }, 3000);
    if (process.argv.includes('--panel')) openPanel();
    registerHotkey();
    // 偵測系統睡眠或螢幕休眠：計時器突然隔了很久才跑，就當作剛喚醒
    let lastBeat = Date.now();
    setInterval(() => {
      const n = Date.now();
      if (n - lastBeat > 8000) setTimeout(recoverPet, 600);
      lastBeat = n;
    }, 2000);
    // 螢幕休眠／鎖定／換顯示器後，透明視窗的滑鼠穿透狀態可能跟畫面端不同步（能摸頭但拎不起來）
    // → 重設成「穿透＋轉發移動」，並通知畫面端清掉殘留的按住狀態
    for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => setTimeout(recoverPet, 800));
    screen.on('display-metrics-changed', () => setTimeout(recoverPet, 800));
    screen.on('display-added', () => setTimeout(recoverPet, 800));
    screen.on('display-removed', () => setTimeout(recoverPet, 800));
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
