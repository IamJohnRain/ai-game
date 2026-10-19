import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发时把 /api、/ws 代理到本地后端（默认 8787），这样前端只用同源相对路径，
// 生产环境由后端自己托管前端与接口，无需在代码里区分 baseUrl。
const BACKEND = process.env.AI_GAME_BACKEND ?? "http://127.0.0.1:8787";

// Vite 的 root 默认取 process.cwd()，而我们的构建命令是在仓库根目录执行的
// （npx vite build --config apps/web/vite.config.ts），所以必须显式指定为配置文件所在目录，
// 否则会去仓库根找 index.html 而报 UNRESOLVED_ENTRY。
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      // ws: true 才能把观战 WebSocket 的升级请求转给后端
      "/ws": { target: BACKEND, changeOrigin: true, ws: true },
      // 登录页由后端渲染（未登录时前端 bundle 不下发），开发时也要代理过去，否则 /login 会 404
      "/login": { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});