<script setup lang="ts">
import { ref } from 'vue'
import { NAlert, NButton } from 'naive-ui'
import { instantFromLocalDateTime, localDateTimeInputFromInstant } from '../../../../features/ledger/time'
import LedgerDatePicker from '../../LedgerDatePicker.vue'
import LedgerDateTimePicker from '../../LedgerDateTimePicker.vue'

const query = new URLSearchParams(window.location.search)
const ledgerTimezone = query.get('timezone') ?? 'America/New_York'
const occurredAt = ref(query.get('value') ?? '2026-03-08T02:30')
const dateOnly = ref(query.get('date') ?? occurredAt.value.slice(0, 10))
const instant = ref<number | null>(null)
const roundTrip = ref('')
const error = ref('')

function validate(): void {
  error.value = ''
  instant.value = null
  roundTrip.value = ''
  try {
    instant.value = instantFromLocalDateTime(occurredAt.value, ledgerTimezone)
    roundTrip.value = localDateTimeInputFromInstant(instant.value, ledgerTimezone)
  } catch {
    error.value = 'invalid'
  }
}
</script>

<template>
  <main>
    <h1>Ledger temporal bridge</h1>
    <p data-testid="ledger-temporal-timezone">{{ ledgerTimezone }}</p>
    <LedgerDatePicker v-model="dateOnly" label="日期" test-id="ledger-temporal-date-only" />
    <p data-testid="ledger-temporal-date-only-model">{{ dateOnly }}</p>
    <LedgerDateTimePicker v-model="occurredAt" label="发生时间" test-id="ledger-temporal" />
    <p data-testid="ledger-temporal-model">{{ occurredAt }}</p>
    <NButton data-testid="ledger-temporal-validate" attr-type="button" size="small" @click="validate">验证 Ledger 时间</NButton>
    <NAlert v-if="error" data-testid="ledger-temporal-error" type="error" :show-icon="false">{{ error }}</NAlert>
    <p data-testid="ledger-temporal-instant">{{ instant === null ? '' : instant }}</p>
    <p data-testid="ledger-temporal-roundtrip">{{ roundTrip }}</p>
  </main>
</template>
