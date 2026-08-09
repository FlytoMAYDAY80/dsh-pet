'use strict'

/* ============ 像素版鲸鱼渲染 ============
 * 素材：app/pixel-sprites.js（PIXEL_SPRITES，40x29 网格，6 状态）
 * 由 Codex 从 reference whale.png 直接像素化生成
 */

const PIXEL = (() => {
  const W = 80
  const H = 58
  const PALETTE = PIXEL_SPRITES.palette

  // 定位喷水柱（working/done 的 R 像素区域），用于水滴动画
  function findSpout(sprite) {
    let x0 = 99, x1 = -1, y0 = 99
    for (let y = 0; y < H; y++) {
      const row = sprite[y]
      for (let x = 0; x < W; x++) {
        if (row[x] === 'R') {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
        }
      }
    }
    return x1 === -1 ? null : { x0, x1, y0 }
  }

  /**
   * 把状态网格画到 canvas。
   * @param ctx 2d 上下文（canvas 物理尺寸 = W*scale x H*scale）
   * @param mode 状态（working/attention/done/idle/offline/...）
   * @param time 动画时间戳（ms），用于喷水水滴
   * @param scale 每格像素数
   */
  function draw(ctx, mode, time, scale) {
    const sprite = PIXEL_SPRITES.sprites[mode] || PIXEL_SPRITES.sprites.default
    ctx.clearRect(0, 0, W * scale, H * scale)
    for (let y = 0; y < H; y++) {
      const row = sprite[y]
      for (let x = 0; x < W; x++) {
        const ch = row[x]
        if (ch === '.' || !PALETTE[ch]) continue
        ctx.fillStyle = PALETTE[ch]
        ctx.fillRect(x * scale, y * scale, scale, scale)
      }
    }
    // 喷水水滴动画（working / done）：从喷水柱顶端落下
    if (mode === 'working' || mode === 'done') {
      const sp = findSpout(sprite)
      if (sp) {
        const cx = Math.round((sp.x0 + sp.x1) / 2)
        ctx.fillStyle = PALETTE.R
        for (let i = 0; i < 3; i++) {
          const phase = (((time / 450 + i / 3) % 1) + 1) % 1
          const y = sp.y0 - 1 + Math.floor(phase * 7) // 从喷水顶端上落
          ctx.fillRect((cx - 1 + i) * scale, Math.max(0, y) * scale, scale, scale)
        }
      }
    }
  }

  return { PALETTE, W, H, draw }
})()
