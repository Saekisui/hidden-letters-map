// 假数据架子打成静态页（npm run build:demo → docs/demo/，GitHub Pages 托管当试玩）。不用 server，接口和定位都是 mock。
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "web",
  publicDir: false,
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../docs/demo",
    emptyOutDir: true,
    cssTarget: "safari13",
    rollupOptions: { input: fileURLToPath(new URL("./web/preview.html", import.meta.url)) },
  },
});
