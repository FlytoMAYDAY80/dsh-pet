'use strict'

// Regression test for renderer hit regions and BrowserWindow click-through.
// It uses the real preload and renderer, but an isolated temporary Electron window.

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const os = require('node:os')

app.setPath('userData', path.join(os.tmpdir(), `dsh-pet-hittest-${process.pid}`))

const rootHtml = path.join(__dirname, '..', 'app', 'index.html')
const preload = path.join(__dirname, '..', 'preload.js')
const rows = []
let win
let reported = null

for (const channel of ['pet-click', 'play-sound', 'drag-move', 'pet-context-menu']) {
  ipcMain.on(channel, () => {})
}

ipcMain.on('set-interactive', (_event, { interactive }) => {
  reported = interactive === true
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(!reported, { forward: true })
  }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function geometry() {
  return win.webContents.executeJavaScript(`(() => {
    const canvas = document.getElementById('pixel-canvas')
    const context = canvas.getContext('2d')
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    const rect = canvas.getBoundingClientRect()
    let visible = null
    let transparent = null

    for (let y = 0; y < canvas.height && !visible; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] > 8) {
          visible = {
            x: rect.left + (x + 0.5) * rect.width / canvas.width,
            y: rect.top + (y + 0.5) * rect.height / canvas.height,
          }
          break
        }
      }
    }

    for (let y = 0; y < canvas.height && !transparent; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] !== 0) continue
        const point = {
          x: rect.left + (x + 0.5) * rect.width / canvas.width,
          y: rect.top + (y + 0.5) * rect.height / canvas.height,
        }
        if (!pointOverBubble(point.x, point.y)) {
          transparent = point
          break
        }
      }
    }

    const bubble = document.getElementById('bubble').getBoundingClientRect()
    return {
      visible,
      transparent,
      bubble: {
        x: (bubble.left + bubble.right) / 2,
        y: (bubble.top + bubble.bottom) / 2,
        left: bubble.left,
        bottom: bubble.bottom,
      },
    }
  })()`)
}

async function probe(name, point, expected) {
  reported = null
  await win.webContents.executeJavaScript(`(() => {
    lastPointer = { x: ${point.x}, y: ${point.y} }
    lastInteractive = null
    updateHit()
  })()`)
  await sleep(40)
  const predicate = await win.webContents.executeJavaScript(
    `pointOverBubble(${point.x}, ${point.y}) || pointOverWhale(${point.x}, ${point.y})`,
  )
  const pass = predicate === expected && reported === expected
  rows.push({ name, expected, predicate, reported, pass })
  console.log(`[hittest] ${name}: expected=${expected} predicate=${predicate} ipc=${reported} ${pass ? 'PASS' : 'FAIL'}`)
}

async function run() {
  win = new BrowserWindow({
    width: 280,
    height: 340,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  })
  await win.loadFile(rootHtml)

  const view = win.webContents
  view.send('skin-change', 'pixel')
  view.send('pet-scale', 0.67)
  view.send('pet-state', {
    mode: 'attention',
    running: [],
    attention: [],
    done: [],
    queued: 0,
    bubble: { title: '需要你确认', body: '热区回归测试' },
  })
  win.showInactive()
  await sleep(500)

  let current = await geometry()
  await probe('window corner', { x: 2, y: 2 }, false)
  await probe('transparent canvas pixel', current.transparent, false)
  await probe('visible whale alpha pixel', current.visible, true)
  await probe('visible bubble rectangle', current.bubble, true)
  await probe('visible bubble tail triangle', { x: current.bubble.x, y: current.bubble.bottom + 4 }, true)
  await probe('blank beside bubble tail', { x: current.bubble.left + 2, y: current.bubble.bottom + 4 }, false)

  await win.webContents.executeJavaScript(`(() => {
    lastPointer = { x: ${current.bubble.x}, y: ${current.bubble.y} }
    lastInteractive = true
  })()`)
  reported = null
  view.send('bubble-visibility', false)
  await sleep(120)
  const hiddenPass = reported === false
  rows.push({ name: 'hidden bubble restores click-through', expected: false, reported, pass: hiddenPass })
  console.log(`[hittest] hidden bubble restores click-through: ipc=${reported} ${hiddenPass ? 'PASS' : 'FAIL'}`)

  view.send('bubble-visibility', true)
  view.send('pet-state', {
    mode: 'working',
    running: [{ sessionId: 'test', title: 'frame change' }],
    attention: [],
    done: [],
    queued: 0,
    bubble: { title: '正在干活', body: '换帧测试' },
  })
  await sleep(350)
  // Freeze the already-rendered working frame so geometry sampling and the
  // following assertion observe the same frame instead of racing the RAF loop.
  await win.webContents.executeJavaScript(`(() => {
    if (rafId) cancelAnimationFrame(rafId)
    rafId = null
  })()`)
  current = await geometry()
  await probe('whale after state/frame change', current.visible, true)
  await probe('blank after state/frame change', { x: 2, y: 2 }, false)

  const passed = rows.filter((row) => row.pass).length
  console.log(`[hittest] SUMMARY ${passed}/${rows.length} passed`)
  win.destroy()
  app.exit(passed === rows.length ? 0 : 1)
}

app.whenReady().then(run).catch((error) => {
  console.error('[hittest] ERROR', error)
  app.exit(2)
})
