import { expect, type Page } from '@playwright/test'

/** Start an export from an already-open ordinary Note tree context menu. */
export async function chooseDocumentExport(page: Page, format: 'markdown' | 'pdf'): Promise<void> {
  await page.locator('.tree-context-menu').getByRole('button', { name: /^(Export…|导出…)$/u }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('radiogroup') })
  await expect(dialog).toBeVisible()
  const label = format === 'pdf' ? 'PDF (.pdf)' : 'Markdown (.md)'
  // Naive UI keeps its native input visually hidden; click its visible label,
  // then assert the real radio state instead of force-clicking that input.
  await dialog.getByText(label, { exact: true }).click()
  await expect(dialog.getByRole('radio', { name: label, exact: true })).toBeChecked()
  await dialog.getByRole('button', { name: /^(Export|导出)$/u, exact: true }).click()
}
