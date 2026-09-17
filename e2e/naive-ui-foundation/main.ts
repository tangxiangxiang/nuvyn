import { createApp, h } from 'vue'
import '../../src/ui/tokens.css'
import '../../src/style.css'
import NaiveUiFoundationSpike from '../../src/ui/__tests__/fixtures/NaiveUiFoundationSpike.vue'

createApp({
  render: () => h('main', [
    h('button', { 'data-testid': 'keyboard-start' }, 'Keyboard start'),
    h(NaiveUiFoundationSpike, { themeMode: 'light', locale: 'zh' }),
  ]),
}).mount('#app')
