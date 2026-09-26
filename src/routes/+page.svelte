<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { doc, type Item, type Page } from "$lib/doc.svelte";
  import { MIN_SIZE, PAPERS, sheet, type PaperKey } from "$lib/layout";
  import { download } from "$lib/pdf";

  let vp: HTMLElement;
  let inner = $state<HTMLDivElement>();
  let z = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let picker = $state<HTMLInputElement>();
  let busy = $state(false);
  let error = $state("");
  let selected = $state<string | null>(null);
  let dragging = $state<string | null>(null);
  let overPage = $state<string | null>(null);

  // 画布缩到 40% 时，12pt 的角只剩 5 个屏幕像素，手指按不到 —— 手柄按 1/z 反向放大
  const hs = $derived(Math.max(11, 26 / z));

  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; z: number; mx: number; my: number } | null = null;

  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

  const CORNERS = [
    { c: "nw", sx: -1, sy: -1 },
    { c: "ne", sx: 1, sy: -1 },
    { c: "sw", sx: -1, sy: 1 },
    { c: "se", sx: 1, sy: 1 },
  ] as const;

  function zoomAt(cx: number, cy: number, next: number) {
    next = clamp(next, 0.05, 8);
    const k = next / z;
    tx = cx - (cx - tx) * k;
    ty = cy - (cy - ty) * k;
    z = next;
  }

  function fit() {
    const cw = inner?.offsetWidth ?? 0;
    const ch = inner?.offsetHeight ?? 0;
    if (!cw || !ch) return;
    z = clamp(
      Math.min(vp.clientWidth / cw, vp.clientHeight / ch) * 0.92,
      0.05,
      8,
    );
    tx = (vp.clientWidth - cw * z) / 2;
    ty = (vp.clientHeight - ch * z) / 2;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    zoomAt(
      e.clientX - r.left,
      e.clientY - r.top,
      z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)),
    );
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    selected = null;
    // 指针已被释放时 setPointerCapture 会抛，抛了整段拖动就接不上，不能让它中断
    try { vp.setPointerCapture(e.pointerId) } catch (err) { /* 指针已释放，忽略 */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pointers.values()];
    if (pointers.size >= 2) {
      pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y),
        z,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
    }
  }

  function onMove(e: PointerEvent) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const prev = { x: p.x, y: p.y };
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 0 && pinch.d > 0) {
        const r = vp.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - r.left;
        const my = (a.y + b.y) / 2 - r.top;
        zoomAt(mx, my, (pinch.z * d) / pinch.d);
        tx += mx - pinch.mx + r.left;
        ty += my - pinch.my + r.top;
        pinch = { d, z, mx: mx + r.left, my: my + r.top };
      }
    } else {
      tx += e.clientX - prev.x;
      ty += e.clientY - prev.y;
    }
  }

  function onUp(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  }

  /** 拖动/缩放图片。屏幕像素要先除以当前缩放 z 才能还原成页面上的 pt。 */
  function grab(
    e: PointerEvent,
    page: Page,
    it: Item,
    corner?: (typeof CORNERS)[number],
  ) {
    e.stopPropagation();
    selected = it.id;
    // 一次拖拽/缩放算一步撤销，别按 pointermove 次数记
    doc.snapshot();
    // 用户一摆就脱离自动排布，之后再加图不会把ta挪走
    it.auto = false;
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId) } catch (err) { /* 指针已释放，忽略 */ }
    const rect = (el.closest(".sheet") as HTMLElement).getBoundingClientRect();
    const { w: pw, h: ph } = doc.sizeOf(page);
    const s0 = { x: it.x, y: it.y, w: it.w, h: it.h };
    const c0 = { x: e.clientX, y: e.clientY };
    const ar = s0.w / s0.h;
    const sx = corner?.sx ?? 0;
    const sy = corner?.sy ?? 0;

    const move = (ev: PointerEvent) => {
      if (!corner) {
        it.x = clamp(s0.x + (ev.clientX - c0.x) / z, 0, Math.max(0, pw - s0.w));
        it.y = clamp(s0.y + (ev.clientY - c0.y) / z, 0, Math.max(0, ph - s0.h));
        return;
      }
      // 对角固定不动，只改拖动的那个角；始终锁纵横比
      const ax = sx < 0 ? s0.x + s0.w : s0.x;
      const ay = sy < 0 ? s0.y + s0.h : s0.y;
      let w2 = Math.max(MIN_SIZE, Math.abs((ev.clientX - rect.left) / z - ax));
      let h2 = Math.max(MIN_SIZE, Math.abs((ev.clientY - rect.top) / z - ay));
      if (w2 / h2 > ar) w2 = h2 * ar;
      else h2 = w2 / ar;
      if (w2 > pw) (w2 = pw), (h2 = w2 / ar);
      if (h2 > ph) (h2 = ph), (w2 = h2 / ar);
      it.w = w2;
      it.h = h2;
      it.x = sx < 0 ? ax - w2 : ax;
      it.y = sy < 0 ? ay - h2 : ay;
    };
    // 移动时高亮手指下的画布；松手落在别的画布上就把图搬过去
    const track = (ev: PointerEvent) => {
      const sheet = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest(".sheet") as HTMLElement | null;
      const id = sheet?.dataset.page ?? null;
      overPage = !corner && id && id !== page.id ? id : null;
    };
    const stop = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointermove", track);
      el.removeEventListener("pointerup", stop);
      el.removeEventListener("pointercancel", stop);
      const to = overPage;
      overPage = null;
      if (to && !corner) doc.moveItemToPage(page.id, it.id, to);
      else if (!corner && ev.type === "pointercancel") doc.undo();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
    el.addEventListener("pointermove", track);
  }

  async function load(files: FileList | File[] | null, pageId?: string) {
    if (!files || !files.length) return;
    busy = true;
    error = "";
    try {
      if (pageId) await doc.addTo(pageId, Array.from(files));
      else await doc.add(Array.from(files));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      // 部分失败时前面的图已经加进来了，缩放也要跟上
      if (doc.count) fit();
      busy = false;
    }
  }

  async function onExport() {
    if (!doc.hasItems) return;
    busy = true;
    error = "";
    try {
      await download(doc.pages, doc.paper);
    } catch (e) {
      error = `导出失败：${e instanceof Error ? e.message : e}`;
    } finally {
      busy = false;
    }
  }

  function onDrop(e: DragEvent, pageId?: string) {
    e.preventDefault();
    e.stopPropagation();
    if (dragging) {
      dragging = null;
      return;
    }
    load(e.dataTransfer?.files ?? null, pageId);
  }

  function onPageDragOver(e: DragEvent, i: number) {
    e.preventDefault();
    if (!dragging) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    doc.movePage(i, e.clientY - r.top < r.height / 2 ? i : i + 1);
  }

  function onKey(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
    e.preventDefault();
    if (e.shiftKey) doc.redo();
    else doc.undo();
  }

  onMount(fit);
  onDestroy(() => doc.clear());
