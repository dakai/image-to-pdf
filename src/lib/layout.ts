// 页面几何的唯一真相：预览(div 绝对定位)与导出(pdf-lib)都走这里的规则。
// 单位统一用 pt(1/72 inch)，CSS 里 1px 当 1pt 用，缩放交给外层 transform。

export const PAPERS = {
  a4: { label: 'A4', w: 595.28, h: 841.89 },
  letter: { label: 'Letter', w: 612, h: 792 }
} as const

export type PaperKey = keyof typeof PAPERS

export type Size = { w: number; h: number }

/** 新放进画布的图片与页面边缘留的空白 */
export const MARGIN = 28

/** 缩到比这更小就拖不动了 */
export const MIN_SIZE = 20

/** 页面尺寸，横竖由每页自己定（换向时按等比重排，见 Doc#rescale）。 */
export function sheet(landscape: boolean, paper: PaperKey): Size {
  const p = PAPERS[paper]
  return landscape ? { w: p.h, h: p.w } : { w: p.w, h: p.h }
}

/** 图片等比缩放后在页面里居中 —— 新放入图片的默认摆放。 */
export function fit(box: Size, img: Size): { x: number; y: number; w: number; h: number } {
  const s = Math.min(box.w / img.w, box.h / img.h)
  const w = img.w * s
  const h = img.h * s
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h }
}
