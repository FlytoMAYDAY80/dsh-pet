'use strict'

/* ============ DSH 桌宠渲染逻辑 ============ */

const root = document.getElementById('root')
const elBubble = document.getElementById('bubble')
const elTitle = document.getElementById('bubble-title')
const elBody = document.getElementById('bubble-body')
const elDot = document.getElementById('bubble-dot')
const elSessions = document.getElementById('session-list')
const elFoldBtn = document.getElementById('fold-btn')
const elFoldCount = document.getElementById('fold-count')

let bubbleOn = true
let lastMode = null
let soundOn = true
let folded = false // 会话列表折叠（仅隐藏列表，气泡标题保留）

/* ---------------- 状态提示音 ----------------
 * 播放由主进程用系统播放器 afplay 执行（custom/ 优先，回退内置），
 * 避免 Chromium 音频输出在 macOS 上的无声问题。
 */
function playSound(mode) {
  if (!soundOn) return
  // M5: done 音由主进程在 turn/end completed 事件播放，渲染器只发 attention，
  // 避免两路同时触发造成截断重放
  if (mode !== 'attention') return
  window.pet.playSound(mode)
}

/* ---------------- 像素版绘制 ---------------- */
const elCanvas = document.getElementById('pixel-canvas')
const pixCtx = elCanvas.getContext('2d')
const PIXEL_SCALE = 6 // 80*6=480 物理宽, 58*6=348 物理高（HD 网格 2x 超采样）

let skin = 'vector'
let currentMode = 'starting'
let rafId = null

/* ---------------- 鲸鱼大小控制 ---------------- */
const elStage = document.getElementById('stage')
// 全尺寸（缩放系数 1.0）时的布局尺寸
const STAGE_FULL = { w: 262, h: 174 }  // 高度贴合鲸鱼内容，避免留白撑大间距
const CANVAS_FULL = { w: 240, h: 174 }
let petScale = 0.67 // 默认：比原尺寸减小 1/3

function applyScale() {
  elStage.style.width = `${Math.round(STAGE_FULL.w * petScale)}px`
  elStage.style.height = `${Math.round(STAGE_FULL.h * petScale)}px`
  elCanvas.style.width = `${Math.round(CANVAS_FULL.w * petScale)}px`
  elCanvas.style.height = `${Math.round(CANVAS_FULL.h * petScale)}px`
}

window.pet.onScaleChange((v) => {
  petScale = v
  applyScale()
  reportHitAreas()
})
applyScale()

