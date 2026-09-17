<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NNumberAnimation as NumberAnimation } from 'naive-ui'
import {
  currencyExponentFor,
  formatLedgerMoney,
  formatLedgerSignedMoney,
} from '../../features/ledger/money'

const props = withDefaults(defineProps<{
  minor: number
  currency: string
  signed?: boolean
  animateOnMount?: boolean
  animateOnChange?: boolean
}>(), { signed: false, animateOnMount: true, animateOnChange: true })

function parts(minor: number, currency: string) {
  const precision = currencyExponentFor(currency)
  const symbol = new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency, currencyDisplay: 'symbol',
    minimumFractionDigits: precision, maximumFractionDigits: precision,
  }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency
  const sign = props.signed
    ? minor > 0 ? '+' : minor < 0 ? '-' : ''
    : minor < 0 ? '-' : ''
  return {
    prefix: `${sign}${symbol}`,
    value: Math.abs(minor) / (10 ** precision),
    precision,
  }
}

// Start the animation from the initial value directly. This keeps the first
// rendered frame in sync with the animation instead of briefly painting the
// final value and then resetting to zero from a delayed mounted hook.
const fromMinor = ref(props.animateOnMount ? 0 : props.minor)
const animationKey = ref(0)
let resetTimer: ReturnType<typeof setTimeout> | undefined
const currentParts = computed(() => parts(props.minor, props.currency))
const fromParts = computed(() => parts(fromMinor.value, props.currency))
const isStatic = computed(() => !props.animateOnMount && !props.animateOnChange)
const staticText = computed(() => props.signed
  ? formatLedgerSignedMoney(props.minor, props.currency)
  : formatLedgerMoney(props.minor, props.currency))
// The Vue template compiler consumes these bindings; keep TypeScript's
// noUnusedLocals check aware of the runtime template references as well.
void NumberAnimation
void currentParts
void fromParts
void isStatic
void staticText

watch(() => ({ minor: props.minor, currency: props.currency }), (next, previous) => {
  if (!props.animateOnChange || next.currency !== previous.currency) fromMinor.value = next.minor
  else fromMinor.value = previous.minor
  animationKey.value += 1
  if (resetTimer) clearTimeout(resetTimer)
  if (props.animateOnChange) {
    resetTimer = setTimeout(() => { fromMinor.value = props.minor }, 700)
  }
})

onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer)
})

</script>

<template>
  <span v-if="isStatic" class="ledger-animated-money">{{ staticText }}</span>
  <span v-else class="ledger-animated-money">
    {{ currentParts.prefix }}<component
      :is="NumberAnimation"
      :key="animationKey"
      :from="fromParts.value"
      :to="currentParts.value"
      :precision="currentParts.precision"
      show-separator
      :duration="2000"
    />
  </span>
</template>
