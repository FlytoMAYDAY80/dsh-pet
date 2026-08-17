'use strict'

/**
 * DSH 桌宠主进程
 * - 透明无边框置顶悬浮窗 + 托盘
 * - DSH 状态引擎：轮询 session.list + WebSocket /api/events.mux（实时推送审批/提问/队列）
 * - 状态机：offline > attention > working > done > idle
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('node:child_process')

const DSH_URL = (process.env.DSH_PET_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '')
const POLL_MS = 2000
const DONE_WINDOW_MS = 120_000 // 会话完成后，"完成待查看"提示的保留时长
const SMOKE = process.argv.includes('--smoke')
const SMOKE_MS = 14_000
const SHOT_MODE = process.argv.includes('--shot') // 截图自检模式：把 5 种状态各截一张 PNG

// ---------------------------------------------------------------------------
// 状态存储
// ---------------------------------------------------------------------------
const pet = {
  mode: 'starting',            // starting | offline | idle | working | attention | done
  connected: false,
  lastError: null,
  sessions: new Map(),         // sessionId -> { title, running, todos }
  pendingApprovals: new Map(), // approvalId -> { sessionId, toolName, reason }
  pendingQuestions: new Map(), // questionRpcId -> { sessionId, text }
  done: new Map(),             // sessionId -> { title, at }
  queuedCount: 0,
}

let mainWindow = null
let tray = null
let bubbleVisible = true
let skin = 'pixel'
let petScale = 0.67
let openMode = 'browser' // 'window'（桌宠窗口直达会话）| 'browser'（系统浏览器）——菜单可切换
let soundOn = true // 状态提示音开关
const PET_SCALE_DEFAULT = 0.67
const PET_SCALE_MIN = 0.5
const PET_SCALE_MAX = 1.1
const PET_SCALE_STEP = 0.1

// ---------------------------------------------------------------------------
// DSH JSON-RPC 客户端
// ---------------------------------------------------------------------------
async function rpc(method, payload = {}) {
  const res = await fetch(`${DSH_URL}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `pet-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      method,
      payload,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (!body || !body.result || !body.result.ok) {
    throw new Error(body?.result?.error?.message || 'rpc error')
  }
  return body.result.value
}

function sessionTitle(id) {
  return pet.sessions.get(id)?.title || '某会话'
}

// ---------------------------------------------------------------------------
// 轮询：session.list
// ---------------------------------------------------------------------------
async function pollSessions() {
  let items
  try {
    items = (await rpc('session.list')).items || []
    pet.connected = true
    pet.lastError = null
  } catch (err) {
    pet.connected = false
    pet.lastError = String(err?.message || err)
    if (SMOKE) console.log(`[pet-smoke] poll error: ${pet.lastError}`)
    emit()
    return
  }

  const now = Date.now()
  const seen = new Set()
  for (const s of items) {
    seen.add(s.sessionId)
    const prev = pet.sessions.get(s.sessionId)
    const title = s.projections?.values?.title || '未命名会话'
    const todos = s.projections?.values?.todos || null
    const cur = { title, running: !!s.running, todos }
    pet.sessions.set(s.sessionId, cur)
    // 检测 running true -> false：会话刚结束，标记"完成待查看"
    if (prev && prev.running && !cur.running) {
      pet.done.set(s.sessionId, { title: cur.title, at: now })
    }
  }
  for (const id of [...pet.sessions.keys()]) {
    if (!seen.has(id)) pet.sessions.delete(id)
  }
  for (const [id, d] of [...pet.done]) {
    if (now - d.at > DONE_WINDOW_MS) pet.done.delete(id)
  }

  if (SMOKE) {
    const running = [...pet.sessions.values()].filter((s) => s.running).length
    console.log(`[pet-smoke] poll ok: ${items.length} sessions, running=${running}`)
  }
  emit()
}

// ---------------------------------------------------------------------------
// WebSocket：/api/events.mux（审批/提问/队列推送）+ /api/events.host（running 翻转即时推送）
// 说明：DSH 0.1.0-rc.6 起事件通道只接受 WebSocket 升级（普通 GET 返回 426
// "upgrade required"），SSE 客户端会连不上。统一连接器：断线自动重连
// ---------------------------------------------------------------------------
const wsState = {} // path -> { timer, ws }

function connectWS(path, onFrame, onOpen) {
  const st = wsState[path] ?? (wsState[path] = { timer: null, ws: null })
  if (st.timer) { clearTimeout(st.timer); st.timer = null }
  st.ws?.close()
  const url = `${DSH_URL.replace(/^http/, 'ws')}${path}`
  let ws
  try {
    ws = new WebSocket(url)
  } catch (err) {
    st.timer = setTimeout(() => connectWS(path, onFrame, onOpen), 3000)
    return
  }
  st.ws = ws
  ws.onopen = () => {
    if (SMOKE) console.log(`[pet-smoke] ws open ${path}`)
    onOpen?.()
  }
  ws.onmessage = (ev) => {
    let frame
    try { frame = JSON.parse(ev.data) } catch { return }
    // rpcId 是 ServerRequest 信封字段：question/requested 的唯一标识
    // （与服务端 question/resolved 的 questionRpcId 对应），必须透传给处理层
    onFrame(frame.payload || frame, frame.rpcId)
  }
  ws.onerror = () => { /* 统一由 onclose 处理重连 */ }
  ws.onclose = () => {
    if (st.ws !== ws) return // 已被新连接取代（主动重连/关闭）
    st.timer = setTimeout(() => connectWS(path, onFrame, onOpen), 3000)
  }
}

