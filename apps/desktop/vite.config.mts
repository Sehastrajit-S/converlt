import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Production CSP. Not applied in dev, where Vite's HMR client needs inline scripts.
const csp = {
  name: "converge-csp",
  apply: "build" as const,
  transformIndexHtml(html: string) {
    return html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'" />`,
    );
  },
};

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), csp],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    chunkSizeWarningLimit: 5000,
  },
  server: { port: 5199, strictPort: true },
});
