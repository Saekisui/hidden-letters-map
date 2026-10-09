import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = "http://localhost:3000";

export default defineConfig({
  root: "web",
  publicDir: "../public",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": backend, "/login": backend },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    cssTarget: "safari13", // 保住 -webkit-backdrop-filter，不然 iOS 上磨砂层没了
  },
});
