import { expect, test, type Page } from '@playwright/test'

async function openHarness(page: Page): Promise<void> {
  await page.goto('/e2e/feedback-overlay/')
  await expect(page.getByTestId('feedback-overlay-harness')).toBeVisible()
}

function recordPageDiagnostics(page: Page): { errors: string[]; warnings: string[]; pageErrors: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
    if (message.type() === 'warning') warnings.push(message.text())
  })
  return { errors, warnings, pageErrors }
}

test('ToastHost bridges semantic lifecycle to Naive messages', async ({ page }) => {
  const diagnostics = recordPageDiagnostics(page)
  await openHarness(page)

  await page.getByTestId('open-toast').click()
  await expect(page.getByText('Toast feedback', { exact: true })).toBeVisible()
  await page.getByTestId('dismiss-toast').click()
  await expect(page.getByText('Toast feedback', { exact: true })).not.toBeVisible()

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.errors).toEqual([])
  expect(diagnostics.warnings).toEqual([])
})

test('ConfirmHost preserves safe focus, Escape, external cancel, and focus return', async ({ page }) => {
  const diagnostics = recordPageDiagnostics(page)
  await openHarness(page)

  const trigger = page.getByTestId('open-confirm')
  await trigger.focus()
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Delete this test item?' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: '确定', exact: true })).not.toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('confirm-result')).toHaveText('cancelled')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()

  await trigger.click()
  await expect(dialog).toBeVisible()
  await page.getByTestId('cancel-confirm').evaluate((button) => (button as HTMLButtonElement).click())
  await expect(page.getByTestId('confirm-result')).toHaveText('cancelled')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.errors).toEqual([])
  expect(diagnostics.warnings).toEqual([])
})

test('PromptHost preserves input semantics, Enter, transform, Escape, and focus return', async ({ page }) => {
  const diagnostics = recordPageDiagnostics(page)
  await openHarness(page)

  const trigger = page.getByTestId('open-prompt')
  await trigger.focus()
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Rename test item' })
  const input = page.getByRole('textbox', { name: 'Rename test item' })
  await expect(dialog).toBeVisible()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('draft name')
  await expect(input).toHaveAttribute('placeholder', 'name')

  await input.fill('  renamed item  ')
  await input.press('Enter')
  await expect(page.getByTestId('prompt-result')).toHaveText('renamed item')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()

  await trigger.click()
  await expect(dialog).toBeVisible()
  await input.fill('needs transform')
  await page.getByRole('button', { name: 'Transform name' }).click()
  await expect(input).toHaveValue('NEEDS TRANSFORM')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('prompt-result')).toHaveText('cancelled')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.errors).toEqual([])
  expect(diagnostics.warnings).toEqual([])
})

test('overlays follow runtime theme and locale without losing an open request', async ({ page }) => {
  const diagnostics = recordPageDiagnostics(page)
  await openHarness(page)

  await page.getByTestId('open-confirm').click()
  const dialog = page.getByRole('dialog', { name: 'Delete this test item?' })
  await expect(dialog).toBeVisible()
  const lightBackground = await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)

  await page.getByTestId('theme-dark').evaluate((button) => (button as HTMLButtonElement).click())
  await expect(page.getByTestId('theme-value')).toHaveText('dark')
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(lightBackground)

  await page.getByTestId('locale-en').evaluate((button) => (button as HTMLButtonElement).click())
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId('confirm-result')).toHaveText('cancelled')

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.errors).toEqual([])
  expect(diagnostics.warnings).toEqual([])
})

test('Teleport overlays coexist with Vault/Ledger modes and clean scroll lock', async ({ page }) => {
  const diagnostics = recordPageDiagnostics(page)
  await openHarness(page)

  for (const mode of ['vault', 'ledger'] as const) {
    await page.getByTestId(`mode-${mode}`).click()
    await expect(page.getByTestId('mode-value')).toHaveText(mode)
    const before = await page.evaluate(() => ({
      bodyOverflow: document.body.style.overflow,
      htmlOverflow: document.documentElement.style.overflow,
    }))

    await page.getByTestId('open-prompt').click()
    await expect(page.getByRole('dialog', { name: 'Rename test item' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Rename test item' })).not.toBeVisible()
    const after = await page.evaluate(() => ({
      bodyOverflow: document.body.style.overflow,
      htmlOverflow: document.documentElement.style.overflow,
    }))
    expect(after).toEqual(before)
  }

  expect(diagnostics.pageErrors).toEqual([])
  expect(diagnostics.errors).toEqual([])
  expect(diagnostics.warnings).toEqual([])
})

test('feedback overlays remain usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openHarness(page)
  await page.getByTestId('open-prompt').click()
  const dialog = page.getByRole('dialog', { name: 'Rename test item' })
  await expect(dialog).toBeVisible()
  expect(await dialog.boundingBox()).not.toBeNull()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
})
