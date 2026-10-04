'use strict';
// Мост между страницей и программой. Странице доступны только эти функции — ни файлов, ни Node.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eyeGymDesktop', {
  platform: 'desktop',
  os: process.platform,
  hint: 'Таймер считает только время за компьютером: если вы отошли больше чем на 5 минут, отсчёт начнётся заново. ' +
    'Гимнастика тоже считается перерывом. Крестик окна сворачивает приложение в трей у часов, выйти можно там же.',
  getState: () => ipcRenderer.invoke('eyegym:get-state'),
  setSettings: patch => ipcRenderer.invoke('eyegym:set-settings', patch),
  breakDone: () => ipcRenderer.invoke('eyegym:break-done'),
  setBusy: busy => ipcRenderer.send('eyegym:busy', !!busy),
  onBreak: cb => { ipcRenderer.on('eyegym:break', () => cb()); },
  onState: cb => { ipcRenderer.on('eyegym:state', (_e, s) => cb(s)); },
});
