import { createApp } from 'vue'
import './ui/tokens.css'
import './style.css'
import './shiki.css'
import 'katex/dist/katex.min.css'
import NuvynUiRoot from './ui/NuvynUiRoot.vue'
import router from './router'

createApp(NuvynUiRoot).use(router).mount('#app')


// Register only in production. The worker never caches HTML, API responses,
// Diary documents, or Ledger state; navigation and mutations always use NAS.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      console.warn('[nuvyn] Service worker registration failed', error)
    })
  }, { once: true })
}
