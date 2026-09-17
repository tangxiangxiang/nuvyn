import { expect, test } from '@playwright/test'
import { instantFromLocalDateTime, localDateTimeInputFromInstant } from '../src/features/ledger/time'

const temporalMatrix = [
  { browserTimezone: 'UTC', ledgerTimezone: 'UTC', value: '2026-01-01T00:30' },
  { browserTimezone: 'UTC', ledgerTimezone: 'Asia/Shanghai', value: '2026-03-08T02:30' },
  { browserTimezone: 'America/New_York', ledgerTimezone: 'Asia/Shanghai', value: '2026-03-08T02:30' },
  { browserTimezone: 'Asia/Shanghai', ledgerTimezone: 'America/New_York', value: '2026-03-08T02:30' },
]
const dstLedgerTimezone = 'America/New_York'

async function assertTemporalBridge(page: import('@playwright/test').Page, value: string, ledgerTimezone: string, roundTrip: string): Promise<void> {
  await expect(page.getByTestId('ledger-temporal-date-only').locator('input')).toHaveValue(value.slice(0, 10))
  await expect(page.getByTestId('ledger-temporal-date-only-model')).toHaveText(value.slice(0, 10))
  await expect(page.getByTestId('ledger-temporal').locator('input')).toHaveValue(value.replace('T', ' '))
  await expect(page.getByTestId('ledger-temporal-model')).toHaveText(value)

  await page.getByTestId('ledger-temporal-validate').click()
  await expect(page.getByTestId('ledger-temporal-instant')).toHaveText(String(instantFromLocalDateTime(value, ledgerTimezone)))
  await expect(page.getByTestId('ledger-temporal-roundtrip')).toHaveText(roundTrip)
}

test('Ledger date and wall-clock controls stay stable across the browser/Ledger timezone matrix', async ({ browser }) => {
  for (const { browserTimezone, ledgerTimezone, value } of temporalMatrix) {
    const context = await browser.newContext({ timezoneId: browserTimezone, viewport: { width: 900, height: 700 } })
    const page = await context.newPage()
    const roundTrip = localDateTimeInputFromInstant(instantFromLocalDateTime(value, ledgerTimezone), ledgerTimezone)
    await page.goto(`/e2e/ledger-temporal/?timezone=${encodeURIComponent(ledgerTimezone)}&value=${encodeURIComponent(value)}&date=${encodeURIComponent(value.slice(0, 10))}`)
    await assertTemporalBridge(page, value, ledgerTimezone, roundTrip)
    await context.close()
  }
})

test('Ledger browser bridge preserves DST gap and overlap semantics', async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', viewport: { width: 900, height: 700 } })
  const page = await context.newPage()

  await page.goto(`/e2e/ledger-temporal/?timezone=${encodeURIComponent(dstLedgerTimezone)}&value=2026-03-08T02:30`)
  await assertTemporalBridge(page, '2026-03-08T02:30', dstLedgerTimezone, '2026-03-08T03:30')

  await page.goto(`/e2e/ledger-temporal/?timezone=${encodeURIComponent(dstLedgerTimezone)}&value=2026-11-01T01:30`)
  await assertTemporalBridge(page, '2026-11-01T01:30', dstLedgerTimezone, '2026-11-01T01:30')

  await context.close()
})
