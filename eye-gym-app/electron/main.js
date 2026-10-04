'use strict';
// Главный процесс приложения для Windows: окно с гимнастикой, значок в трее и напоминания 20-20-20.
const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain, protocol, session,
  powerMonitor, nativeImage, nativeTheme, shell, screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { promisify } = require('node:util');
const { BreakScheduler, AWAY_SEC } = require('./scheduler');

const APP_ID = 'com.eyegym.app';                       // совпадает с appId в package.json — без этого Windows не покажет уведомления
const WWW = path.join(__dirname, '..', 'www');
const ASSETS = path.join(__dirname, '..', 'assets');
const ICON = path.join(ASSETS, 'icon.png');
const PAGE_URL = 'app://eye-gym/index.html';
const PORTABLE_EXE = process.env.PORTABLE_EXECUTABLE_FILE || '';   // задаёт портативная сборка electron-builder
const START_HIDDEN = process.argv.includes('--hidden');            // так нас запускает автозагрузка Windows
const TICK_MS = 15000;
const INTERVALS = [20, 30, 45, 60];
const ALLOWED_PERMISSIONS = new Set(['media', 'fullscreen', 'notifications', 'screen-wake-lock', 'wake-lock']);
const readFile = promisify(fs.readFile);

// Портативная версия хранит настройки и рейтинг отдельно от установленной — иначе они мешали бы друг другу
// (общие настройки, общий «уже запущено»). Вызывать до любого обращения к userData.
if (PORTABLE_EXE) app.setPath('userData', path.join(app.getPath('appData'), 'EyeGym Portable'));

// Свой протокол app:// вместо file://: страница получает постоянный адрес (рейтинг в localStorage не теряется),
// считается защищённой (нужно для камеры) и может загружать модули и wasm через fetch.
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

let win = null;
let tray = null;
let sched = null;
let settings = null;
let quitting = false;
let lastNotification = null;   // держим ссылку, иначе уведомление может исчезнуть раньше, чем по нему нажмут
let popupTimer = null;

