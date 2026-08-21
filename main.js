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
const os = require('os')

// DSH 地址解析顺序（兼容各种壳子/端口）：
//   1. 环境变量 DSH_PET_URL（启动脚本注入，最明确）
//   2. 持久化配置 userData/pet-config.json（上次自动探测/手动设置的结果）
//   3. 自动探测常见端口（标准 dsh 3080 / EAC 壳 52693 / 隔离测试 13080 等）
//   4. 默认 3080
let DSH_URL = (process.env.DSH_PET_URL || '').replace(/\/+$/, '')
const DSH_PROBE_PORTS = [3080, 52693, 13080, 18080, 4000, 5000]
let dshAutoDetected = false // 是否由自动探测找到（供托盘显示/菜单"重新探测"）

function dshConfigPath() {
  try { return path.join(app.getPath('userData'), 'pet-config.json') } catch { return '' }
}
function loadDshConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(dshConfigPath(), 'utf8'))
    if (typeof c.dshUrl === 'string' && c.dshUrl) return c.dshUrl
  } catch { /* 无配置 */ }
  return ''
}
function saveDshConfig(url) {
  try { fs.writeFileSync(dshConfigPath(), JSON.stringify({ dshUrl: url })) } catch { /* ignore */ }
}

// 探测某个端口是否是 DSH：POST /api/session.list 期望 server-response 结构
async function probeDshPort(port) {
  const url = `http://127.0.0.1:${port}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1200)
  try {
    const res = await fetch(url + '/api/session.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'session.list', payload: {} }),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const body = await res.json()
    if (body?.type === 'server-response' && body?.result) return url
    return null
  } catch { return null } finally { clearTimeout(timer) }
}

// 启动前同步探测（顺序尝试，最多 ~1.2s×N；并行更快的实现见 ensureDshUrl）
async function detectDshUrl() {
  // 1. 环境变量（脚本注入）
  if (DSH_URL) return DSH_URL
  // 2. 持久化配置
  const saved = dshConfigPath() ? loadDshConfig() : ''
  if (saved) { DSH_URL = saved; return saved }
  // 3. 并发探测常见端口
  const results = await Promise.all(DSH_PROBE_PORTS.map((p) => probeDshPort(p)))
  const hit = results.findIndex((u) => !!u)
  if (hit >= 0) {
    DSH_URL = results[hit]
    dshAutoDetected = true
    saveDshConfig(DSH_URL)
    console.log('[pet] DSH 自动探测:', DSH_URL)
    return DSH_URL
  }
  // 4. 默认
  DSH_URL = 'http://127.0.0.1:3080'
  return DSH_URL
}
const POLL_MS = 2000
const DONE_WINDOW_MS = 120_000 // 会话完成后，"完成待查看"提示的保留时长
const SMOKE = process.argv.includes('--smoke')
const SMOKE_MS = 14_000
const SHOT_MODE = process.argv.includes('--shot') // 截图自检模式：把 5 种状态各截一张 PNG
console.log('[pet] build v3.0-DRAGPOLL-CLAMPFIX')

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
  actions: new Map(),          // sessionId -> { label, detail, at } 实时动作（codex 式）
  queuedCount: 0,
}

let mainWindow = null
let topmostTimer = null
let tray = null
let bubbleVisible = true
let skin = 'pixel'
let petScale = 0.67
let openMode = loadOpenMode() // 'window'（桌宠窗口直达会话）| 'browser'（系统浏览器）——菜单可切换
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
    // 任务具体进度：steps/turns/耗时/token（sessionStats + contextTimeline）
    const st = s.projections?.values?.sessionStats || null
    const ct = s.projections?.values?.contextTimeline || null
    const stats = st ? {
      steps: st.steps ?? 0,
      turns: st.turns ?? 0,
      llmMs: st.llmMs ?? 0,
      toolMs: st.toolMs ?? 0,
      tokens: st.decodeTokens ?? 0,
      ctxTotal: ct?.current?.total ?? 0,
      model: ct?.model || '',
    } : (prev?.stats || null)
    const cur = { title, running: !!s.running, todos, stats }
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
let pollTimer = null

// 停止轮询与 WS（重连/重新探测前调用）
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  for (const k of Object.keys(wsState)) {
    const st = wsState[k]
    if (st.timer) { clearTimeout(st.timer); st.timer = null }
    try { st.ws?.close() } catch { /* ignore */ }
    delete wsState[k]
  }
}

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
      pet.actions.delete(p.sessionId)
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
    case 'session/event': {
      trackLiveAction(p)
      // 一轮回答完成（turn/end completed）：语音播报完成提示
      // （rc.6 帧格式：event.data.reason.kind，reason 在 data 内而非事件顶层）
      if (p.event?.type === 'turn/end' && p.event.data?.reason?.kind === 'completed') {
        playSoundFile('done')
      }
      break
    }
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// 实时动作（codex 式）：从 session/event 流还原会话"正在干什么"
// 标签与 dsh-answer-pet 一致：分析任务 / 推理与规划 / 组织回答 / 调用 <工具>
// ---------------------------------------------------------------------------
function summarizeArgs(argsStr) {
  try {
    const a = JSON.parse(argsStr || '{}')
    for (const k of ['description', 'file_path', 'path', 'url', 'pattern', 'query', 'reason', 'text']) {
      const v = a[k]
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 60)
    }
  } catch { /* 非 JSON 参数 */ }
  return ''
}

let liveTimer = null
// 事件流很密（assistant/chunk 逐字到达），合并为最多每 300ms 发一次快照
function emitLiveSoon() {
  if (liveTimer) return
  liveTimer = setTimeout(() => { liveTimer = null; emit() }, 300)
}

function trackLiveAction(p) {
  const ev = p.event
  if (!ev) return
  const sid = p.sessionId
  const d = ev.data || {}
  let act = null
  switch (ev.type) {
    case 'turn/start':
      act = { label: '分析任务', detail: '' }
      break
    case 'tool/call': {
      const name = d.name || '工具'
      const sum = summarizeArgs(d.arguments)
      act = { label: '调用 ' + name, detail: sum ? '…' + sum : '' }
      break
    }
    case 'tool/result':
      act = { label: '工具完成', detail: d.name ? d.name : '' }
      break
    case 'assistant/chunk': {
      const c = d.chunk
      if (!c || typeof c.text !== 'string') break
      if (c.type === 'reasoning-delta') act = { label: '推理与规划', detail: '', append: c.text }
      else if (c.type === 'text-delta') act = { label: '组织回答', detail: '', append: c.text }
      break
    }
    case 'assistant/message': {
      const txt = (d.message?.content || [])
        .filter((x) => x.type === 'text' && typeof x.text === 'string')
        .map((x) => x.text).join('')
      if (txt) act = { label: '组织回答', detail: txt.slice(-80) }
      break
    }
    case 'turn/end':
      pet.actions.delete(sid)
      return
    default:
      return
  }
  if (!act) return
  if (act.append !== undefined) {
    // 流式增量：同标签时累积，保留最近 200 字符（避免无限膨胀）
    const prev = pet.actions.get(sid)
    const acc = ((prev && prev.label === act.label ? prev.detail : '') + act.append).slice(-200)
    act = { label: act.label, detail: acc }
  }
  act.at = Date.now()
  pet.actions.set(sid, act)
  emitLiveSoon()
}

// ---------------------------------------------------------------------------
// 状态推导 + 气泡文案
// ---------------------------------------------------------------------------
function buildSnapshot() {
  const running = [...pet.sessions.entries()]
    .filter(([, s]) => s.running)
    .map(([id, s]) => ({ sessionId: id, title: s.title, action: pet.actions.get(id) || null }))
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
// M8: 托盘图标用程序生成的 PNG（nativeImage 对 SVG dataURL 在 Windows 上不可靠）
const { makeTrayPngDataUrl } = require('./tray-icon')

function trayIcon() {
  const img = nativeImage.createFromDataURL(makeTrayPngDataUrl())
  if (img.isEmpty()) {
    console.warn('[pet] tray PNG empty')
    return img
  }
  return img.resize({ width: 18, height: 18 })
}

async function redetectDsh() {
  // 清除持久化配置后重新探测；成功则重建菜单
  try { fs.unlinkSync(dshConfigPath()) } catch { /* ignore */ }
  const url = await detectDshUrl()
  console.log('[pet] 重新探测 DSH:', url)
  tray?.setContextMenu(buildMenu())
  // 重新连接
  stopPolling()
  connectMux()
  connectHost()
  pollSessions()
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '打开 DSH GUI', click: () => openGui() },
    {
      label: 'DSH: ' + DSH_URL.replace(/^https?:\/\//, ''),
      enabled: false, // 只读显示当前连接目标
    },
    {
      label: '重新探测 DSH 地址',
      click: () => redetectDsh(),
    },
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

// openMode persistence: remember last choice so click pulls the shell when
// the in-app window is alive, or the browser when the user prefers web
function openModeStateFile() {
  return path.join(app.getPath('userData'), 'open-mode.json')
}
function loadOpenMode() {
  try {
    const v = JSON.parse(fs.readFileSync(openModeStateFile(), 'utf8'))
    if (v === 'window' || v === 'browser') return v
  } catch { /* default */ }
  return 'window'
}
function setOpenMode(m) {
  if (openMode === m) return
  openMode = m
  try { fs.writeFileSync(openModeStateFile(), JSON.stringify(m)) } catch { /* ignore */ }
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

const PET_W = 280
const PET_H = 340

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea
  mainWindow = new BrowserWindow({
    width: PET_W,
    height: PET_H,
    x: wa.x + wa.width - PET_W - 18,
    y: wa.y + wa.height - PET_H - 24,
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
  mainWindow.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // TOPMOST 强化：DSH/EAC 壳窗口也是置顶（WS_EX_TOPMOST），后置顶者 z-order 更高会盖住宠物。
  // 周期性重设置顶，把宠物顶回 TOPMOST 顶端（每 4 秒一次，开销极小）。
  if (topmostTimer) clearInterval(topmostTimer)
  topmostTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating')
    }
  }, 4000)
  passthroughOn = true
  mainWindow.setIgnoreMouseEvents(true, { forward: true })
  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'))
  // 页面加载后同步皮肤、鲸鱼大小与自定义素材包（含启动默认值）
  mainWindow.webContents.once('did-finish-load', () => {
    // M1 位置持久化：优先恢复上次拖拽位置（需在屏幕内），否则回右下角
    const _sb = screen.getPrimaryDisplay().bounds
    let _tx = _sb.x + _sb.width - PET_W - 18
    let _ty = _sb.y + _sb.height - PET_H - 24
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'pet-pos.json'), 'utf8'))
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        // 只接受仍在屏幕内（含图标 clamp 允许的负偏移）的位置
        const sx = _sb.x - 60, sy = _sb.y - 250
        const ex = _sb.x + _sb.width - 60, ey = _sb.y + _sb.height - 60
        if (saved.x >= sx && saved.x <= ex && saved.y >= sy && saved.y <= ey) {
          _tx = saved.x; _ty = saved.y
        }
      }
    } catch { /* 无存档：默认右下角 */ }
    mainWindow.setBounds({ x: _tx, y: _ty, width: PET_W, height: PET_H })
    const _ab = mainWindow.getBounds()
    console.log('[pet] did-finish-load setBounds(', _tx, _ty, PET_W, PET_H, ') actual:', JSON.stringify(_ab))
    // If setBounds failed (transparent frameless bug), try setPosition
    if (Math.abs(_ab.x - _tx) > 5 || Math.abs(_ab.y - _ty) > 5) {
      mainWindow.setPosition(_tx, _ty)
      const _ab2 = mainWindow.getBounds()
      console.log('[pet] setPosition fallback actual:', JSON.stringify(_ab2))
    }
    mainWindow.webContents.send('skin-change', skin)
    mainWindow.webContents.send('pet-scale', petScale)
    const custom = loadCustomSprites()
    if (custom) mainWindow.webContents.send('custom-sprites', custom)
  })
  mainWindow.once('ready-to-show', () => {
    // H1: 位置已在 did-finish-load 收敛（M1 持久化/默认右下角），这里只 show，
    // 不再 setPosition 覆盖恢复的位置
    mainWindow.show()
  })
  mainWindow.on('closed', () => { mainWindow = null; stopCursorPoll() })
  startCursorPoll()
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.on('pet-click', () => openGui())

// ---------------------------------------------------------------------------
// 状态提示音：跨平台播放（win32=PowerShell+WPF, darwin=afplay, linux=paplay）
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
  if (!f) {
    console.warn(`[pet] 提示音文件缺失: ${base}（已查找: ${candidates.join(', ')}）`)
    return
  }
  if (afplayProc && !afplayProc.killed) afplayProc.kill() // 防止重叠播放
  const target = asarPlayable(f)
  console.log(`[pet] 播放提示音: ${target}`)
  const proc = spawnSound(target)
  afplayProc = proc
  proc.on('error', (err) => {
    console.warn(`[pet] afplay 启动失败（${base}）: ${err?.message ?? err}`)
  })
  proc.stderr?.on('data', (d) => console.warn(`[pet] afplay stderr: ${String(d).trim()}`))
  proc.on('exit', (code) => {
    if (afplayProc === proc) afplayProc = null
    if (!proc.killed && code !== 0) console.warn(`[pet] afplay 退出码 ${code}（${base}）`)
    cleanupSoundTemp(target)
  })
}

// 跨平台提示音播放器：
// - win32: PowerShell + WPF MediaPlayer（原生支持 m4a/mp4，无需额外依赖）
// - darwin: afplay（macOS 原生）
// - linux: paplay 尝试播放（不支持 m4a 时静默）
function spawnSound(target) {
  const plat = process.platform
  if (plat === 'darwin') return spawn('afplay', [target])
  if (plat === 'win32') {
    const url = 'file:///' + target.replace(/\\/g, '/').replace(/ /g, '%20')
    const ps = [
      'Add-Type -AssemblyName presentationcore;',
      '$m = New-Object System.Windows.Media.MediaPlayer;',
      "$m.Open([uri]'" + url + "');",
      '$m.Play();',
      'Start-Sleep -Milliseconds 1200;',
      '$m.Close()',
    ].join(' ')
    return spawn('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true })
  }
  return spawn(plat === 'linux' ? 'paplay' : 'true', [target], { windowsHide: true })
}

// 播放结束后清理解压到临时目录的音效，避免残留
function cleanupSoundTemp(f) {
  if (!f.startsWith(app.getPath('temp'))) return
  try { fs.unlinkSync(f) } catch { /* ignore */ }
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

// Predictable smart open - the shell window is the in-app experience:
//   1. 已在用的壳（DSH_URL 端口监听进程的主窗口）存在 -> 直接激活（不开新壳）
//   2. 无壳在跑 -> 按持久化 openMode（'browser' 系统浏览器 / 'window' 内置桌宠窗）
function openGui() {
  if (guiWindow && !guiWindow.isDestroyed()) {
    if (guiWindow.isMinimized()) guiWindow.restore()
    guiWindow.show()
    guiWindow.focus()
    console.log('[pet] openGui -> pull existing shell')
    return
  }
  // 优先：激活用户正在用的 DSH 壳（端口监听进程的主窗口）
  activateRunningShell((activated) => {
    if (activated) return
    if (openMode === 'browser') {
      console.log('[pet] openGui -> browser (persisted mode)')
      shell.openExternal(DSH_URL)
      return
    }
    // 用户要求：不拉起内置会话窗；拉不起在用的壳子就开系统浏览器
    console.log('[pet] openGui -> browser (shell activation failed)')
    shell.openExternal(DSH_URL)
  })
}

// 找到 DSH_URL 端口监听进程，沿父进程链找到壳 GUI 进程的主窗口并激活到前台。
// 说明：DSH/EAC 壳的端口常由子进程（node）监听，GUI 窗口在父进程（Electron 壳），
// 因此沿 ParentProcessId 上溯找第一个有 MainWindowHandle 的进程；
// 用 ALT 键技巧绕过 Windows 前台锁（SetForegroundWindow 需用户交互上下文）。
function activateRunningShell(cb) {
  let port = '3080'
  try { port = new URL(DSH_URL).port || '80' } catch { /* keep default */ }
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$port = '" + port + "'",
      'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class Act { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f); [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO fi); [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i); [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v); public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; } }\'',
      '$listener = Get-NetTCPConnection -State Listen -LocalPort $port | Select-Object -First 1',
      'if (-not $listener) { Write-Output "err:no-listener:$port"; exit 10 }',
      '$pid2 = $listener.OwningProcess',
      'if (-not $pid2) { Write-Output "err:no-pid"; exit 10 }',
      '# walk parent chain to a window-owning process (max 8)',
      '$cur = $pid2',
      '$hwnd = [IntPtr]::Zero',
      'for ($i = 0; $i -lt 8; $i++) {',
      '  $pr = Get-Process -Id $cur -ErrorAction SilentlyContinue',
      '  if (-not $pr) { break }',
      '  if ($pr.MainWindowHandle -ne 0) { $hwnd = $pr.MainWindowHandle; $title = $pr.MainWindowTitle; break }',
      '  $wmi = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue',
      '  if (-not $wmi -or -not $wmi.ParentProcessId -or $wmi.ParentProcessId -eq $cur) { break }',
      '  $cur = $wmi.ParentProcessId',
      '}',
      'if ($hwnd -eq [IntPtr]::Zero) { Write-Output "err:no-hwnd"; exit 11 }',
      'Write-Output ("target hwnd=" + $hwnd + " title=" + $title)',
      '[Act]::ShowWindow($hwnd, 9) | Out-Null',
      '[Act]::BringWindowToTop($hwnd) | Out-Null',
      '[Act]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null',
      '$myThread = [Act]::GetCurrentThreadId()',
      '$x = 0',
      '$ok = $false',
      'for ($i = 0; $i -lt 4; $i++) {',
      '  $fg = [Act]::GetForegroundWindow()',
      '  $fgThread = [Act]::GetWindowThreadProcessId($fg, [ref]$x)',
      '  # ALT unlock (Windows foreground lock) then AttachThreadInput',
      '  [Act]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero) | Out-Null',
      '  [Act]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero) | Out-Null',
      '  if ($fgThread -ne 0 -and $fgThread -ne $myThread) {',
      '    [Act]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null',
      '    [Act]::SetForegroundWindow($hwnd) | Out-Null',
      '    [Act]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null',
      '  } else {',
      '    [Act]::SetForegroundWindow($hwnd) | Out-Null',
      '  }',
      '  if ([Act]::GetForegroundWindow() -eq $hwnd) { $ok = $true; break }',
      '  Start-Sleep -Milliseconds 150',
      '}',
      '[Act]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null',
      'if ($ok) {',
      '  # 降低壳子置顶等级：HWND_NOTOPMOST(-2) 从置顶层移除（WS_EX_TOPMOST 位只能由 z-order API 改）',
      '  $ex = [Act]::GetWindowLong($hwnd, -20)',
      '  if (($ex -band 0x8) -ne 0) {',
      '    [Act]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null',
      '    Write-Output "topmost lowered"',
      '  }',
      '  Write-Output "ok fg=$hwnd"',
      '  exit 0',
      '}',
      '# fallback: flash taskbar (FlashWindowEx works cross-process; failure not fatal)',
      'try {',
      '  $ft = [Act].Assembly.GetType("Act+FLASHWINFO")',
      '  if ($ft) {',
      '    $fi = [System.Activator]::CreateInstance($ft)',
      '    $fi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($ft)',
      '    $fi.hwnd = $hwnd',
      '    $fi.dwFlags = 3',
      '    $fi.uCount = 5',
      '    $fi.dwTimeout = 120',
      '    [Act]::FlashWindowEx([ref]$fi) | Out-Null',
      '    Write-Output "flashed"',
      '  } else { Write-Output "flash:type-missing" }',
      '} catch { "flash skipped: $($_.Exception.Message)" }',
      'Write-Output ("err:foreground-failed fg=" + [Act]::GetForegroundWindow())',
      'exit 12',
    ].join("\n")
    // 长脚本经 -Command 传参会踩 Windows 命令行引号规则（嵌套引号截断 C# 代码，
    // Add-Type 编译失败 -> [Act] 不存在 -> 静默失败 exit 12）。
    // 写入临时 .ps1 再用 -File 执行：文件内容无引号截断问题。
    const psPath = path.join(os.tmpdir(), 'pet-act-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.ps1')
    try { fs.writeFileSync(psPath, script, 'utf8') } catch (e) {
      console.log('[pet] activate ps1 write fail:', String(e)); cb(false); return
    }
    const proc = spawn('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', psPath], { windowsHide: true })
    const cleanup = () => { try { fs.unlinkSync(psPath) } catch { /* ignore */ } }
    proc.on('error', () => { cleanup(); cb(false) })
    proc.on('exit', (c) => { console.log('[pet] activate shell exit', c); cleanup(); cb(c === 0) })
    return
  }
  // macOS/Linux：打开系统浏览器（无通用"激活窗口"方案）
  shell.openExternal(DSH_URL)
  cb(true)
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

// drag state: record window origin + pointer screen pos (converted to DIP, avoids unit mismatch under high-DPI scaling)
// ---- main-owned passthrough + drag latch ----
// ONE owner decides setIgnoreMouseEvents. Renderer only REPORTS whether the
// pointer is over whale/bubble ('pet-clickable'); drag start/end latch the
// window fully interactive for the whole gesture so hit-test flicker or a
// stray mouseleave can never flip passthrough mid-drag (which lost mouseup
// and caused ghost-dragging).
let dragging = false
let passthroughOn = true
let lastClickable = false
let dragOrigin = null // { dipX, dipY, winX, winY }

function setPassthrough(on) {
  if (!mainWindow || passthroughOn === on) return
  passthroughOn = on
  mainWindow.setIgnoreMouseEvents(on, { forward: true })
  console.log('[pet] passthrough', on ? 'on' : 'off')
}

// cursor inside the pet window bounds? (DIP, same unit as getBounds)
function cursorInsideWindow() {
  if (!mainWindow) return false
  // getCursorScreenPoint() returns DIP, same unit as getBounds() - compare directly.
  const c = screen.getCursorScreenPoint()
  const b = mainWindow.getBounds()
  return c.x >= b.x && c.x <= b.x + b.width && c.y >= b.y && c.y <= b.y + b.height
}

// ---- 光标轮询:不依赖转发事件,主动控制 passthrough ----
// 根因:WS_EX_TRANSPARENT(点击穿透)下真实鼠标消息穿透到下层窗口,
// forward:true 转发失效,渲染器收不到 mousemove,clickable 永远 false,
// 窗口一旦 passthrough 就永远无法恢复交互(拖不动)。
// 方案:渲染器报告鲸鱼/气泡的窗口内坐标,主进程每 50ms 轮询光标位置,
// 光标在交互区 -> passthrough off(可点击),否则 -> on(点击穿透)。
let hitAreas = null // { whale: {x,y,w,h}, bubble: {x,y,w,h} } 窗口内坐标(CSS px = DIP)
let cursorPoll = null

ipcMain.on('pet-hit-areas', (_e, areas) => {
  hitAreas = areas
})

function pointInRect(px, py, r) {
  return !!r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h
}

// 光标是否在交互区(鲸鱼/气泡)?窗口内坐标
function cursorInHitArea() {
  if (!mainWindow) return false
  const c = screen.getCursorScreenPoint()
  const b = mainWindow.getBounds()
  const lx = c.x - b.x
  const ly = c.y - b.y
  if (hitAreas) {
    return pointInRect(lx, ly, hitAreas.whale) || pointInRect(lx, ly, hitAreas.bubble)
      || pointInRect(lx, ly, hitAreas.foldBtn) || pointInRect(lx, ly, hitAreas.foldCount)
  }
  // 兜底(渲染器尚未报告布局):窗口底部 40% 视为交互区(鲸鱼+气泡都在底部)
  return lx >= 0 && lx <= b.width && ly >= 0 && ly <= b.height && ly > b.height * 0.4
}

function startCursorPoll() {
  if (cursorPoll) return
  console.log('[pet] cursor-poll STARTED')
  cursorPoll = setInterval(() => {
    if (!mainWindow || dragging) return
    setPassthrough(!cursorInHitArea())
  }, 50)
}

function stopCursorPoll() {
  if (cursorPoll) { clearInterval(cursorPoll); cursorPoll = null }
}

// no-arg protocol: main process reads the cursor itself (getCursorScreenPoint returns DIP)
// avoids IPC argument conversion errors and high-DPI unit mismatch entirely
ipcMain.on('drag-start', () => {
  if (!mainWindow) return
  // GUARD: with setIgnoreMouseEvents(true,{forward:true}) Windows forwards
  // mouse events even when the pointer is OUTSIDE the window. A stray
  // mousedown then starts a ghost drag and the window chases the cursor
  // with no button held (= the reported drift). Only accept drags that
  // begin with the cursor inside the window.
  const _raw = screen.getCursorScreenPoint()
  const _b = mainWindow.getBounds()
  const _inside = cursorInsideWindow()
  console.log('[pet] drag-check', JSON.stringify({ cursor: _raw, bounds: _b, inside: _inside }))
  if (!_inside) {
    console.log('[pet] drag-start REJECTED (cursor outside window)')
    return
  }
  dragging = true
  // FORCE-SIZE: restore fixed size in case Windows stretched the window
  // on a previous drag. setBounds atomically fixes position + size.
  const dip = screen.getCursorScreenPoint()
  const _bs = mainWindow.getBounds()
  let [winX, winY] = mainWindow.getPosition()
  if (_bs.width !== PET_W || _bs.height !== PET_H) {
    mainWindow.setBounds({ x: winX, y: winY, width: PET_W, height: PET_H })
    winX = mainWindow.getPosition()[0]
    winY = mainWindow.getPosition()[1]
  }
  dragOrigin = { dipX: dip.x, dipY: dip.y, winX, winY }
  // latch: window fully interactive for the entire drag gesture
  setPassthrough(false)
  startDragPoll()
  console.log('[pet] drag-start')
})

// DRAG-POLL: main process actively tracks the cursor during drag, so the
// window keeps following even when the cursor leaves the window bounds
// (renderer mousemove stops firing outside the window). This replaces the
// renderer-driven drag-move IPC as the primary drag motor.
let dragPoll = null
function startDragPoll() {
  if (dragPoll) return
  let dpHb = 0
  let lastDip = null
  let idleFrames = 0
  dragPoll = setInterval(() => {
    if (!mainWindow || !dragOrigin) return
    const dip = screen.getCursorScreenPoint()
    // H1 WATCHDOG: if the cursor has not moved for ~750ms the user has almost
    // certainly released the button (and the renderer mouseup was lost).
    // End the drag instead of leaving passthrough latched forever.
    if (lastDip) {
      if (Math.abs(dip.x - lastDip.x) < 1 && Math.abs(dip.y - lastDip.y) < 1) {
        idleFrames++
        if (idleFrames > 45) { // ~750ms at 16ms
          console.log('[pet] drag-poll watchdog: cursor idle -> drag-end')
          dragOrigin = null
          dragging = false
          stopDragPoll()
          savePetPosition() // M1: watchdog 结束路径同样落盘，避免最后位置丢失
          setPassthrough(true)
          return
        }
      } else {
        idleFrames = 0
      }
    }
    lastDip = dip
    let nx = Math.round(dragOrigin.winX + (dip.x - dragOrigin.dipX))
    let ny = Math.round(dragOrigin.winY + (dip.y - dragOrigin.dipY))
    // H2: clamp against the display nearest to the cursor (multi-monitor safe)
    const sb = screen.getDisplayNearestPoint(dip).bounds
    // ICON-CLAMP: clamp to the WHALE PIXEL bbox (hitAreas.icon) so the visible
    // icon can touch every screen corner. Window may overhang (transparent).
    const wh = (hitAreas && hitAreas.icon) || (hitAreas && hitAreas.whale) || null
    const offX = wh ? wh.x : 0
    const offY = wh ? wh.y : 0
    const iconW = wh ? wh.w : PET_W
    const iconH = wh ? wh.h : PET_H
    nx = Math.max(sb.x - offX, Math.min(nx, sb.x + sb.width - offX - iconW))
    ny = Math.max(sb.y - offY, Math.min(ny, sb.y + sb.height - offY - iconH))
    mainWindow.setBounds({ x: nx, y: ny, width: PET_W, height: PET_H })
    if (++dpHb % 30 === 0) { // every ~500ms
      const ab = mainWindow.getBounds()
      console.log('[pet] dp-hb', JSON.stringify({ nx, ny, offX, offY, iconW, iconH, actual: { x: ab.x, y: ab.y, w: ab.width, h: ab.height } }))
    }
  }, 16)
  console.log('[pet] drag-poll STARTED')
}
function stopDragPoll() {
  if (dragPoll) { clearInterval(dragPoll); dragPoll = null; console.log('[pet] drag-poll STOPPED') }
}

function savePetPosition() {
  try {
    const b = mainWindow.getBounds()
    fs.writeFileSync(path.join(app.getPath('userData'), 'pet-pos.json'), JSON.stringify({ x: b.x, y: b.y }))
  } catch { /* ignore */ }
}

ipcMain.on('drag-end', () => {
  stopDragPoll()
  dragOrigin = null
  dragging = false
  savePetPosition()
  // after release the cursor is still over the pet (window followed it), so
  // stay interactive; passthrough resumes only when the pointer leaves and
  // the renderer reports clickable=false
  console.log('[pet] drag-end')
})

// renderer reports pointer-over-whale/bubble (informational only;
// passthrough is controlled by the cursor poll - forwarded events are
// unreliable under WS_EX_TRANSPARENT)
ipcMain.on('pet-clickable', (_e, clickable) => {
  if (!mainWindow) return
  lastClickable = Boolean(clickable)
})
// 右键菜单：Menu.popup() 不带坐标 = 在鼠标当前位置（鲸鱼附近）弹出；
// 不能用 tray.popUpContextMenu（那会把菜单弹到屏幕顶部菜单栏）
ipcMain.on('pet-context-menu', () => {
  if (!mainWindow) return
  setPassthrough(false)
  buildMenu().popup({
    window: mainWindow,
    callback: () => {
      // menu closed: cursor poll restores passthrough automatically
    },
  })
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

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock.hide()

    // 兼容各种壳子：先确定 DSH 地址（环境变量 > 配置 > 自动探测）
    await detectDshUrl()
    console.log('[pet] DSH_URL =', DSH_URL)

    try {
      tray = new Tray(trayIcon())
      tray.setToolTip('DSH 桌宠')
      tray.setContextMenu(buildMenu())
      tray.on('click', () => openGui())
    } catch (err) {
      console.warn('[pet] tray 创建失败（继续运行，无托盘）:', err?.message ?? err)
    }

    try {
      createWindow()
    } catch (err) {
      console.error('[pet] createWindow 失败:', err?.message ?? err)
    }

    if (SHOT_MODE) {
      runShotMode()
      return
    }

    connectMux()
    connectHost()
    pollSessions()
    pollTimer = setInterval(pollSessions, POLL_MS)

    if (SMOKE) {
      console.log(`[pet-smoke] DSH_URL=${DSH_URL}`)
      setTimeout(() => {
        console.log('[pet-smoke] done, quitting')
        app.quit()
      }, SMOKE_MS)
    }
  }).catch((err) => {
    console.error('[pet] whenReady 失败:', err?.message ?? err)
  })

  // H2: 顶层异常兜底——任何未捕获异常都记录而不是静默挂死
  process.on('uncaughtException', (err) => {
    console.error('[pet] uncaughtException:', err?.stack ?? err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[pet] unhandledRejection:', reason instanceof Error ? reason.stack : String(reason))
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
