'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  onState: (cb) => ipcRenderer.on('pet-state', (_e, s) => cb(s)),
  onBubbleVisibility: (cb) => ipcRenderer.on('bubble-visibility', (_e, v) => cb(v)),
  onSkinChange: (cb) => ipcRenderer.on('skin-change', (_e, s) => cb(s)),
  onScaleChange: (cb) => ipcRenderer.on('pet-scale', (_e, s) => cb(s)),
  onSoundToggle: (cb) => ipcRenderer.on('sound-toggle', (_e, v) => cb(v)),
  onTestSound: (cb) => ipcRenderer.on('test-sound', () => cb()),
  onCustomSprites: (cb) => ipcRenderer.on('custom-sprites', (_e, data) => cb(data)),
  openGui: () => ipcRenderer.send('pet-click'),
  playSound: (mode) => ipcRenderer.send('play-sound', mode),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', { dx, dy }),
  contextMenu: () => ipcRenderer.send('pet-context-menu'),
})
