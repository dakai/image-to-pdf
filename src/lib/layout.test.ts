import { expect, test } from 'bun:test'
import { PAPERS, fit, sheet } from './layout'

test('横图自动横排，竖图竖排', () => {
  expect(sheet(false, 'a4')).toEqual({ w: PAPERS.a4.w, h: PAPERS.a4.h })
  expect(sheet(true, 'a4')).toEqual({ w: PAPERS.a4.h, h: PAPERS.a4.w })
  expect(sheet(true, 'letter').w).toBe(PAPERS.letter.h)
})

test('小图放大到页面但保持纵横比', () => {
  const r = fit({ w: 100, h: 200 }, { w: 50, h: 50 })
  expect(r.w).toBe(100)
  expect(r.h).toBe(100)
  expect(r.x).toBe(0)
  expect(r.y).toBe(50)
})

test('宽图贴边，纵横比不变', () => {
  const box = { w: 100, h: 200 }
  const r = fit(box, { w: 4000, h: 1000 })
  expect(r.w).toBe(100)
  expect(r.h).toBe(25)
  expect(r.y).toBe(87.5)
  expect(r.w / r.h).toBe(4)
})
