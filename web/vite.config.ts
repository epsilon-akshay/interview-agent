import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const publicEnv = loadEnv(mode, "..", "VITE_");

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_TLDRAW_LICENSE_KEY": JSON.stringify(publicEnv.VITE_TLDRAW_LICENSE_KEY ?? "")
    },
    server: {
      port: 5173,
      proxy: { "/api": "http://localhost:8080" }
    },
    build: { outDir: "../cmd/server/webdist", emptyOutDir: true }
  };
});
