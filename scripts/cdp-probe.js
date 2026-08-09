'use strict'
/* CDP 探测：验证同一状态下轮询不再触发气泡 pop 动画 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const pages = await (await fetch('http://127.0.0.1:9222/json')).json()
  const page = pages.find((p) => p.url.includes('index.html'))
  if (!page) throw new Error('no pet page found')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })

  let id = 0
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const msgId = ++id
      const handler = (ev) => {
        const data = JSON.parse(ev.data)
        if (data.id === msgId) {
          ws.removeEventListener('message', handler)
          resolve(data.result?.result?.value)
        }
      }
      ws.addEventListener('message', handler)
      ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    })

  const EXPR = `(() => {
    const b = document.getElementById('bubble')
    const running = b.getAnimations().filter(a => a.playState === 'running').length
    return { running, cls: b.className, mode: document.getElementById('root').dataset.mode }
  })()`

  let sawRunning = 0
  let samples = 0
  let last = null
  for (let i = 0; i < 30; i++) {
    const r = await evaluate(EXPR)
    samples++
    if (r?.running > 0) sawRunning++
    last = r
    await delay(400)
  }

  console.log(`采样 ${samples} 次, 观测到运行中动画 ${sawRunning} 次, 最后状态: ${JSON.stringify(last)}`)
  console.log(sawRunning === 0 ? 'PASS: 同一状态下气泡动画静止' : 'FAIL: 仍有闪动')
  ws.close()
  process.exit(sawRunning === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
