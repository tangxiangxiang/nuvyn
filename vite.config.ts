import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import * as vueCompiler from 'vue/compiler-sfc'
import { serverPlugin } from './server/vite-plugin'

// https://vite.dev/config/
export default defineConfig({
  // Initialize compiler-sfc before the first file event so plugin-vue's
  // HMR hook cannot dereference a null compiler during Windows startup.
  plugins: [vue({ compiler: vueCompiler }), serverPlugin()],
})
