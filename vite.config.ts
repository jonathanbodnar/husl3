import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./web", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/web", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir, emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
});
