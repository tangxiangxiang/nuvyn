<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NNumberAnimation as NumberAnimation, NPopover } from 'naive-ui'
import {
  currencyExponentFor,
  formatLedgerCompactMoney,
  formatLedgerMoney,
  formatLedgerSignedMoney,
} from '../../features/ledger/money'

const props = withDefaults(defineProps<{
  minor: number
  currency: string
  signed?: boolean
  hideFraction?: boolean
  animateOnMount?: boolean
  animateOnChange?: boolean
}>(), { signed: false, hideFraction: false, animateOnMount: true, animateOnChange: true })

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
const compactText = computed(() => props.signed
  ? props.minor === 0
    ? formatLedgerCompactMoney(0, props.currency)
    : `${props.minor > 0 ? '+' : '-'}${formatLedgerCompactMoney(Math.abs(props.minor), props.currency)}`
  : formatLedgerCompactMoney(props.minor, props.currency))
const hideFraction = computed(() => props.hideFraction)
const displayText = computed(() => hideFraction.value ? compactText.value : staticText.value)
// The Vue template compiler consumes these bindings; keep TypeScript's
// noUnusedLocals check aware of the runtime template references as well.
void NumberAnimation
void currentParts
void fromParts
void isStatic
void staticText
void compactText
void hideFraction
void displayText

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
  <NPopover v-if="hideFraction" trigger="click" placement="top" :show-arrow="true">
    <template #trigger>
      <span
        class="ledger-animated-money ledger-animated-money--compact"
        role="button"
        tabindex="0"
        :aria-label="`金额 ${staticText}`"
        :title="staticText"
        @click.stop
      >{{ displayText }}</span>
    </template>
    <span class="ledger-money-popover-value">完整金额：{{ staticText }}</span>
  </NPopover>
  <span v-else-if="isStatic" class="ledger-animated-money">{{ staticText }}</span>
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
