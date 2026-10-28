'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('petHost', {
  init: () => ipcRenderer.invoke('pet:init'),
  geom: () => ipcRenderer.invoke('pet:geom'),
  windows: () => ipcRenderer.invoke('pet:windows'),
  setIgnore: (v) => ipcRenderer.send('pet:set-ignore', v),
  move: (x, y) => ipcRenderer.send('pet:move', x, y),
  dragStart: (gx, gy) => ipcRenderer.send('pet:drag-start', gx, gy),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  menu: () => ipcRenderer.send('pet:menu'),
  resizeStep: (dir) => ipcRenderer.send('pet:resize-step', dir),
  onSnapshot: on('pet:snapshot'),
  onSettings: on('pet:settings'),
  onForce: on('pet:force'),
  onAction: on('pet:action'),
  onDragMove: on('pet:drag-move'),
  onRecover: on('pet:recover'),
  onSummon: on('pet:summon'),
  onVoice: on('pet:voice'),
});

contextBridge.exposeInMainWorld('panelHost', {
  init: () => ipcRenderer.invoke('panel:init'),
  set: (k, v) => ipcRenderer.send('panel:set', k, v),
  force: (k) => ipcRenderer.send('panel:force', k),
  action: (k) => ipcRenderer.send('panel:action', k),
  simHook: (input) => ipcRenderer.send('sim:hook', input),
  simUsage: (five, week) => ipcRenderer.send('sim:usage', five, week),
  simClear: () => ipcRenderer.send('sim:clear'),
  voiceList: () => ipcRenderer.invoke('voice:list'),
  voiceRead: (key, i) => ipcRenderer.invoke('voice:read', key, i),
  voiceGen: (o) => ipcRenderer.invoke('voice:gen', o),
  voiceAdopt: (o) => ipcRenderer.invoke('voice:adopt', o),
  onSettings: on('panel:settings'),
  onSnapshot: on('panel:snapshot'),
  onForce: on('panel:force'),
});
