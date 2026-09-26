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

// Chromium 源码里就没有 HEIC/HEIF 解码器（只有 avif/bmp/gif/ico/jpeg/jxl/png/webp），
// Firefox 的 HEIC 支持请求至今 NEW。Safari 要 17.0+ 才解得动。这些格式的失败必须说人话。
const NO_DECODER: Record<string, string> = {
  "image/heic":
    "是 iPhone 常见的 HEIC 格式，当前浏览器解不了；用 iPhone 的 Safari 打开本应用，或先在「照片」里导出为 JPG",
  "image/heif": "是 HEIF 格式，当前浏览器解不了；建议先转成 JPG",
  "image/x-adobe-dng":
    "是 ProRAW(DNG) 格式，浏览器解不了；请在「照片」App 里转成 JPG 或 HEIC 再上传",
}

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
    const failed: string[] = []
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue
      try {
        this.pages.push(await prepare(file))
      } catch (e) {
        failed.push(
          `${file.name}（${file.type || "未知类型"}）${NO_DECODER[file.type] ??
          `读取失败：${e instanceof Error ? e.message : e}`
          }`
        )
      }
    }
    // 一批里混进一张 HEIC 就整批失败太挫败：能加的都先加上，最后再把坏的报出来
    if (failed.length) throw new Error(failed.join("；"))
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

    // 所有图统一过一遍 canvas，两件事一起做完：
    //   ① 长边压到 2480px (~A4 300dpi)，别让手机原图把内存和 PDF 撑爆
    //   ② 把 EXIF orientation 烙进像素。浏览器渲染 <img> 和 canvas.drawImage 都会
    //      按 EXIF 旋转，pdf-lib 不会 —— 不烙的话 iPhone 竖拍照片预览是正的、
    //      导出的 PDF 里是躺着的。走 canvas 之后下游就完全不依赖 EXIF 了。
    // 有透明通道的必须留在 png，否则 jpeg 会把背景涂黑。
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器不支持 canvas')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.92))
    if (!blob) throw new Error('图片转换失败')
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
