import { createApp, h } from 'vue'
import '../../src/ui/tokens.css'
import '../../src/style.css'
import LedgerTemporalHarness from '../../src/components/ledger/__tests__/fixtures/LedgerTemporalHarness.vue'

createApp({ render: () => h(LedgerTemporalHarness) }).mount('#app')