// ---------- Настройки ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function defaults(){
  return {
    enabled: true, interval: 20,
    popup: !!PORTABLE_EXE,                       // у портативной версии нет ярлыка в «Пуске», и Windows может не показать её уведомления
    autostart: app.isPackaged && !PORTABLE_EXE,  // напоминания работают, только пока приложение запущено
    trayHintShown: false,
    stats: { day: today(), n: 0 },
  };
}
function loadSettings(){
  let firstRun = false, stored = {};
  try{ stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (e){ firstRun = true; }
  settings = { ...defaults(), ...stored };
  if (!INTERVALS.includes(settings.interval)) settings.interval = 20;
  if (!settings.stats || typeof settings.stats.n !== 'number') settings.stats = { day: today(), n: 0 };
  return firstRun;
}
function saveSettings(){
  try{
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(settings, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch (e){ console.error('Не удалось сохранить настройки', e); }
}
function rollDay(){ if (settings.stats.day !== today()) settings.stats = { day: today(), n: 0 }; }

// ---------- Автозапуск ----------
const exePath = () => PORTABLE_EXE || process.execPath;
function applyAutostart(on){
  if (!app.isPackaged) return;   // при запуске из исходников в автозагрузку попал бы electron.exe
  app.setLoginItemSettings({ openAtLogin: !!on, path: exePath(), args: ['--hidden'] });
}
function readAutostart(){
  if (!app.isPackaged) return false;
  try{ return app.getLoginItemSettings({ path: exePath(), args: ['--hidden'] }).openAtLogin; } catch (e){ return !!settings.autostart; }
}

// ---------- Состояние для страницы и трея ----------
function state(){
  rollDay();
  return {
    settings: { enabled: settings.enabled, interval: settings.interval, popup: settings.popup, autostart: settings.autostart },
    nextAt: settings.enabled && !sched.isPaused() ? sched.nextAt : null,
    pausedUntil: sched.isPaused() ? sched.pausedUntil : null,
    breaksToday: settings.stats.n,
    canAutostart: app.isPackaged, canPopup: true, approx: false,
  };
}
function sendState(){ if (win && !win.isDestroyed()) win.webContents.send('eyegym:state', state()); }
function changed(){ updateTray(true); sendState(); }

function setSettings(patch){
  if (!patch || typeof patch !== 'object') return state();
  if ('enabled' in patch){ settings.enabled = !!patch.enabled; sched.setEnabled(settings.enabled); }
  if ('interval' in patch){
    const m = Number(patch.interval);
    settings.interval = INTERVALS.includes(m) ? m : 20;
    sched.setInterval(settings.interval);
  }
  if ('popup' in patch) settings.popup = !!patch.popup;
  if ('autostart' in patch){ settings.autostart = !!patch.autostart; applyAutostart(settings.autostart); }
  saveSettings();
  changed();
  return state();
}
function breakDone(){
  rollDay();
  settings.stats.n += 1;
  saveSettings();
  sched.breakDone();
  stopPopup();
  changed();
  return state();
}

// ---------- Окно ----------
function createWindow(show){
  const { height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 640, height: Math.max(560, Math.min(960, height - 40)), minWidth: 380, minHeight: 520,
    show: false, title: 'Гимнастика для глаз', icon: ICON, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121826' : '#EEF1F6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',   // сигнал в конце перерыва, даже если его запустило уведомление
    },
  });
  win.loadURL(PAGE_URL);
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();          // крестик сворачивает в трей — иначе напоминания перестанут приходить
    win.hide();
    trayHint();
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', sendState);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();   // для диагностики
  });
}
function showWindow(){
  if (!win || win.isDestroyed()){ createWindow(true); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
// Открыть окно и начать перерыв «смотреть вдаль».
function requestBreak(){
  showWindow();
  const send = () => { if (win && !win.isDestroyed()) win.webContents.send('eyegym:break'); };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(send, 400));
  else setTimeout(send, 250);   // даём странице проснуться после показа окна
}
function popupBreak(){
  requestBreak();
  if (!win) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  if (!win.isFocused()) win.flashFrame(true);
  clearTimeout(popupTimer);
  popupTimer = setTimeout(stopPopup, 30000);
}
function stopPopup(){
  clearTimeout(popupTimer); popupTimer = null;
  if (win && !win.isDestroyed()){ win.setAlwaysOnTop(false); win.flashFrame(false); }
}

// ---------- Напоминание ----------
function remind(){
  if (settings.popup || !Notification.isSupported()){ popupBreak(); return; }
  const n = new Notification({
    title: 'Пора дать глазам отдохнуть',
    body: 'Правило 20-20-20: 20 секунд смотрите вдаль, на 6 метров и дальше. Нажмите, чтобы начать перерыв.',
    icon: ICON,
  });
  n.on('click', requestBreak);
  n.on('failed', (_e, err) => { console.warn('Уведомление не показалось:', err); popupBreak(); });
  n.show();
  lastNotification = n;
}
function trayHint(){
  if (settings.trayHintShown || !Notification.isSupported()) return;
  settings.trayHintShown = true; saveSettings();
  lastNotification = new Notification({
    title: 'Гимнастика для глаз работает в фоне',
    body: 'Напоминания о перерывах будут приходить. Открыть окно или выйти — через значок у часов (он может прятаться под стрелкой ^).',
    icon: ICON, silent: true,
  });
  lastNotification.on('click', showWindow);
  lastNotification.show();
}
function tick(){
  let idleSec = 0, locked = false;
  try{ idleSec = powerMonitor.getSystemIdleTime(); } catch (e){}
  try{ locked = powerMonitor.getSystemIdleState(AWAY_SEC) === 'locked'; } catch (e){}
  if (sched.tick({ idleSec, locked })) remind();
  updateTray(false);
  sendState();
}

// ---------- Трей ----------
const fmtTime = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function tooltip(){
  const s = state();
  if (!s.settings.enabled) return 'Гимнастика для глаз\nНапоминания выключены';
  if (s.pausedUntil) return `Гимнастика для глаз\nПауза до ${fmtTime(s.pausedUntil)}`;
  if (!s.nextAt) return 'Гимнастика для глаз';
  const min = Math.max(0, Math.round((s.nextAt - Date.now()) / 60000));
  return `Гимнастика для глаз\nПерерыв ${min ? `через ${min} мин (в ${fmtTime(s.nextAt)})` : 'скоро'}`;
}
function trayMenu(){
  const paused = sched.isPaused();
  return Menu.buildFromTemplate([
    { label: 'Открыть гимнастику', click: showWindow },
    { label: 'Перерыв сейчас (20 секунд)', click: requestBreak },
    { type: 'separator' },
    { label: 'Напоминать о перерывах', type: 'checkbox', checked: settings.enabled, click: mi => setSettings({ enabled: mi.checked }) },
    { label: 'Напоминать каждые', enabled: settings.enabled, submenu: INTERVALS.map(m => ({
      label: `${m} минут`, type: 'radio', checked: settings.interval === m, click: () => setSettings({ interval: m }),
    })) },
    paused
      ? { label: `Снять паузу (сейчас до ${fmtTime(sched.pausedUntil)})`, click: () => { sched.resume(); changed(); } }
      : { label: 'Пауза на 1 час', enabled: settings.enabled, click: () => { sched.pause(3600000); changed(); } },
    { type: 'separator' },
    { label: 'Запускать вместе с Windows', type: 'checkbox', visible: app.isPackaged, checked: !!settings.autostart,
      click: mi => setSettings({ autostart: mi.checked }) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]);
}
function createTray(){
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));   // tray@2x.png подхватится на экранах с масштабом
  tray = new Tray(img);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray(true);
}
function updateTray(rebuildMenu){
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(tooltip());
  if (rebuildMenu) tray.setContextMenu(trayMenu());
}

