import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const publicEnv = loadEnv(mode, "..", "VITE_");

  return {
    plugins: [react()],
    resolve: {
      // @monaco-editor/react only needs the loader's public config/init API.
      // This Vite-native adapter returns the installed ESM Monaco instance and
      // therefore cannot fall back to the loader package's CDN default.
      alias: {
        "@monaco-editor/loader": fileURLToPath(new URL("./src/monacoLoader.ts", import.meta.url))
      }
    },
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
