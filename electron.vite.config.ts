import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { build: { externalizeDeps: true } },
  // Sandboxed preloads can't be ES modules.
  preload: { build: { externalizeDeps: true, rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: { plugins: [react()] }
})
