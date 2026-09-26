import { PDFDocument } from 'pdf-lib'
import { fit, sheet, type PaperKey } from './layout'
import type { Page } from './doc.svelte'

export async function buildPdf(pages: Page[], paper: PaperKey): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const p of pages) {
    const box = sheet(p.w > p.h, paper)
    const page = doc.addPage([box.w, box.h])
    if (!p.blob) continue
    const bytes = new Uint8Array(await p.blob.arrayBuffer())
    const img =
      p.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
    const r = fit(box, { w: img.width, h: img.height })
    // pdf 原点在左下角，y 相对页面底边
    page.drawImage(img, { x: r.x, y: box.h - r.y - r.h, width: r.w, height: r.h })
  }
  return doc.save()
}

export async function download(pages: Page[], paper: PaperKey) {
  const bytes = await buildPdf(pages, paper)
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `image-${new Date().toISOString().slice(0, 10)}.pdf`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
