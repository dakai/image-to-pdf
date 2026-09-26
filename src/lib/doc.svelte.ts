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
 /** 位置是自动排的还是用户自己摆的。整页都是自动排的，再加图就重排。 */
 auto: boolean
}

export type Page = {
 id: string
 landscape: boolean
 /** 用户手动设过方向就别再被自动横竖判断覆盖 */
 oriented: boolean
 items: Item[]
}

const MAX_EDGE = 2480
const UNDO_LIMIT = 60

/** 撤销快照。blob/src 按引用带过去（很便宜），恢复时才重建 objectURL。 */
type Snap = {
 paper: PaperKey
 pages: { id: string; landscape: boolean; oriented: boolean; items: Item[] }[]
}

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

const blank = (): Page => ({
 id: newId(),
 landscape: false,
 oriented: false,
 items: []
})

class Doc {
 // 一开始就有一张空白画布，不用先点「＋空白页」
 pages = $state<Page[]>([blank()])
 paper = $state<PaperKey>('a4')
 /** 新图片排到最后一页，还是每张各占一页 —— 默认排到同一张 */
 stackOnLast = $state(true)

 private past = $state<Snap[]>([])
 private future = $state<Snap[]>([])

 get count() {
  return this.pages.length
 }

 get hasItems() {
  return this.pages.some((p) => p.items.length > 0)
 }

 get canUndo() {
  return this.past.length > 0
 }

 get canRedo() {
  return this.future.length > 0
 }

 sizeOf(page: Page): Size {
  return sheet(page.landscape, this.paper)
 }

 /** 任何改动之前调一次；内容没变的空操作不要调，免得撤销栈里塞垃圾。 */
 snapshot() {
  this.past.push(this.snap())
  if (this.past.length > UNDO_LIMIT) this.past.shift()
  this.future = []
 }

 undo() {
  const prev = this.past.pop()
  if (!prev) return
  this.future.push(this.snap())
  this.restore(prev)
 }

 redo() {
  const next = this.future.pop()
  if (!next) return
  this.past.push(this.snap())
  this.restore(next)
 }

  async add(files: File[]) {
    const usable = files.filter((f) => f.type.startsWith("image/"));
    if (!usable.length) return;
    this.snapshot();
    const { made, failed } = await this.decode(usable);
    if (made.length) {
      let page = this.stackOnLast ? this.pages.at(-1) : undefined;
      if (!page) {
        page = blank();
        this.pages.push(page);
      }
      if (page.items.length === 0) this.autoOrient(page, made[0]);
      this.insert(page, made);
    }
    if (failed.length) throw new Error(failed.join("；"));
  }