// mux：重连时清空待决审批/提问，服务端会重放，实现天然同步
function connectMux() {
  pet.pendingApprovals.clear()
  pet.pendingQuestions.clear()
  connectWS('/api/events.mux', handleFrame)
}

// host：running 翻转即时推送（会话开始/结束干活），解决轮询延迟
function connectHost() {
  connectWS('/api/events.host', handleHostFrame, () => {
    // 重连后补一次轮询基线，防止漏掉连接期间的翻转
    pollSessions()
  })
}

function handleHostFrame(p) {
  if (p?.type === 'host/session-status') {
    const cur = pet.sessions.get(p.sessionId)
    if (cur) {
      const wasRunning = cur.running
      cur.running = p.running
      if (wasRunning && !p.running) {
        pet.done.set(p.sessionId, { title: cur.title, at: Date.now() })
      }
    } else {
      pollSessions() // 未知会话（如新建）：立即刷新拿标题等信息
    }
    // 会话结束：清除该会话残留的待决审批/提问（resolved 事件可能未送达，避免跨会话残留）
    if (p.running === false) {
      for (const [id, a] of pet.pendingApprovals) if (a.sessionId === p.sessionId) pet.pendingApprovals.delete(id)
      for (const [id, q] of pet.pendingQuestions) if (q.sessionId === p.sessionId) pet.pendingQuestions.delete(id)
    }
    if (SMOKE) console.log(`[pet-smoke] host/session-status ${p.sessionId} running=${p.running}`)
    emit()
  }
}