</script>

<svelte:window onkeydown={onKey} />

<header>
  <strong>图片 → PDF</strong>
  <span class="count">{doc.count} 页</span>
  <select
    value={doc.paper}
    onchange={(e) => doc.setPaper(e.currentTarget.value as PaperKey)}
    aria-label="纸张尺寸"
  >
    {#each Object.entries(PAPERS) as [key, p] (key)}
      <option value={key}>{p.label}</option>
    {/each}
  </select>
  <select
    bind:value={doc.stackOnLast}
    aria-label="新图片放在哪"
    title="新图片是排到最后一页，还是每张各占一页"
  >
    <option value={false}>每张一页</option>
    <option value={true}>排到同一页</option>
  </select>
  <button
    title="撤销 (Ctrl+Z)"
    disabled={!doc.canUndo}
    onclick={() => doc.undo()}>↶</button
  >
  <button
    title="重做 (Ctrl+Shift+Z)"
    disabled={!doc.canRedo}
    onclick={() => doc.redo()}>↷</button
  >
  <button onclick={() => picker?.click()}>＋ 图片</button>
  <button onclick={() => doc.addBlank()}>＋ 空白页</button>
  {#if doc.count}
    <button class="danger" onclick={() => doc.clear()}>清空</button>
  {/if}
  <button class="primary" onclick={onExport} disabled={busy || !doc.hasItems}>
    导出 PDF
  </button>
</header>

{#if error}
  <p class="error">{error}</p>
{/if}

<main
  bind:this={vp}
  onwheel={onWheel}
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={onUp}
  onpointercancel={onUp}
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => onDrop(e)}
>
  {#if doc.count}
    <div
      class="inner"
      bind:this={inner}
      style="transform:translate({tx}px,{ty}px) scale({z})"
    >
      {#each doc.pages as p, i (p.id)}
        {@const box = doc.sizeOf(p)}
        <div
          class="page"
          class:drag={dragging === p.id}
          role="listitem"
          aria-label="第 {i + 1} 页"
          ondragover={(e) => onPageDragOver(e, i)}
        >
          <div class="bar">
            <span class="tag">第 {i + 1} 页</span>
            <button
              title="上移"
              disabled={i === 0}
              onclick={() => doc.movePage(i, i - 1)}>↑</button
            >
            <button
              title="下移"
              disabled={i === doc.count - 1}
              onclick={() => doc.movePage(i, i + 1)}>↓</button
            >
            <button
              title={p.landscape ? "改成纵向" : "改成横向"}
              onclick={() => doc.setLandscape(p.id, !p.landscape)}
            >
              {p.landscape ? "竖" : "横"}
            </button>
            <button title="删除这一页" onclick={() => doc.removePage(p.id)}
              >✕</button
            >
          </div>
          <div
            class="sheet"
            class:drop={overPage === p.id}
            data-page={p.id}
            role="group"
            aria-label="第 {i + 1} 页画布"
            style="width:{box.w}px;height:{box.h}px"
            ondragover={(e) => e.preventDefault()}
            ondrop={(e) => onDrop(e, p.id)}
          >
            {#each p.items as it (it.id)}
              <div
                class="item"
                class:sel={selected === it.id}
                style="left:{it.x}px;top:{it.y}px;width:{it.w}px;height:{it.h}px"
                role="group"
                onpointerdown={(e) => grab(e, p, it)}
              >
                <img src={it.src} alt="" draggable="false" />
                {#if selected === it.id}
                  {#each CORNERS as k (k.c)}
                    <span
                      class="h {k.c}"
                      style="width:{hs}px;height:{hs}px;--o:{-hs / 2}px"
                      role="button"
                      tabindex="-1"
                      aria-label="调整图片大小"
                      onpointerdown={(e) => grab(e, p, it, k)}
                    ></span>
                  {/each}
                  <div class="itools">
                    <button
                      title="置于顶层"
                      onclick={() => doc.bringToFront(p.id, it.id)}>置顶</button
                    >
                    <button
                      title="删除这张"
                      onclick={() => doc.removeItem(p.id, it.id)}>✕</button
                    >
                  </div>
                {/if}
              </div>
            {/each}
            {#if !p.items.length}
              <div class="hint">空画布 · 点上方「＋图片」，或把图片拖到这里</div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</main>

<div class="zoom">
  <button
    onclick={() => zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, z / 1.25)}
    >−</button
  >
  <button onclick={fit} title="适应窗口">{Math.round(z * 100)}%</button>
  <button
    onclick={() => zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, z * 1.25)}
    >＋</button
  >
</div>

<input
  bind:this={picker}
  type="file"
  accept="image/*,image/jpeg"
  multiple
  hidden
  onchange={(e) => {
    const t = e.currentTarget;
    load(t.files);
    t.value = "";
  }}
/>

<style>
  :global(body) {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 10px 12px;
    padding-top: max(10px, env(safe-area-inset-top));
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }

  header strong {
    margin-right: auto;
  }

  /* 窄屏：控件本来就多，再松散就要占掉三行 */
  @media (max-width: 520px) {
    header {
      gap: 4px;
      padding: 8px;
      padding-top: max(8px, env(safe-area-inset-top));
    }
    header button,
    header select {
      padding: 6px 8px;
      font-size: 13px;
    }
    header strong {
      font-size: 14px;
    }
  }

  .count {
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }

  button.danger {
    color: #ff8080;
  }

  .error {
    margin: 0;
    padding: 8px 12px;
    background: #3b1d1d;
    color: #ffb4b4;
    font-size: 13px;
  }

  main {
    position: relative;
    flex: 1;
    overflow: hidden;
    touch-action: none;
    cursor: grab;
  }

  main:active {
    cursor: grabbing;
  }

  .inner {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    width: max-content;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 24px;
  }

  .page {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .page.drag .sheet {
    opacity: 0.5;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .bar .tag {
    margin-right: auto;
    color: var(--dim);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .bar button {
    padding: 2px 9px;
    font-size: 13px;
  }

  .sheet {
    position: relative;
    flex: none;
    background: #fff;
    box-shadow: 0 6px 24px #0008;
    overflow: hidden;
  }

  .sheet.drop {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }

  .sheet img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    pointer-events: none;
  }

  .hint {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #ccc;
    font-size: 17px;
    pointer-events: none;
  }

  .item {
    position: absolute;
    cursor: move;
    touch-action: none;
  }

  .item img {
    width: 100%;
    height: 100%;
  }

  .item.sel {
    outline: 1.5px solid var(--accent);
    outline-offset: 0;
  }

  .h {
    position: absolute;
    background: #fff;
    border: 2px solid var(--accent);
    border-radius: 2px;
  }

  .h.nw {
    left: var(--o);
    top: var(--o);
    cursor: nwse-resize;
  }
  .h.ne {
    right: var(--o);
    top: var(--o);
    cursor: nesw-resize;
  }
  .h.sw {
    left: var(--o);
    bottom: var(--o);
    cursor: nesw-resize;
  }
  .h.se {
    right: var(--o);
    bottom: var(--o);
    cursor: nwse-resize;
  }

  /* 放在图内右上角：放图外会被 .sheet 的 overflow:hidden 裁掉 */
  .itools {
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    gap: 4px;
  }

  .itools button {
    padding: 3px 9px;
    font-size: 12px;
    background: #000c;
    border-color: #fff4;
  }

  .zoom {
    position: fixed;
    right: 12px;
    bottom: max(12px, env(safe-area-inset-bottom));
    display: flex;
    gap: 4px;
  }

  .zoom button {
    min-width: 44px;
    background: #000a;
    backdrop-filter: blur(6px);
  }
</style>
