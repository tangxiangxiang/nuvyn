import { createApp } from 'vue'
import './ui/tokens.css'
import './style.css'
import './shiki.css'
import 'katex/dist/katex.min.css'
import NuvynUiRoot from './ui/NuvynUiRoot.vue'
import router from './router'

createApp(NuvynUiRoot).use(router).mount('#app')
