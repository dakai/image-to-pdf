import { MARGIN, fit, sheet, type PaperKey, type Size } from './layout'

/** 画布上的一张图。x/y/w/h 是相对页面左上角的 pt 坐标，pdf 导出直接用。 */
export type Item = {
 id: string
 src: string
 blob: Blob
 type: 'image/png' | 'image/jpeg'
 /** 图片自身像素尺寸，只用来定初始摆放和锁比例 */
 nw: number
 nh: number
 x: number
 y: number
 w: number
 h: number
}

export type Page = {
 id: string
 landscape: boolean
 items: Item[]
}

const MAX_EDGE = 2480

// Chromium 源码里就没有 HEIC/HEIF 解码器（只有 avif/bmp/gif/ico/jpeg/jxl/png/webp），
// Firefox 的 HEIC 支持请求至今 NEW。Safari 要 17.0+ 才解得动。这些格式的失败必须说人话。
const NO_DECODER: Record<string, string> = {
 'image/heic':
  '是 iPhone 常见的 HEIC 格式，当前浏览器解不了；用 iPhone 的 Safari 打开本应用，或先在「照片」里导出为 JPG',
 'image/heif': '是 HEIF 格式，当前浏览器解不了；建议先转成 JPG',
 'image/x-adobe-dng':
  '是 ProRAW(DNG) 格式，浏览器解不了；请在「照片」App 里转成 JPG 或 HEIC 再上传'
}

// crypto.randomUUID() 只在 secure context 存在，局域网 http://192.168.x.x 下是
// undefined。页面数据本来就活在内存里，自增序号足够唯一。
let seq = 0
const newId = () => `p${seq++}`

class Doc {
 pages = $state<Page[]>([])
 paper = $state<PaperKey>('a4')
 /** 新图片排到最后一页，还是每张各占一页 */
 stackOnLast = $state(false)

 get count() {
  return this.pages.length
 }

 sizeOf(page: Page): Size {
  return sheet(page.landscape, this.paper)
 }

 async add(files: File[]) {
  const failed: string[] = []
  for (const file of files) {
   if (!file.type.startsWith('image/')) continue
   try {
    const item = await prepare(file);
    const last = this.stackOnLast ? this.pages.at(-1) : undefined;
    const page: Page = last ?? { id: newId(), landscape: false, items: [] };
    if (!last) {
     this.pages.push(page);
     // 只给本次新建的页自动选方向；用户手动设过的空白页别覆盖
     page.landscape = item.nw > item.nh;
    }
    page.items.push(this.place(item, page));
   } catch (e) {
    const why =
     NO_DECODER[file.type] ??
     `读取失败：${e instanceof Error ? e.message : e}`
    failed.push(`${file.name}（${file.type || '未知类型'}）${why}`)
   }
  }
  // 一批里混进一张 HEIC 就整批失败太挫败：能加的都先加上，最后再把坏的报出来
  if (failed.length) throw new Error(failed.join('；'))
 }

 /** 把文件丢到某张已有页上 */
 async addTo(pageId: string, files: FileList | File[]) {
  const page = this.pages.find((p) => p.id === pageId)
  if (!page) return
  const failed: string[] = []
  for (const file of files) {
   if (!file.type.startsWith('image/')) continue
   try {
    const item = await prepare(file)
    page.items.push(this.place(item, page))
   } catch (e) {
    const why =
     NO_DECODER[file.type] ??
     `读取失败：${e instanceof Error ? e.message : e}`
    failed.push(`${file.name}（${file.type || '未知类型'}）${why}`)
   }
  }
  if (failed.length) throw new Error(failed.join('；'))
 }

 addBlank() {
  this.pages.push({ id: newId(), landscape: false, items: [] })
 }

 removePage(id: string) {
  const i = this.pages.findIndex((p) => p.id === id)
  if (i < 0) return
  for (const it of this.pages[i].items) URL.revokeObjectURL(it.src)
  this.pages.splice(i, 1)
 }

