'use strict'
// 程序化生成托盘图标 PNG dataURL（nativeImage 对 SVG dataURL 在 Windows 上不可靠）
const zlib = require('zlib')

const crcTable = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function makeTrayPngDataUrl() {
  const S = 32
  const px = new Uint8Array(S * S * 4)
  const inWhale = (x, y) => {
    const dx = (x - 16) / 14
    const dy = (y - 16.5) / 11
    if (dx * dx + dy * dy <= 1) return true
    if (x >= 25 && y >= 8 && y <= 24) return true // 尾巴
    return false
  }
  const inEye = (x, y) => {
    const dx = x - 9
    const dy = y - 12
    return dx * dx + dy * dy <= 1.6
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4
      if (inWhale(x, y)) { px[i] = 46; px[i + 1] = 74; px[i + 2] = 232; px[i + 3] = 255 }
      else if (inEye(x, y)) { px[i + 3] = 255 }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(S, 0)
  ihdr.writeUInt32BE(S, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(S * (S * 4 + 1))
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0
    Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1)
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return 'data:image/png;base64,' + png.toString('base64')
}

module.exports = { makeTrayPngDataUrl }
