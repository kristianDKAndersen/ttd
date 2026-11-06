import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const shim = `http://127.0.0.1:${process.env.TTD_SHIM_PORT ?? '7878'}`

export default defineConfig({
  root,
  // Relative asset URLs: the Tauri webview and the shim (which serves app/dist at /) both resolve them.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': shim } },
})