 movePage(from: number, to: number) {
  to = Math.max(0, Math.min(this.pages.length - 1, to))
  if (from === to) return
  this.pages.splice(to, 0, ...this.pages.splice(from, 1))
 }

 /** 单页换方向 */
 setLandscape(pageId: string, landscape: boolean) {
  const page = this.pages.find((p) => p.id === pageId)
  if (!page || page.landscape === landscape) return
  page.landscape = landscape
  this.reflow(page)
 }

 removeItem(pageId: string, itemId: string) {
  const page = this.pages.find((p) => p.id === pageId)
  if (!page) return
  const i = page.items.findIndex((it) => it.id === itemId)
  if (i < 0) return
  URL.revokeObjectURL(page.items[i].src)
  page.items.splice(i, 1)
 }

 bringToFront(pageId: string, itemId: string) {
  const page = this.pages.find((p) => p.id === pageId)
  if (!page) return
  const i = page.items.findIndex((it) => it.id === itemId)
  if (i < 0 || i === page.items.length - 1) return
  page.items.push(...page.items.splice(i, 1))
 }

 /** 换纸型后把放不下的图等比缩到装得下，位置夹回页面内。 */
 setPaper(paper: PaperKey) {
  if (paper === this.paper) return
  this.paper = paper
  for (const page of this.pages) this.reflow(page)
 }

 clear() {
  for (const p of this.pages) for (const it of p.items) URL.revokeObjectURL(it.src)
  this.pages = []
 }

 private place(core: Omit<Item, 'x' | 'y' | 'w' | 'h'>, page: Page): Item {
  const { w: pw, h: ph } = this.sizeOf(page)
  const r = fit({ w: pw - 2 * MARGIN, h: ph - 2 * MARGIN }, { w: core.nw, h: core.nh })
  return { ...core, w: r.w, h: r.h, x: r.x + MARGIN, y: r.y + MARGIN }
 }
 /**
  * 页面尺寸变了之后收拾一下：图的 pt 尺寸保持不变（换个纸不该让图凭空变小），
  * 只有真的超出新页面才等比缩到装得下，位置夹回页面内。
  * 不用「按比例整体缩放」——那样横竖来回切几次图就缩没了。
  */
 private reflow(page: Page) {
  const { w: pw, h: ph } = this.sizeOf(page)
  for (const it of page.items) {
   const s = Math.min(1, pw / it.w, ph / it.h)
   it.w *= s
   it.h *= s
   it.x = Math.max(0, Math.min(it.x, pw - it.w))
   it.y = Math.max(0, Math.min(it.y, ph - it.h))
  }
 }
}

async function prepare(file: File): Promise<Omit<Item, 'x' | 'y' | 'w' | 'h'>> {
 const url = URL.createObjectURL(file)
 try {
  const img = new Image()
  img.src = url
  await img.decode()
  const { naturalWidth: nw, naturalHeight: nh } = img
  if (!nw || !nh) throw new Error('无法读取图片尺寸')

  // 所有图统一过一遍 canvas，两件事一起做完：
  //   ① 长边压到 2480px (~A4 300dpi)，别让手机原图把内存和 PDF 撑爆
  //   ② 把 EXIF orientation 烙进像素。浏览器渲染 <img> 和 canvas.drawImage 都会
  //      按 EXIF 旋转，pdf-lib 不会 —— 不烙的话 iPhone 竖拍照片预览是正的、
  //      导出的 PDF 里是躺着的。走 canvas 之后下游就完全不依赖 EXIF 了。
  // 有透明通道的必须留在 png，否则 jpeg 会把背景涂黑。
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  const scale = Math.min(1, MAX_EDGE / Math.max(nw, nh))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(nw * scale)
  canvas.height = Math.round(nh * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 canvas')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.92))
  if (!blob) throw new Error('图片转换失败')
  URL.revokeObjectURL(url)
  return { id: newId(), src: URL.createObjectURL(blob), blob, nw: canvas.width, nh: canvas.height, type }
 } catch (e) {
  URL.revokeObjectURL(url)
  throw e
 }
}

export const doc = new Doc()
