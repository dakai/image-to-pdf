<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { doc } from "$lib/doc.svelte";
  import { PAPERS, sheet, type PaperKey } from "$lib/layout";
  import { download } from "$lib/pdf";

  let vp: HTMLElement;
  let inner = $state<HTMLDivElement>();
  let z = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let picker = $state<HTMLInputElement>();
  let busy = $state(false);
  let error = $state("");
  let dragging = $state<string | null>(null);

  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; z: number; mx: number; my: number } | null = null;

  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

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
    vp.setPointerCapture(e.pointerId);
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

  async function load(files: FileList | File[] | null) {
    if (!files || !files.length) return;
    busy = true;
    error = "";
    try {
      await doc.add([...files]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      // 部分失败时前面的图已经加进来了，缩放也要跟上
      if (doc.count) fit();
      busy = false;
    }
  }

  async function onExport() {
    if (!doc.count) return;
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

  function onDrop(e: DragEvent) {
    e.preventDefault();
    if (dragging) {
      dragging = null;
      return;
    }
    load(e.dataTransfer?.files ?? null);
  }

  function onDragOver(e: DragEvent, i: number) {
    e.preventDefault();
    if (!dragging) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const to = e.clientY - r.top < r.height / 2 ? i : i + 1;
    doc.move(
      doc.pages.findIndex((p) => p.id === dragging!),
      to,
    );
  }

  onMount(fit);
  onDestroy(() => doc.clear());
</script>

<header>
  <strong>图片 → PDF</strong>
  <span class="count">{doc.count} 页</span>
  <select bind:value={doc.paper} aria-label="纸张尺寸">
    {#each Object.entries(PAPERS) as [key, p] (key)}
      <option value={key}>{p.label}</option>
    {/each}
  </select>
  <button onclick={() => picker?.click()}>＋ 图片</button>
  <button onclick={() => doc.addBlank()}>＋ 空白页</button>
  {#if doc.count}
    <button class="danger" onclick={() => doc.clear()}>清空</button>
  {/if}
  <button class="primary" onclick={onExport} disabled={busy || !doc.count}
    >导出 PDF</button
  >
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
  ondrop={onDrop}
>
  {#if doc.count}
    <div
      class="inner"
      bind:this={inner}
      style="transform:translate({tx}px,{ty}px) scale({z})"
    >
      {#each doc.pages as p, i (p.id)}
        {@const box = sheet(p.w > p.h, doc.paper)}
        <div
          class="sheet"
          class:drag={dragging === p.id}
          style="width:{box.w}px;height:{box.h}px"
          draggable="true"
          role="listitem"
          aria-label="第 {i + 1} 页"
          ondragstart={(e) => {
            dragging = p.id;
            e.dataTransfer?.setData("text/plain", p.id);
            e.dataTransfer!.effectAllowed = "move";
          }}
          ondragend={() => (dragging = null)}
          ondragover={(e) => onDragOver(e, i)}
        >
          {#if p.src}
            <img src={p.src} alt="" draggable="false" />
          {:else}
            <div class="blank">空白页</div>
          {/if}
          <span class="tag">{i + 1}</span>
          <div class="tools">
            <button
              title="上移"
              disabled={i === 0}
              onclick={() => doc.move(i, i - 1)}>↑</button
            >
            <button
              title="下移"
              disabled={i === doc.count - 1}
              onclick={() => doc.move(i, i + 1)}
            >
              ↓
            </button>
            <button title="删除" onclick={() => doc.remove(p.id)}>✕</button>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <button class="empty" onclick={() => picker?.click()}>
      <span>＋</span>
      点击选择图片<br /><small>也可把图片拖到这里</small>
    </button>
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
    gap: 8px;
    align-items: center;
    padding: 10px 12px;
    padding-top: max(10px, env(safe-area-inset-top));
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }

  header strong {
    margin-right: auto;
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
    gap: 24px;
    padding: 24px;
  }

  .sheet {
    position: relative;
    flex: none;
    background: #fff;
    box-shadow: 0 6px 24px #0008;
  }

  .sheet.drag {
    opacity: 0.5;
  }

  .sheet img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    pointer-events: none;
  }

  .blank {
    display: grid;
    place-items: center;
    height: 100%;
    color: #bbb;
    font-size: 20px;
  }

  .tag {
    position: absolute;
    top: -1px;
    left: -1px;
    padding: 2px 8px;
    background: #0008;
    color: #fff;
    font-size: 12px;
    border-bottom-right-radius: 8px;
  }

  .tools {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .sheet:hover .tools,
  .sheet:focus-within .tools {
    opacity: 1;
  }

  /* 触屏没有 hover，工具常驻 */
  @media (hover: none) {
    .tools {
      opacity: 1;
    }
  }

  .tools button {
    padding: 4px 10px;
    background: #000b;
    border-color: #fff3;
  }

  .empty {
    position: absolute;
    inset: 0;
    margin: auto;
    height: max-content;
    padding: 32px 44px;
    background: none;
    border: 2px dashed var(--line);
    color: var(--dim);
    font-size: 17px;
    line-height: 1.8;
  }

  .empty span {
    font-size: 30px;
  }

  .empty small {
    font-size: 13px;
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