function handleFrame(p, rpcId) {
  switch (p?.type) {
    case 'approval/requested':
      pet.pendingApprovals.set(p.approvalId, {
        sessionId: p.sessionId, toolName: p.toolName, reason: p.reason, requestedAt: Date.now(),
      })
      if (SMOKE) console.log(`[pet-smoke] approval/requested: ${p.toolName}`)
      emit()
      break
    case 'approval/resolved':
      pet.pendingApprovals.delete(p.approvalId)
      emit()
      break
    case 'question/requested':
      // 注意：requested 帧的载荷里没有 questionRpcId，唯一标识在 ServerRequest
      // 信封的 rpcId 上（与 question/resolved 帧的 questionRpcId 对应），
      // 用 rpcId 做 key 才能多提问并存、且能被 resolved 精确清除
      pet.pendingQuestions.set(rpcId || p.questionRpcId, {
        sessionId: p.sessionId,
        text: p.questions?.[0]?.question || '',
        requestedAt: Date.now(),
      })
      if (SMOKE) console.log(`[pet-smoke] question/requested(${rpcId}): ${pet.pendingQuestions.get(rpcId || p.questionRpcId)?.text}`)
      emit()
      break
    case 'question/resolved':
      pet.pendingQuestions.delete(p.questionRpcId)
      emit()
      break
    case 'session/queue':
      pet.queuedCount = (p.items || []).length
      emit()
      break
    case 'session/event':
      // 一轮回答完成（turn/end completed）：语音播报完成提示
      // （rc.6 帧格式：event.data.reason.kind，reason 在 data 内而非事件顶层）
      if (p.event?.type === 'turn/end' && p.event.data?.reason?.kind === 'completed') {
        playSoundFile('done')
      }
      break
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// 状态推导 + 气泡文案
// ---------------------------------------------------------------------------
function buildSnapshot() {
  const running = [...pet.sessions.values()].filter((s) => s.running)
  const attention = []
  for (const a of pet.pendingApprovals.values()) {
    attention.push({ kind: 'approval', sessionId: a.sessionId, text: `「${sessionTitle(a.sessionId)}」请求使用 ${a.toolName}` })
  }
  for (const q of pet.pendingQuestions.values()) {
    attention.push({ kind: 'question', sessionId: q.sessionId, text: `「${sessionTitle(q.sessionId)}」：${q.text}` })
  }
  const doneList = [...pet.done.entries()].map(([id, d]) => ({ sessionId: id, title: d.title }))

  let mode = pet.mode
  let title = ''
  let body = ''

  if (!pet.connected) {
    mode = 'offline'
    title = '连不上 DSH 😢'
    body = pet.lastError ? `GUI 无响应（${pet.lastError}）` : 'GUI 未启动，我会自动重试'
  } else if (attention.length > 0) {
    mode = 'attention'
    title = `需要你确认 · ${attention.length} 项`
    body = attention.map((a, i) => `${i + 1}. ${a.text}`).join('\n')
  } else if (running.length > 0) {
    mode = 'working'
    // 提醒粒度为会话：每个运行中会话一行，只显示会话标题（不显示任务级 todo）
    const lines = [...pet.sessions.entries()]
      .filter(([, s]) => s.running)
      .map(([, s], i) => `${i + 1}. 「${s.title}」`)
    title = `正在干活…（${running.length} 个会话）`
    body = lines.join('\n')
    if (doneList.length > 0) body += `\n—\n另有 ${doneList.length} 个已完成待查看`
  } else if (doneList.length > 0) {
    mode = 'done'
    title = '任务完成啦 🎉'
    body = doneList.map((d, i) => `${i + 1}. 「${d.title}」`).join('\n')
  } else {
    mode = 'idle'
    title = '休息中 💤'
    body = '没有运行中的任务'
  }
  pet.mode = mode

  return { mode, bubble: { title, body }, running, attention, done: doneList, queued: pet.queuedCount }
}

function emit() {
  // 待决项超时（30 分钟）自动过期，防止残留
  const now = Date.now()
  const PENDING_TTL = 30 * 60 * 1000
  for (const [id, a] of pet.pendingApprovals) if (now - a.requestedAt > PENDING_TTL) pet.pendingApprovals.delete(id)
  for (const [id, q] of pet.pendingQuestions) if (now - q.requestedAt > PENDING_TTL) pet.pendingQuestions.delete(id)

  const snapshot = buildSnapshot()
  if (snapshot.mode !== pet.lastEmittedMode) {
    console.log(`[pet] state=${snapshot.mode} running=${snapshot.running.length} approvals=${pet.pendingApprovals.size} questions=${pet.pendingQuestions.size} done=${snapshot.done.length}`)
    pet.lastEmittedMode = snapshot.mode
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet-state', snapshot)
  }
  if (SMOKE) {
    console.log(`[pet-smoke] state=${snapshot.mode} running=${snapshot.running.length} approvals=${pet.pendingApprovals.size} questions=${pet.pendingQuestions.size} done=${snapshot.done.length}`)
  }
}

// ---------------------------------------------------------------------------
// 窗口 / 托盘
// ---------------------------------------------------------------------------
const TRAY_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path fill="#000000" d="M5 13 C 5 7 11 4 17 4 C 24 4 28 8 28 14 C 28 21 23 25 16 25 C 12 25 8 23 7 20 C 6 18 5 16 5 13 Z"/>
  <path fill="#000000" d="M23 15 C 26 11 29 10 30 10 C 28 15 29 19 30 24 C 27 23 25 20 23 15 Z"/>
  <circle fill="#000000" cx="10" cy="13" r="2.2"/>
</svg>`

function trayIcon() {
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(TRAY_SVG).toString('base64')}`)
  return img.resize({ width: 18, height: 18 })
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '打开 DSH GUI', click: () => openGui() },
    {
      label: bubbleVisible ? '隐藏气泡' : '显示气泡',
      click: () => {
        bubbleVisible = !bubbleVisible
        mainWindow?.webContents.send('bubble-visibility', bubbleVisible)
      },
    },
    {
      label: '状态提示音',
      type: 'checkbox',
      checked: soundOn,
      click: (item) => {
        soundOn = item.checked
        mainWindow?.webContents.send('sound-toggle', soundOn)
        tray?.setContextMenu(buildMenu())
      },
    },
    {
      label: '测试提示音',
      click: () => mainWindow?.webContents.send('test-sound'),
    },
    {
      label: `鲸鱼大小 ${Math.round(petScale * 100)}%`,
      submenu: [
        { label: '放大', click: () => setPetScale(petScale + PET_SCALE_STEP) },
        { label: '缩小', click: () => setPetScale(petScale - PET_SCALE_STEP) },
        { label: '重置（默认 67%）', click: () => setPetScale(PET_SCALE_DEFAULT) },
      ],
    },
    {
      label: '打开方式',
      submenu: [
        {
          label: '系统浏览器', type: 'radio', checked: openMode === 'browser',
          click: () => setOpenMode('browser'),
        },
        {
          label: '桌宠窗口（自动直达第一个会话）', type: 'radio', checked: openMode === 'window',
          click: () => setOpenMode('window'),
        },
      ],
    },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ])
}