// H3: 从像素网格静态推导鲸鱼包围盒（'.' 即透明），零 canvas 读回、零 GC 压力
function spriteIconBBox() {
  const grid = PIXEL_SPRITES.sprites[currentMode] || PIXEL_SPRITES.sprites.default
  const H = grid.length
  const W = grid[0] ? grid[0].length : 0
  let minX = W, minY = H, maxX = -1, maxY = -1
  for (let y = 0; y < H; y++) {
    const row = grid[y]
    for (let x = 0; x < W; x++) {
      const ch = row[x]
      if (ch !== '.' && PIXEL_SPRITES.palette[ch]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  const cr = elCanvas.getBoundingClientRect()
  const r = elStage.getBoundingClientRect()
  const sx = cr.width / (W * PIXEL_SCALE)
  const sy = cr.height / (H * PIXEL_SCALE)
  return {
    x: r.left + minX * PIXEL_SCALE * sx,
    y: r.top + minY * PIXEL_SCALE * sy,
    w: (maxX - minX + 1) * PIXEL_SCALE * sx,
    h: (maxY - minY + 1) * PIXEL_SCALE * sy,
  }
}

function reportHitAreas() {
  const r = elStage.getBoundingClientRect()
  const b = elBubble.getBoundingClientRect()
  // H3+M2: pixel 皮肤用静态推导的像素包围盒；vector 皮肤回退 stage 矩形
  const icon = skin === 'pixel' ? (spriteIconBBox() || { x: r.left, y: r.top, w: r.width, h: r.height }) : { x: r.left, y: r.top, w: r.width, h: r.height }
  // 折叠按钮（气泡下方圆形按钮/计数点）也纳入交互区
  const fb = elFoldBtn.getBoundingClientRect()
  const fc = elFoldCount.getBoundingClientRect()
  const foldBtn = fb.width ? { x: fb.left, y: fb.top, w: fb.width, h: fb.height } : null
  const foldCount = fc.width ? { x: fc.left, y: fc.top, w: fc.width, h: fc.height } : null
  // H2: 命中判定直接用像素级 icon（鲸鱼空白区不再拦截下层窗口点击）
  window.pet.reportHitAreas({
    whale: icon,
    bubble: { x: b.left, y: b.top, w: b.width, h: b.height },
    foldBtn,
    foldCount,
    icon,
  })
}

function drawPixel(time) {
  PIXEL.draw(pixCtx, currentMode, time || 0, PIXEL_SCALE)
  const animated = currentMode === 'working' || currentMode === 'done'
  if (animated) rafId = requestAnimationFrame(drawPixel)
}

function scheduleDraw() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null }
  if (skin !== 'pixel') return
  drawPixel(performance.now())
}

let lastAttentionCount = 0

let sessionCount = 0 // 运行中 + 待确认总数（折叠计数的唯一数据源）

// 单一写者：折叠/计数相关的类名统一由这里根据 { folded, sessionCount } 计算，
// 避免 renderSessions 与 applyFold 各自 toggle 同一个 show-count 造成死锁
// （折叠后无活动会话 → 两个展开入口都不可见）。
function syncBubbleChrome() {
  const showCount = folded || sessionCount > 0
  elBubble.classList.toggle('folded', folded)
  elBubble.classList.toggle('show-count', showCount)
}

// 实时动作文案（codex 风）：'调用 run_code · …读 renderer.js' / '推理与规划 · …'
// 来自主进程 session/event 流（见 main.js trackLiveAction），不是步数/token 统计
function liveAction(r) {
  const a = r && r.action
  if (!a || !a.label) return ''
  return a.detail ? a.label + ' · ' + a.detail : a.label
}

function renderSessions(s) {
  const run = s.running || []
  const att = s.attention || []
  // 行：运行中会话（蓝点 + 进度）、待确认项（黄点）
  const items = []
  for (const r of run) {
    items.push({ cls: 'run', text: r.title, sub: liveAction(r) })
  }
  for (const a of att) items.push({ cls: 'wait', text: a.text.slice(0, 60), sub: '' })
  elSessions.innerHTML = ''
  for (const it of items) {
    const row = document.createElement('div')
    row.className = 'session-item ' + it.cls
    const title = document.createElement('span')
    title.className = 's-title'
    title.textContent = it.text
    title.title = it.text // 长文本悬停可看全文
    row.appendChild(title)
    if (it.sub) {
      const sub = document.createElement('span')
      sub.className = 's-sub'
      sub.textContent = it.sub
      row.appendChild(sub)
    }
    elSessions.appendChild(row)
  }
  // 折叠计数：运行中 + 待确认总数
  sessionCount = run.length + att.length
  elFoldCount.textContent = String(sessionCount)
  syncBubbleChrome()
}

function updateDot(mode) {
  elDot.className = 'dot'
  if (mode === 'working') elDot.classList.add('on')
  else if (mode === 'attention') elDot.classList.add('warn')
  else if (mode === 'offline' || mode === 'error') elDot.classList.add('err')
  else if (mode === 'done') elDot.classList.add('on')
}

window.pet.onState((s) => {
  currentMode = s.mode
  root.dataset.mode = s.mode
  elTitle.textContent = s.bubble.title
  elBody.textContent = s.bubble.body
  renderSessions(s)
  updateDot(s.mode)

  const attentionCount = (s.attention || []).length
  // 仅在状态(mode)真正变化时才让气泡弹一下 + 播放对应提示音；
  // 同一状态下的轮询刷新不再触发动画，避免持续闪动
  if (s.mode !== lastMode) {
    lastMode = s.mode
    playSound(s.mode)
    elBubble.classList.remove('pop')
    void elBubble.offsetWidth
    elBubble.classList.add('pop')
    scheduleDraw() // 像素皮肤：状态变化时重绘
  } else if (s.mode === 'attention' && attentionCount > lastAttentionCount) {
    // 已在「需要确认」状态时又来了新的待确认项：再次响铃提醒（如新审批/新提问）
    playSound('attention')
    elBubble.classList.remove('pop')
    void elBubble.offsetWidth
    elBubble.classList.add('pop')
  }
  lastAttentionCount = attentionCount
  reportHitAreas() // 状态变化可能改变气泡高度/gap,交互区随之变化
})

// 折叠/展开会话列表（折叠后只留计数圆点，气泡标题保留）
function applyFold() {
  syncBubbleChrome()
  reportHitAreas()
}
// M7: 折叠按钮的 mousedown/contextmenu 也 stopPropagation，避免冒泡到 #bubble
// 触发双份 drag-start / context-menu
for (const btn of [elFoldBtn, elFoldCount]) {
  btn.addEventListener('mousedown', (ev) => ev.stopPropagation())
  btn.addEventListener('contextmenu', (ev) => ev.stopPropagation())
}
elFoldBtn.addEventListener('click', (ev) => {
  ev.stopPropagation()
  folded = true
  applyFold()
})
elFoldCount.addEventListener('click', (ev) => {
  ev.stopPropagation()
  folded = false
  applyFold()
})

window.pet.onSoundToggle((v) => {
  soundOn = v
})

// 菜单「测试提示音」：依次播放完成音，供用户确认/试听
window.pet.onTestSound(() => {
  playSound('done')
})

window.pet.onBubbleVisibility((v) => {
  bubbleOn = v
  elBubble.style.display = v ? 'block' : 'none'
  reportHitAreas()
})

window.pet.onSkinChange((v) => {
  skin = v
  root.dataset.skin = v
  scheduleDraw()
  reportHitAreas()
})

// 自定义素材包：覆盖内置像素网格/调色板（来自 custom/sprites.json）
window.pet.onCustomSprites((data) => {
  if (data?.palette && typeof data.palette === 'object') {
    Object.assign(PIXEL_SPRITES.palette, data.palette)
  }
  if (data?.sprites && typeof data.sprites === 'object') {
    PIXEL_SPRITES.sprites = data.sprites
  }
  scheduleDraw()
  reportHitAreas() // M1: 自定义素材可能改变鲸鱼轮廓，包围盒需重算
})

/* ---------------- 拖拽 + 点击（热区：仅气泡 + 鲸鱼本体） ---------------- */
let down = false
let moved = false
let sx = 0
let sy = 0
let clickable = false

/**
 * 点击是否落在鲸鱼像素本体上（像素版：读 canvas 该点 alpha；
 * 矢量版：elementFromPoint 是否命中 SVG 图形元素）。鲸鱼周边空白返回 false。
 */
function isWhaleHit(e) {
  if (skin === 'pixel') {
    const rect = elCanvas.getBoundingClientRect()
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return false
    const px = Math.floor((e.clientX - rect.left) / rect.width * elCanvas.width)
    const py = Math.floor((e.clientY - rect.top) / rect.height * elCanvas.height)
    try {
      return pixCtx.getImageData(px, py, 1, 1).data[3] > 0
    } catch { return false }
  }
  const el = document.elementFromPoint(e.clientX, e.clientY)
  return !!el && el.closest('svg') !== null && el.tagName !== 'svg' && el.id !== 'whale'
}

// pointer hit detection: whale body / bubble -> notify main to disable passthrough (clickable); other areas stay passthrough
function updateClickable(e) {
  // never touch the clickable state mid-drag: the window lags the cursor by
  // >=1 frame, so the pointer can leave the hit rect while the button is held;
  // flipping passthrough then loses mousemove/mouseup and freezes the drag.
  if (down) return
  const r = elStage.getBoundingClientRect()
  const b = elBubble.getBoundingClientRect()
  const onBubble = e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom
  const onStage = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
  const hit = onBubble || (onStage && isWhaleHit(e))
  if (hit !== clickable) { clickable = hit; window.pet.setClickable(hit) }
}
window.addEventListener('mousemove', updateClickable)
window.addEventListener('mouseleave', () => { if (clickable) { clickable = false; window.pet.setClickable(false) } })

// 折叠按钮也属于交互区（点击需要窗口接收鼠标事件）
const hitAreas = [elBubble, elStage, elFoldBtn, elFoldCount]

for (const el of hitAreas) {
  // 折叠按钮是纯控件：不参与拖拽/单击打开 GUI（否则 mouseup 会误触 openGui）
  const isFoldBtn = el === elFoldBtn || el === elFoldCount
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (el === elStage && !isWhaleHit(e)) return // 鲸鱼周边空白：不响应
    if (isFoldBtn) return // 折叠按钮：只响应 click，不启动拖拽
    // M6: pointer capture —— 窗外松手也能收到 mouseup，避免 down/dragging 残留
    try { el.setPointerCapture(e.pointerId) } catch { /* 非 pointer 事件 */ }
    down = true
    moved = false
    sx = e.screenX
    sy = e.screenY
    window.pet.dragStart()
  })
  el.addEventListener('pointercancel', () => {
    down = false
    moved = false
    root.classList.remove('dragging')
    window.pet.dragEnd()
  })
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (el === elStage && !isWhaleHit(e)) return
    window.pet.contextMenu()
  })
}

window.addEventListener('mousemove', (e) => {
  if (!down) return
  const dx = e.screenX - sx
  const dy = e.screenY - sy
  if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
    moved = true
    root.classList.add('dragging')
  }
  // drag movement handled by main-process drag-poll (no IPC needed)
})

window.addEventListener('mouseup', (e) => {
  if (down && !moved) {
    window.pet.openGui() // 单击鲸鱼/气泡 → 打开 DSH GUI
  }
  down = false
  moved = false
  root.classList.remove('dragging')
  window.pet.dragEnd()
  // re-evaluate now that the drag is over: the pointer is still over the pet,
  // so report clickable=true immediately (no need to wait for the next move)
  updateClickable(e)
})

// 初始报告交互区(主进程光标轮询用)
reportHitAreas()
