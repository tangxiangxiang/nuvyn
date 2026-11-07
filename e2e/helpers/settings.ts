import { expect, type Locator } from '@playwright/test'

export async function openStorageSettings(settings: Locator): Promise<void> {
  await expect(settings).toBeVisible()
  const category = settings.getByRole('combobox', { name: /^(设置分类|Settings categories)$/ })
  if (await category.isVisible()) {
    await category.selectOption('maintenance')
  } else {
    await settings.getByRole('button', { name: /^(数据与维护|Data & maintenance)$/ }).click()
  }
  await settings.getByRole('button', { name: /^(存储与附件|Storage & attachments)$/ }).click()
}