// ---------- Файлы страницы по адресу app://eye-gym/… ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
async function serveApp(request){
  let rel;
  try{ rel = decodeURIComponent(new URL(request.url).pathname); } catch (e){ return new Response('Bad request', { status: 400 }); }
  if (!rel || rel === '/') rel = '/index.html';
  const file = path.resolve(WWW, '.' + rel);
  if (file !== WWW && !file.startsWith(WWW + path.sep)) return new Response('Forbidden', { status: 403 });
  try{
    const data = await readFile(file);
    return new Response(data, { status: 200, headers: {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache',
    } });
  } catch (e){
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

// ---------- IPC: только от нашей страницы ----------
const fromApp = e => { try{ return (e.senderFrame ? e.senderFrame.url : '').startsWith('app://'); } catch (err){ return false; } };
function registerIpc(){
  ipcMain.handle('eyegym:get-state', e => (fromApp(e) ? state() : null));
  ipcMain.handle('eyegym:set-settings', (e, patch) => {
    if (!fromApp(e) || !patch || typeof patch !== 'object') return state();
    const clean = {};
    for (const k of ['enabled', 'interval', 'popup', 'autostart']) if (k in patch) clean[k] = patch[k];
    return setSettings(clean);
  });
  ipcMain.handle('eyegym:break-done', e => (fromApp(e) ? breakDone() : state()));
  ipcMain.on('eyegym:busy', (e, busy) => { if (fromApp(e)) sched.setBusy(!!busy); });
}

// ---------- Запуск ----------
if (!app.requestSingleInstanceLock()){
  app.quit();   // приложение уже запущено — второй экземпляр просто показывает первое окно
} else {
  app.setAppUserModelId(APP_ID);
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* продолжаем работать в трее */ });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const firstRun = loadSettings();
    if (firstRun) applyAutostart(settings.autostart);
    else settings.autostart = readAutostart();
    saveSettings();

    protocol.handle('app', serveApp);
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      callback(ALLOWED_PERMISSIONS.has(permission) && String((details && details.requestingUrl) || '').startsWith('app://'));
    });
    ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && String(origin || '').startsWith('app://'));

    sched = new BreakScheduler({ enabled: settings.enabled, intervalMin: settings.interval });
    registerIpc();
    createTray();
    createWindow(!START_HIDDEN);
    setInterval(tick, TICK_MS);

    // Сон и блокировка экрана — человек отошёл, глаза отдыхают; после возвращения отсчёт заново.
    powerMonitor.on('suspend', () => sched.markAway());
    powerMonitor.on('lock-screen', () => sched.markAway());
    powerMonitor.on('resume', () => { sched.markBack(); changed(); });
    powerMonitor.on('unlock-screen', () => { sched.markBack(); changed(); });
  });
}
