import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const repositoryRoot = fileURLToPath(new URL('./', import.meta.url))
const probeRoot = fileURLToPath(new URL('./e2e/naive-calendar-compatibility/', import.meta.url))

export default defineConfig({
  root: probeRoot,
  plugins: [vue()],
  server: {
    fs: {
      allow: [repositoryRoot],
    },
  },
})
