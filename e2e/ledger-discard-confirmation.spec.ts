import { expect, test } from './fixtures/auth'
import { ensurePeriodNavigationFixtures } from './helpers/ledger-live'

for (const mobile of [false, true]) {
  test.describe(mobile ? 'mobile discard confirmation' : 'desktop discard confirmation', () => {
    test.use({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, hasTouch: mobile, locale: 'zh-CN' })

    test('closes each confirmation once and keeps discarded changes out of storage', async ({ page, request }) => {
      const { categoryId } = await ensurePeriodNavigationFixtures(request)
      const key = crypto.randomUUID()
      const account = await request.post('/api/ledger/accounts', {
        data: { name: `Discard ${key}`, type: 'bank', nature: 'asset', openingBalanceMinor: 0, openingDate: '2026-01-01', currency: 'CNY', note: '' },
        headers: { 'Idempotency-Key': `discard-account-${key}` },
      })
      expect(account.status(), await account.text()).toBe(201)
      const created = await request.post('/api/ledger/transactions', {
        data: { type: 'expense', accountId: (await account.json()).id, categoryId, amountMinor: 3500, occurredAt: Date.now(), payee: 'Discard fixture', note: 'Original note' },
        headers: { 'Idempotency-Key': `discard-transaction-${key}` },
      })
      expect(created.status(), await created.text()).toBe(201)
      const { id } = await created.json()
      const updates: string[] = []
      page.on('request', (req) => {
        if (new URL(req.url()).pathname.startsWith('/api/ledger/transactions') && req.method() !== 'GET') updates.push(req.method())
      })

      await page.goto('/ledger/transactions')
      const row = page.getByTestId(`ledger-transaction-row-${id}`).filter({ visible: true })
      const detail = page.getByTestId('ledger-transaction-detail-sheet')
      const form = detail.getByTestId('ledger-transaction-edit-form')
      const edit = detail.getByRole('button', { name: '编辑交易' })
      const close = detail.getByRole('button', { name: '关闭交易详情' })
      const cancelEdit = form.getByRole('button', { name: '取消', exact: true })
      const note = form.locator('textarea[name="note"]')
      const amount = form.locator('input[name="amount"]')
      const confirm = page.locator('[aria-label="放弃这笔尚未保存的修改？"]')
      const negative = confirm.getByRole('button', { name: '取消', exact: true })
      const positive = confirm.getByRole('button', { name: '确定', exact: true })
      const masks = page.locator('.n-modal-mask')
      const activate = async (button: typeof close) => mobile ? button.tap() : button.click()
      const dismissMask = async () => {
        if (mobile) await page.touchscreen.tap(4, 4)
        else await page.mouse.click(4, 4)
      }
      const expectConfirm = async () => {
        await expect(confirm).toHaveCount(1)
        await expect(negative).toBeFocused()
      }
      const expectClosed = async (detailOpen: boolean) => {
        await expect(confirm).toHaveCount(0)
        await expect(masks).toHaveCount(detailOpen ? 1 : 0)
      }

      await activate(row)
      await activate(edit)
      await note.fill('Unsaved note')
      await activate(cancelEdit)
      await expectConfirm()
      await activate(negative)
      await expectClosed(true)
      await expect(note).toHaveValue('Unsaved note')

      // Dispatch both entry points synchronously before the confirm can mount.
      await cancelEdit.evaluate((button) => {
        const closeButton = button.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('[aria-label="关闭交易详情"]')
        button.click()
        button.click()
        closeButton?.click()
      })
      await expectConfirm()
      await activate(positive)
      await expectClosed(true)
      await expect(detail.locator('.ledger-detail-content')).toBeFocused()
      await expect(form).toHaveCount(0)

      await activate(edit)
      await expect(note).toHaveValue('Original note')
      const originalAmount = await amount.inputValue()
      await amount.fill('99')
      await activate(close)
      await expectConfirm()
      await activate(negative)
      await expectClosed(true)
      await expect(amount).toHaveValue('99')

      await page.keyboard.press('Escape')
      await expectConfirm()
      await page.keyboard.press('Escape')
      await expectClosed(true)
      await expect(amount).toHaveValue('99')

      await dismissMask()
      await expectConfirm()
      await dismissMask()
      await expectClosed(true)
      await expect(amount).toHaveValue('99')

      await activate(close)
      await expectConfirm()
      await activate(positive)
      await expectClosed(false)
      await expect(detail).toHaveCount(0)
      await page.reload()
      await activate(row)
      await activate(edit)
      await expect(amount).toHaveValue(originalAmount)
      await expect(note).toHaveValue('Original note')
      await activate(close)
      await expectClosed(false)
      expect(updates).toEqual([])
    })
  })
}
