import { PDFDocument } from 'pdf-lib'
import { sheet, type PaperKey } from './layout'
import type { Page } from './doc.svelte'

export async function buildPdf(pages: Page[], paper: PaperKey): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const p of pages) {
    const { w, h } = sheet(p.landscape, paper)
    const page = doc.addPage([w, h])
    for (const it of p.items) {
      const bytes = new Uint8Array(await it.blob.arrayBuffer())
      const img = it.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
      // 预览用 CSS 记的是「距页面左上角」，PDF 原点在左下角，所以 y 要翻过来
      page.drawImage(img, { x: it.x, y: h - it.y - it.h, width: it.w, height: it.h })
    }
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
