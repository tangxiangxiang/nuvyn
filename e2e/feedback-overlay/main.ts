import { createApp, h } from 'vue'
import '../../src/ui/tokens.css'
import '../../src/style.css'
import FeedbackOverlayHarness from '../../src/ui/__tests__/fixtures/FeedbackOverlayHarness.vue'

createApp({
  render: () => h(FeedbackOverlayHarness),
}).mount('#app')
