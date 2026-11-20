import type { Page } from '@playwright/test'
import { expect } from '../fixtures/auth'

export type WorkspaceName = 'note' | 'diary' | 'ledger' | 'board'

const workspaceLabels: Record<WorkspaceName, string> = {
  note: '笔记',
  diary: '日程',
  ledger: '账本',
  board: '白板',
}

const workspacePaths: Record<WorkspaceName, RegExp> = {
  note: /\/vault(?:\/|$)/,
  diary: /\/diary(?:\/|$)/,
  ledger: /\/ledger(?:\/|$)/,
  board: /\/board(?:\/|$)/,
}

/** Switches Workspace through the active responsive navigation surface. */
export async function selectWorkspace(page: Page, workspace: WorkspaceName): Promise<void> {
  const compactSelector = page.getByTestId('mobile-workspace-selector')
  if (await compactSelector.isVisible()) {
    await compactSelector.click()
    await page.getByRole('menuitem', { name: workspaceLabels[workspace], exact: true }).click()
  } else if (workspace === 'board') {
    await page.locator('.workspace-board-link').click()
  } else {
    await page.locator('.scope-chip').filter({ hasText: workspaceLabels[workspace] }).click()
  }

  // Diary access is gated before the router switches scopes. Callers that
  // exercise Diary should unlock the pending access dialog, then assert the
  // route after the gate grants access.
  if (workspace === 'diary') {
    await expect(page.locator('.diary-access-dialog, .diary-life-calendar').first()).toBeVisible()
    return
  }

  await expect(page).toHaveURL(workspacePaths[workspace])
  if (await compactSelector.isVisible()) {
    await expect(compactSelector).toContainText(workspaceLabels[workspace])
  }
}

export type CompactNoteAction = 'left-panel' | 'right-panel' | 'insert-image' | 'read-all' | 'read-selection'

const compactNoteActionLabels: Record<CompactNoteAction, RegExp> = {
  'left-panel': /(打开左侧面板|关闭左侧面板|Open left panel|Close left panel)/u,
  'right-panel': /(打开右侧面板|关闭右侧面板|Open right panel|Close right panel)/u,
  'insert-image': /(插入图片|Insert image)/u,
  'read-all': /(朗读全文|Read note aloud)/u,
  'read-selection': /(朗读所选内容|Read selection aloud)/u,
}

/** Select an action that the Note compact header places under its single menu. */
export async function selectCompactNoteAction(page: Page, action: CompactNoteAction): Promise<void> {
  await page.getByTestId('compact-note-actions').click()
  // Naive UI exposes the dropdown label as visible text across its responsive
  // menu variants, while its role differs between the desktop popover and the
  // tablet drawer presentation.
  await page.getByText(compactNoteActionLabels[action]).click()
}

export async function ensureVaultLeftDrawerOpen(page: Page): Promise<void> {
  const desktopToggle = page.getByTestId('left-panel-toggle')
  const compact = page.getByTestId('mobile-workspace-selector')
  if (await compact.isVisible()) {
    const backdrop = page.getByTestId('note-tablet-backdrop')
    if (await backdrop.isVisible() && !await page.locator('.file-tree').isVisible()) {
      await page.keyboard.press('Escape')
      await expect(backdrop).toBeHidden()
    }
    if (!await page.locator('.file-tree').isVisible()) await selectCompactNoteAction(page, 'left-panel')
  } else if (await desktopToggle.isVisible()) {
    if (await desktopToggle.getAttribute('aria-pressed') !== 'true') await desktopToggle.click()
  }
  await expect(page.locator('.file-tree')).toBeVisible()
}

/** Toggle a Note side panel through the active responsive interaction surface. */
export async function toggleNotePanel(page: Page, side: 'left' | 'right'): Promise<void> {
  const panel = page.locator(side === 'left' ? '.file-tree' : '.right-rail')
  const desktopToggle = page.getByTestId('left-panel-toggle')
  const desktopRightToggle = page.locator('.right-rail-toggle')
  const compact = page.getByTestId('mobile-workspace-selector')

  if (await compact.isVisible()) {
    const backdrop = page.getByTestId('note-tablet-backdrop')
    if (await backdrop.isVisible()) {
      if (await panel.isVisible()) {
        await page.keyboard.press('Escape')
        await expect(backdrop).toBeHidden()
        return
      }
      await page.keyboard.press('Escape')
      await expect(backdrop).toBeHidden()
    }
    await selectCompactNoteAction(page, side === 'left' ? 'left-panel' : 'right-panel')
    return
  }

  const toggle = side === 'left' ? desktopToggle : desktopRightToggle
  if (await toggle.isVisible()) await toggle.click()
}
