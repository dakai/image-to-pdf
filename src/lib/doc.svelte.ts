import type { PaperKey } from './layout'

export type Page = {
  id: string
  /** objectURL；空白页为 null。图片只活在内存里，刷新即消失。 */
  src: string | null
  blob: Blob | null
  /** 图片原始像素尺寸，空白页为 0 */
  w: number
  h: number
  /** 已归一化的 MIME，pdf-lib 只认 png / jpeg */
  type: 'image/png' | 'image/jpeg'
}

// 长边超过 2480px (~A4 300dpi) 就先缩，避免手机原图把内存和 PDF 撑爆。
const MAX_EDGE = 2480

// crypto.randomUUID() 只在 secure context 存在，局域网 http://192.168.x.x 下是
// undefined。页面数据本来就活在内存里，自增序号足够唯一。
let seq = 0
const newId = () => `p${seq++}`

class Doc {
  pages = $state<Page[]>([])
  paper = $state<PaperKey>('a4')

  get count() {
    return this.pages.length
  }

  async add(files: File[]) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      this.pages.push(await prepare(file))
    }
  }

  addBlank() {
    this.pages.push({
      id: newId(),
      src: null,
      blob: null,
      w: 0,
      h: 0,
      type: 'image/png'
    })
  }

  remove(id: string) {
    const i = this.pages.findIndex((p) => p.id === id)
    if (i < 0) return
    const [p] = this.pages.splice(i, 1)
    if (p.src) URL.revokeObjectURL(p.src)
  }

  /** to 允许等于 length（拖到最后一页下半部分 = 排到末尾），所以夹取而不是拒绝 */
  move(from: number, to: number) {
    to = Math.max(0, Math.min(this.pages.length - 1, to))
    if (from === to) return
    this.pages.splice(to, 0, ...this.pages.splice(from, 1))
  }

  clear() {
    for (const p of this.pages) if (p.src) URL.revokeObjectURL(p.src)
    this.pages = []
  }
}

async function prepare(file: File): Promise<Page> {
  const src = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = src
    await img.decode()
    const { naturalWidth: w, naturalHeight: h } = img
    if (!w || !h) throw new Error('无法读取图片尺寸')

    const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
    if (scale === 1) {
      return {
        id: newId(),
        src,
        blob: file,
        w,
        h,
        type: file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
      }
    }

    // 缩图：有透明通道的必须留在 png，否则 jpeg 会把背景涂黑。
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.92))
    if (!blob) throw new Error('图片缩放失败')
    URL.revokeObjectURL(src)
    const out = URL.createObjectURL(blob)
    return {
      id: newId(),
      src: out,
      blob,
      w: canvas.width,
      h: canvas.height,
      type
    }
  } catch (e) {
    URL.revokeObjectURL(src)
    throw e
  }
}

export const doc = new Doc()
