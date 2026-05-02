import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `VITE_BASE` is set by the GitHub Pages workflow to "/<repo-name>/".
// For local dev and root-domain hosts (e.g. Cloudflare Pages, Vercel) leave unset.
const base = process.env.VITE_BASE ?? "/";

export default defineConfig({
  plugins: [react()],
  base,
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_WORKER_URL ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  worker: { format: "es" },
  optimizeDeps: { include: ["pdfjs-dist"] },
});