function setOpenMode(m) {
  if (openMode === m) return
  openMode = m
  tray?.setContextMenu(buildMenu())
}

// 读取自定义素材包（custom/sprites.json：palette + sprites，覆盖内置像素素材）
function loadCustomSprites() {
  try {
    const f = path.join(__dirname, 'custom', 'sprites.json')
    if (!fs.existsSync(f)) return null
    const data = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!data || typeof data !== 'object') return null
    console.log('[pet] 已加载自定义素材包 custom/sprites.json')
    return data
  } catch (e) {
    console.log(`[pet] 自定义素材包读取失败: ${e?.message ?? e}`)
    return null
  }
}

function setSkin(next) {
  if (skin === next) return
  skin = next
  mainWindow?.webContents.send('skin-change', skin)
  tray?.setContextMenu(buildMenu())
}

function setPetScale(next) {
  const clamped = Math.round(Math.max(PET_SCALE_MIN, Math.min(PET_SCALE_MAX, next)) * 100) / 100
  if (clamped === petScale) return
  petScale = clamped
  mainWindow?.webContents.send('pet-scale', petScale)
  tray?.setContextMenu(buildMenu())
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 280,
    height: 340,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: SHOT_MODE ? '#F3F6FF' : '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.setAlwaysOnTop(true, 'floating')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'))
  // 页面加载后同步皮肤、鲸鱼大小与自定义素材包（含启动默认值）
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('skin-change', skin)
    mainWindow.webContents.send('pet-scale', petScale)
    const custom = loadCustomSprites()
    if (custom) mainWindow.webContents.send('custom-sprites', custom)
  })
  mainWindow.once('ready-to-show', () => {
    const wa = screen.getPrimaryDisplay().workArea
    const [w, h] = mainWindow.getSize()
    mainWindow.setPosition(wa.x + wa.width - w - 18, wa.y + wa.height - h - 24)
    mainWindow.show()
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.on('pet-click', () => openGui())

// ---------------------------------------------------------------------------
// 状态提示音：用系统播放器 afplay 播放（绕过 Chromium 音频输出，macOS 稳定）
// custom/ 优先，回退 app/sounds/
// ---------------------------------------------------------------------------
let afplayProc = null

function playSoundFile(mode) {
  if (!soundOn) return
  const base = mode === 'attention' ? 'attention' : mode === 'done' ? 'done' : null
  if (!base) return
  const candidates = [
    path.join(__dirname, 'custom', `${base}.m4a`),
    path.join(__dirname, 'custom', `${base}.mp4`),
    path.join(__dirname, 'app', 'sounds', `${base}.m4a`),
    path.join(__dirname, 'app', 'sounds', `${base}.mp4`),
  ]
  const f = candidates.find((p) => fs.existsSync(p))
  if (!f) return
  if (afplayProc && !afplayProc.killed) afplayProc.kill() // 防止重叠播放
  console.log(`[pet] 播放提示音: ${f}`)
  afplayProc = spawn('afplay', [asarPlayable(f)])
  afplayProc.on('error', () => { /* 播放器不可用时静默 */ })
}

// 打包模式（app.asar）下音效归档在 asar 内，外部 afplay 无法读取该路径
// （实测报 AudioFileOpen failed）。用 Electron 的 fs 解压到临时目录再播。
function asarPlayable(f) {
  if (!f.includes('app.asar')) return f
  try {
    const tmp = path.join(app.getPath('temp'), `pet-sound-${Date.now()}-${path.basename(f)}`)
    fs.copyFileSync(f, tmp) // Electron 的 fs 可读 asar 内文件
    console.log(`[pet] 音效解压到临时目录: ${tmp}`)
    return tmp
  } catch (e) {
    console.log(`[pet] 音效解压失败，回退原路径: ${e?.message ?? e}`)
    return f
  }
}

ipcMain.on('play-sound', (_e, mode) => playSoundFile(mode))

// 打开 DSH GUI：按打开方式（桌宠窗口直达会话 / 系统浏览器）
let guiWindow = null

function openGui() {
  if (openMode === 'browser') {
    shell.openExternal(DSH_URL)
    return
  }
  openGuiWindow()
}

function openGuiWindow() {
  if (guiWindow && !guiWindow.isDestroyed()) {
    guiWindow.show()
    guiWindow.focus()
    return
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workArea
  guiWindow = new BrowserWindow({
    width: Math.round(sw * 0.85),
    height: Math.round(sh * 0.85),
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  guiWindow.loadURL(DSH_URL)
  guiWindow.on('closed', () => { guiWindow = null })
  guiWindow.webContents.once('did-finish-load', () => {
    // 等前端渲染完成再尝试直达第一个会话（无会话则停在首页）
    setTimeout(() => autoSelectSession(guiWindow), 1800)
  })
}

// 在 GUI 里自动点击第一个会话（有会话时）
async function autoSelectSession(win) {
  if (pet.sessions.size === 0) return // 无会话：停在首页
  try {
    const result = await win.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
      if (rows.length === 0) return 'no-session'
      rows[0].click()
      return 'clicked'
    })()`)
    if (result === 'no-session') {
      console.log('[pet] 未找到会话列表项，停在首页')
      return
    }
    // 验证：点击后检查是否离开"新会话"工作台、进入会话
    setTimeout(async () => {
      try {
        const text = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""')
        const isWorkspace = text.includes('开始构建吧')
        const hasInput = text.includes('发送') || text.includes('输入')
        console.log(`[pet] 已点击第一个会话，主区域检查: 仍在工作台=${isWorkspace} 进入会话=${hasInput}`)
      } catch { /* ignore */ }
    }, 900)
  } catch {
    /* 定位失败不阻塞：用户可手动点击 */
  }
}

ipcMain.on('drag-move', (_e, { dx, dy }) => {
  if (!mainWindow) return
  const [x, y] = mainWindow.getPosition()
  mainWindow.setPosition(Math.round(x + dx), Math.round(y + dy))
})
// 右键菜单：Menu.popup() 不带坐标 = 在鼠标当前位置（鲸鱼附近）弹出；
// 不能用 tray.popUpContextMenu（那会把菜单弹到屏幕顶部菜单栏）
ipcMain.on('pet-context-menu', () => {
  buildMenu().popup({ window: mainWindow ?? undefined })
})

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock.hide()

    tray = new Tray(trayIcon())
    tray.setToolTip('DSH 桌宠')
    tray.setContextMenu(buildMenu())
    tray.on('click', () => openGui())

    createWindow()

    if (SHOT_MODE) {
      runShotMode()
      return
    }

    connectMux()
    connectHost()
    pollSessions()
    setInterval(pollSessions, POLL_MS)

    if (SMOKE) {
      console.log(`[pet-smoke] DSH_URL=${DSH_URL}`)
      setTimeout(() => {
        console.log('[pet-smoke] done, quitting')
        app.quit()
      }, SMOKE_MS)
    }
  })

  app.on('window-all-closed', () => app.quit())
}

// ---------------------------------------------------------------------------
// 截图自检：逐状态注入合成数据并截图（--shot [输出目录]）
// ---------------------------------------------------------------------------
function fakeSnapshot(mode) {
  const base = { mode, running: [], attention: [], done: [], queued: 0, bubble: { title: '', body: '' } }
  if (mode === 'working') {
    // 合成 6 个运行中会话，验证多行列表 + 滚动
    base.running = Array.from({ length: 6 }, (_, i) => ({
      sessionId: `s${i + 1}`,
      title: `示例会话 ${i + 1}：市场调研与竞品分析报告`,
    }))
    base.bubble = {
      title: '正在干活…（6 个会话）',
      body: base.running.map((s, i) => `${i + 1}. 「${s.title}」· 当前：收集资料`).join('\n'),
    }
  }
  if (mode === 'attention') {
    base.attention = Array.from({ length: 4 }, (_, i) => ({
      kind: 'approval',
      text: `「会话 ${i + 1}」请求使用 ${['bash', 'write', 'edit', 'glob'][i]}`,
    }))
    base.bubble = {
      title: '需要你确认 · 4 项',
      body: base.attention.map((a, i) => `${i + 1}. ${a.text}`).join('\n'),
    }
  }
  if (mode === 'done') {
    base.done = Array.from({ length: 3 }, (_, i) => ({ sessionId: `s${i + 1}`, title: `示例：任务 ${i + 1} 完成` }))
    base.bubble = {
      title: '任务完成啦 🎉',
      body: base.done.map((d, i) => `${i + 1}. 「${d.title}」`).join('\n'),
    }
  }
  if (mode === 'idle') base.bubble = { title: '休息中 💤', body: '没有运行中的任务' }
  if (mode === 'offline') base.bubble = { title: '连不上 DSH 😢', body: 'GUI 无响应，我会自动重试' }
  return base
}

function runShotMode() {
  const outDir = process.argv[process.argv.indexOf('--shot') + 1] || path.join(__dirname, '.shots')
  fs.mkdirSync(outDir, { recursive: true })
  mainWindow.webContents.on('console-message', (_e, _level, message) => console.log(`[renderer] ${message}`))
  mainWindow.webContents.on('preload-error', (_e, p, error) => console.log(`[preload-error] ${p}: ${String(error)}`))
  const modes = ['working', 'attention', 'done', 'idle', 'offline']
  const skins = ['pixel', 'vector']
  const combos = []
  for (const mode of modes) for (const sk of skins) combos.push([mode, sk])
  let i = 0
  const tick = async () => {
    if (i >= combos.length) {
      console.log(`[pet-shot] saved ${combos.length} shots to ${outDir}`)
      app.quit()
      return
    }
    const [mode, sk] = combos[i]
    mainWindow.webContents.send('skin-change', sk)
    mainWindow.webContents.send('pet-state', fakeSnapshot(mode))
    await new Promise((r) => setTimeout(r, 700))
    const dom = await mainWindow.webContents.executeJavaScript(`(() => {
      const w = document.getElementById('whale')
      const st = document.getElementById('stage')
      const sparks = [...document.querySelectorAll('.spark')].map((s) => {
        const r = s.getBoundingClientRect()
        const cs = getComputedStyle(s)
        return { d: cs.display, o: cs.opacity, rect: [Math.round(r.x), Math.round(r.y)] }
      })
      return { mode: document.getElementById('root')?.dataset.mode, skin: document.getElementById('root')?.dataset.skin, hasWhale: !!w, stage: st ? { w: st.offsetWidth, h: st.offsetHeight } : null, sparks, pet: typeof window.pet }
    })()`)
    console.log(`[pet-shot] dom ${sk}/${mode}: ${JSON.stringify(dom)}`)
    const img = await mainWindow.webContents.capturePage()
    const name = `${sk}-${mode}.png`
    fs.writeFileSync(path.join(outDir, name), img.toPNG())
    console.log(`[pet-shot] captured ${name}`)
    i += 1
    tick()
  }
  mainWindow.webContents.once('did-finish-load', () => setTimeout(tick, 300))
}
