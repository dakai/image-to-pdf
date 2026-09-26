// 纯静态托管：SvelteKit 产物全是静态文件，30 行 Bun.serve 顶掉一个 nginx 镜像。
// Bun.file 会按扩展名自动带 Content-Type，不用自己维护 MIME 表。
import { resolve } from "node:path";

const root = `${import.meta.dir}/build`;
const index = `${root}/index.html`;
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(req) {
    // resolve 归一化掉 ../，逃出 build/ 就直接拒了
    const path = resolve(root, "." + decodeURIComponent(new URL(req.url).pathname));
    if (path !== root && !path.startsWith(root + "/"))
      return new Response("Forbidden", { status: 403 });
    const file = Bun.file(path === root ? index : path);
    if (await file.exists()) return new Response(file);
    // 只有页面路由回退到 index，缺资源就 404（否则 .js 请求会拿到 HTML）
    if (/\.[a-z0-9]+$/i.test(path)) return new Response("Not Found", { status: 404 });
    return new Response(Bun.file(index));
  },
});

console.log(`serving ${root} on :${port}`);