  /** 把文件丢到某张已有页上 */
  async addTo(pageId: string, files: File[]) {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page) return;
    const usable = files.filter((f) => f.type.startsWith("image/"));
    if (!usable.length) return;
    this.snapshot();
    const { made, failed } = await this.decode(usable);
    if (made.length) {
      if (page.items.length === 0) this.autoOrient(page, made[0]);
      this.insert(page, made);
    }
    if (failed.length) throw new Error(failed.join("；"));
  }

  private async decode(files: File[]) {
    const made: Item[] = [];
    const failed: string[] = [];
    for (const file of files) {
      try {
        made.push(await prepare(file));
      } catch (e) {
        const why =
          NO_DECODER[file.type] ??
          `读取失败：${e instanceof Error ? e.message : e}`;
        failed.push(`${file.name}（${file.type || "未知类型"}）${why}`);
      }
    }
    return { made, failed };
  }

  /** 空页且用户没手动设过方向时，按第一张图的宽高自动横竖 */
  private autoOrient(page: Page, item: { nw: number; nh: number }) {
    if (!page.oriented && page.items.length === 0)
      page.landscape = item.nw > item.nh;
  }

  /**
   * 落图。空画布一次来多张就直接排成网格 —— 逐张「找空位」是不行的：
   * 第一张几乎占满全页，后面几张根本找不到不重叠的地方，只会叠在一起。
   * 往已有内容的画布上加，就从满页开始逐档缩小扫格子找空位。
   */
  private insert(page: Page, added: Item[]) {
    // 整页都是自动排的（用户没手动摆过）就重新铺网格 —— 手机上是一张张点
    // 「＋图片」的，一次只来一张，只在第一次铺网格的话后面全叠在一起。
    if (!page.items.length || page.items.every((i) => i.auto)) {
      this.grid(page, [...page.items, ...added]);
      return;
    }
    // 用户摆过了，就只给新图找空位，不动他摆好的
    for (const it of added) page.items.push(this.place(it, page));
  }

  private grid(page: Page, items: Item[]) {
    const { w: pw, h: ph } = this.sizeOf(page);
    const cols = Math.ceil(Math.sqrt(items.length));
    const rows = Math.ceil(items.length / cols);
    const cw = (pw - 2 * MARGIN) / cols;
    const ch = (ph - 2 * MARGIN) / rows;
    items.forEach((it, i) => {
      const r = fit({ w: cw, h: ch }, { w: it.nw, h: it.nh });
      it.w = r.w;
      it.h = r.h;
      it.x = MARGIN + (i % cols) * cw + (cw - r.w) / 2;
      it.y = MARGIN + Math.floor(i / cols) * ch + (ch - r.h) / 2;
      it.auto = true;
    });
    page.items = items;
  }

 addBlank() {
  this.snapshot()
  this.pages.push(blank())
 }

 removePage(id: string) {
  const i = this.pages.findIndex((p) => p.id === id)
  if (i < 0 || this.pages.length === 1) return
  this.snapshot()
  for (const it of this.pages[i].items) URL.revokeObjectURL(it.src)
  this.pages.splice(i, 1)
 }

 movePage(from: number, to: number) {
  to = Math.max(0, Math.min(this.pages.length - 1, to))
  if (from === to) return
  this.snapshot()
  this.pages.splice(to, 0, ...this.pages.splice(from, 1))
 }

 setLandscape(pageId: string, landscape: boolean) {
  const page = this.pages.find((p) => p.id === pageId)
  if (!page || page.landscape === landscape) return
  this.snapshot()
  page.landscape = landscape
  page.oriented = true
  this.reflow(page)
 }

 removeItem(pageId: string, itemId: string) {
  const page = this.pages.find((p) => p.id === pageId)
  if (!page) return
  const i = page.items.findIndex((it) => it.id === itemId)
  if (i < 0) return
  this.snapshot()
  URL.revokeObjectURL(page.items[i].src)
  page.items.splice(i, 1)
 }

 bringToFront(pageId: string, itemId: string) {
  const page = this.pages.find((p) => p.id === pageId)
  if (!page) return
  const i = page.items.findIndex((it) => it.id === itemId)
  if (i < 0 || i === page.items.length - 1) return
  this.snapshot()
  page.items.push(...page.items.splice(i, 1))
 }

 /** 把一张图拖到另一张页上：保持页内相对位置，放不下就等比缩小。 */
 moveItemToPage(fromId: string, itemId: string, toId: string) {
  const from = this.pages.find((p) => p.id === fromId)
  const to = this.pages.find((p) => p.id === toId)
  if (!from || !to || from === to) return
  const i = from.items.findIndex((it) => it.id === itemId)
  if (i < 0) return
  const it = from.items[i]
  const a = this.sizeOf(from)
  const b = this.sizeOf(to)
  const s = Math.min(1, b.w / it.w, b.h / it.h)
  it.w *= s
  it.h *= s
  it.x = Math.max(0, Math.min((it.x / a.w) * b.w, b.w - it.w))
  it.y = Math.max(0, Math.min((it.y / a.h) * b.h, b.h - it.h))
  to.items.push(...from.items.splice(i, 1))
 }

 /** 换纸型后把放不下的图等比缩到装得下，位置夹回页面内。 */
 setPaper(paper: PaperKey) {
  if (paper === this.paper) return
  this.snapshot()
  this.paper = paper
  for (const page of this.pages) this.reflow(page)
 }

 clear() {
  this.snapshot()
  for (const p of this.pages) for (const it of p.items) URL.revokeObjectURL(it.src)
  this.pages = [blank()]
 }

 private snap(): Snap {
  return {
   paper: this.paper,
   pages: this.pages.map((p) => ({
    id: p.id,
    landscape: p.landscape,
    oriented: p.oriented,
    items: p.items.map((i) => ({ ...i }))
   }))
  }
 }

 private restore(s: Snap) {
  // 被删掉的图 objectURL 已经 revoke 了，恢复时按 blob 重新生成，否则撤销回来是空白图
  for (const p of this.pages) for (const it of p.items) URL.revokeObjectURL(it.src)
  this.paper = s.paper
  this.pages = s.pages.map((p) => ({
   ...p,
   items: p.items.map((i) => ({ ...i, src: URL.createObjectURL(i.blob) }))
  }))
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

 /**
  * 新图的摆放。空页就居中铺满；页上已有图就从满页开始逐档缩小，
  * 扫网格找第一个不重叠的格子 —— 手机上没法靠拖动摆位，得自动躲开。
  */
 private place(core: Item, page: Page): Item {
  const { w: pw, h: ph } = this.sizeOf(page)
  const box = { w: pw - 2 * MARGIN, h: ph - 2 * MARGIN }
  if (!page.items.length) {
   const r = fit(box, { w: core.nw, h: core.nh })
   return { ...core, w: r.w, h: r.h, x: r.x + MARGIN, y: r.y + MARGIN }
  }

  const taken = page.items
  const free = (x: number, y: number, w: number, h: number) =>
   taken.every(
    (t) =>
     x + w <= t.x || t.x + t.w <= x || y + h <= t.y || t.y + t.h <= y
   )

  for (const k of [1, 0.72, 0.52, 0.36]) {
   const r = fit({ w: box.w * k, h: box.h * k }, { w: core.nw, h: core.nh })
   const cols = Math.max(1, Math.floor((box.w + MARGIN) / (r.w + MARGIN)))
   for (let row = 0; row * (r.h + MARGIN) + r.h <= box.h + MARGIN; row++) {
    for (let c = 0; c < cols; c++) {
     const x = MARGIN + c * (r.w + MARGIN)
     const y = MARGIN + row * (r.h + MARGIN)
     if (free(x, y, r.w, r.h))
      return { ...core, w: r.w, h: r.h, x, y }
    }
   }
  }
  // 全满了：缩到最小叠在中间，用户自己再调
  const r = fit({ w: box.w * 0.36, h: box.h * 0.36 }, { w: core.nw, h: core.nh })
  return { ...core, w: r.w, h: r.h, x: (pw - r.w) / 2, y: (ph - r.h) / 2 }
 }
}

async function prepare(file: File): Promise<Item> {
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
  return {
   id: newId(),
   src: URL.createObjectURL(blob),
   blob,
   nw: canvas.width,
   nh: canvas.height,
   type,
   // 位置由 place()/grid() 覆写，这里先占位
   x: 0,
   y: 0,
   w: canvas.width,
   h: canvas.height,
   auto: false
  }
 } catch (e) {
  URL.revokeObjectURL(url)
  throw e
 }
}

export const doc = new Doc()
