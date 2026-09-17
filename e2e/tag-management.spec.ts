import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures/auth'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import {
  cleanupCreatedPaths,
  createDoc,
  waitForVaultReady,
} from './helpers/edit-program'

const E2E_VAULT = process.env.NUVYN_DRAFT_E2E_VAULT ?? path.join('src', 'content')

function gitSnapshot(): { head: string; status: string } {
  const options = { cwd: process.cwd(), encoding: 'utf8' as const }
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], options).trim(),
    status: execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], options).trim(),
  }
}

/** Mount the panel from a test-only Vite module for focused flow tests. */
async function mountTagManagementHarness(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const harness = await import('/e2e/tag-management-harness.ts')
    harness.mountTagManagementHarness()
  })
}

async function unmountTagManagementHarness(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__t2TagManagementHarness
    harness?.app.unmount()
    harness?.host.remove()
    delete window.__t2TagManagementHarness
  })
}

async function openProductionTagManagementPanel(page: Page): Promise<Locator> {
  await page.locator('.navbar [data-testid="account-button"]').click()
  await page.locator('[data-testid="account-settings"]').click()
  const settings = page.locator('.settings-modal')
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: /^(tags|标签)$/i }).click()
  const panel = settings.locator('[data-tag-management-panel]')
  await expect(panel).toHaveCount(1)
  await expect(panel).toHaveAttribute('data-state', 'ready')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  const activeInsideSettings = await settings.evaluate((root) => root.contains(document.activeElement))
  expect(activeInsideSettings).toBe(true)
  return panel
}

async function closeProductionTagManagementPanel(page: Page, panel: Locator): Promise<void> {
  const settings = page.locator('.settings-modal')
  await settings.getByRole('button', { name: /close|关闭/i }).click()
  await expect(panel).toHaveCount(0)
  await expect(settings).toHaveCount(0)
}

async function selectTagOption(
  panel: Locator,
  controlId: string,
  displayName: string,
): Promise<void> {
  const control = panel.locator(`#${controlId}`)
  await control.click()
  const option = control.getByRole('option', { name: `#${displayName}`, exact: false })
  await expect(option).toHaveCount(1)
  await option.click()
}

type PostDetailForTags = {
  raw: string
  metadata: {
    id: string
    tags: string[]
    updatedAt: number
  }
}

async function readPostDetail(pageRequest: APIRequestContext, slug: string): Promise<PostDetailForTags> {
  const response = await pageRequest.get(`/api/posts/${slug}`)
  expect(response.status(), await response.text()).toBe(200)
  return await response.json() as PostDetailForTags
}

async function setDocumentTags(
  pageRequest: APIRequestContext,
  slug: string,
  tags: string[],
): Promise<PostDetailForTags> {
  const before = await readPostDetail(pageRequest, slug)
  const response = await pageRequest.patch(`/api/metadata/documents/${slug}`, {
    data: { tags, expectedUpdatedAt: before.metadata.updatedAt },
  })
  expect(response.status(), await response.text()).toBe(200)
  return readPostDetail(pageRequest, slug)
}

async function undoLatestChange(
  page: Page,
  dialog: Locator,
  expectedOperation: string,
  cancelFirst = false,
): Promise<void> {
  await expect(dialog).toHaveAttribute('data-undo-state', 'undo-available')
  const previewResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/tags/undo/preview'
  ))
  await dialog.locator('[data-action="undo-preview"]').click()
  const preview = await previewResponse
  expect(preview.status(), await preview.text()).toBe(200)
  await expect(dialog).toHaveAttribute('data-undo-state', 'undo-preview-ready')
  await expect(dialog.locator('[data-undo-preview]')).toContainText(expectedOperation)
  await expect(dialog.locator('[data-undo-preview]')).toContainText('Documents and Markdown content are preserved.')
  await expect(dialog.locator('[data-undo-preview]')).toContainText('Git History is preserved.')

  let applyRequests = 0
  const onRequest = (requestEvent: import('@playwright/test').Request) => {
    if (requestEvent.method() === 'POST' && new URL(requestEvent.url()).pathname === '/api/tags/undo/apply') {
      applyRequests += 1
    }
  }
  page.on('request', onRequest)
  try {
    if (cancelFirst) {
      await dialog.locator('[data-action="undo-apply"]').click()
      const cancelledConfirmation = page.locator('.n-dialog[role="dialog"]')
      await expect(cancelledConfirmation).toBeVisible()
      await expect(cancelledConfirmation.getByRole('button', { name: 'Cancel' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(cancelledConfirmation).not.toBeVisible()
      await expect(dialog).toHaveAttribute('data-undo-state', 'undo-preview-ready')
      expect(applyRequests).toBe(0)
      await expect(dialog.locator('[data-action="undo-apply"]')).toBeFocused()
    }

    const applyResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/undo/apply'
    ))
    await dialog.locator('[data-action="undo-apply"]').click()
    const confirmation = page.locator('.n-dialog[role="dialog"]')
    await expect(confirmation).toContainText(`Confirm ${expectedOperation}?`)
    await confirmation.getByRole('button', { name: 'Confirm Undo' }).click()
    const applied = await applyResponse
    expect(applied.status(), await applied.text()).toBe(200)
    expect(applyRequests).toBe(1)
    await expect(dialog).toHaveAttribute('data-undo-state', 'undo-success')
  } finally {
    page.off('request', onRequest)
  }
}

test('authenticated Rename transport preserves Markdown and Git boundaries', async ({ page, request }) => {
  const slug = `inbox/e2e-tag-management-${Date.now()}`
  const createdPaths: string[] = []
  const filePath = path.join(E2E_VAULT, `${slug}.md`)
  const originalGit = gitSnapshot()

  try {
    await createDoc(request, slug, `# Tag management ${slug}\n\nStable Markdown bytes.\n`, createdPaths)
    const beforeDetail = await (await request.get(`/api/posts/${slug}`)).json() as {
      raw: string
      metadata: { updatedAt: number }
    }
    const metadataPatch = await request.patch(`/api/metadata/documents/${slug}`, {
      data: { tags: ['Java'], expectedUpdatedAt: beforeDetail.metadata.updatedAt },
    })
    expect(metadataPatch.status(), await metadataPatch.text()).toBe(200)

    const markdownBefore = await fs.readFile(filePath)
    const statBefore = await fs.stat(filePath)
    const managedBefore = await request.get('/api/tags')
    expect(managedBefore.status()).toBe(200)
    const java = (await managedBefore.json() as Array<{ id: number; displayName: string }>).find((tag) => tag.displayName === 'Java')
    expect(java?.id).toBeGreaterThan(0)

    // The focused Rename flow still uses the dialog harness so its transport
    // and selection assertions remain independent from the production entry.
    await page.goto('/vault')
    await waitForVaultReady(page)

    await mountTagManagementHarness(page)
    const dialog = page.locator('[data-tag-management-panel]')
    await expect(dialog).toHaveAttribute('data-state', 'ready')
    await selectTagOption(dialog, 'tag-management-source', java!.displayName)
    await dialog.locator('#tag-management-destination').fill('Backend')
    const previewResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST'
        && url.pathname === '/api/tags/operations/preview'
    })
    await dialog.locator('form button[type="submit"]').click()
    const previewResponse = await previewResponsePromise
    expect(previewResponse.status()).toBe(200)
    const preview = await previewResponse.json() as {
      allowedToApply: boolean
      affectedCount: number
      sample: Array<unknown>
      tagCreates: number
      planFingerprint: string
    }
    expect(preview).toMatchObject({ allowedToApply: true, affectedCount: 1, tagCreates: 0 })
    expect(preview.sample).toHaveLength(1)
    expect(preview.planFingerprint).toMatch(/^[0-9a-f]{64}$/)
    await expect(dialog).toHaveAttribute('data-state', 'preview-ready')
    await expect(dialog.locator('.tag-management-summary')).toContainText('1')
    await expect(dialog.locator('.tag-management-sample')).toContainText(slug)
    await expect(dialog.locator('.tag-management-summary')).toContainText('0')
    const applyResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST'
        && url.pathname === '/api/tags/operations/apply'
    })
    await dialog.locator('.tag-management-preview .primary').click()
    const applyResponse = await applyResponsePromise
    expect(applyResponse.status()).toBe(200)
    const applied = await applyResponse.json() as {
      sourceTagId: number
      survivorTagId: number
      sourceDeleted: boolean
      tagCreates: number
      appliedFingerprint: string
    }
    expect(applied).toMatchObject({
      sourceTagId: java!.id,
      survivorTagId: java!.id,
      sourceDeleted: false,
      tagCreates: 0,
      appliedFingerprint: preview.planFingerprint,
    })
    await expect(dialog).toHaveAttribute('data-state', 'success')
    await expect(dialog.locator('.tag-management-state-success')).toHaveAttribute('data-selected-tag', 'Backend')

    const managedAfter = await request.get('/api/tags')
    const backend = (await managedAfter.json() as Array<{ id: number; displayName: string }>).find((tag) => tag.displayName === 'Backend')
    expect(backend).toMatchObject({ id: java!.id, displayName: 'Backend' })

    expect(await fs.readFile(filePath)).toEqual(markdownBefore)
    expect((await fs.stat(filePath)).mtimeMs).toBe(statBefore.mtimeMs)
    expect(gitSnapshot()).toEqual(originalGit)

    await unmountTagManagementHarness(page)
    await page.goto('/vault')
    await waitForVaultReady(page)
    await page.locator('.activity-bar .ab-btn').nth(1).click()
    await expect(page.locator('.tag-entry')).toContainText('Backend')
    await expect(page.locator('.tag-entry')).not.toContainText('Java')
    const productionDialog = await openProductionTagManagementPanel(page)

    // T2-6 production-entry hardening: exercise a real Rename, then a
    // Display Rename through the dialog owned by VaultView. The earlier
    // harness flow remains independent transport coverage.
    const productionRename = `production-backend-${Date.now()}`
    const managedForProduction = await (await request.get('/api/tags')).json() as Array<{
      id: number
      displayName: string
    }>
    const backendTag = managedForProduction.find((tag) => tag.displayName === 'Backend')
    expect(backendTag?.id).toBeGreaterThan(0)
    await productionDialog.locator('[data-operation="rename"]').click()
    await selectTagOption(productionDialog, 'tag-management-source', backendTag!.displayName)
    await productionDialog.locator('#tag-management-destination').fill(productionRename)
    const productionRenamePreview = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/preview'
    ))
    await productionDialog.locator('form button[type="submit"]').click()
    expect((await productionRenamePreview).status()).toBe(200)
    const productionRenameApply = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/apply'
    ))
    await productionDialog.locator('.tag-management-preview .primary').click()
    const productionRenameResult = await productionRenameApply
    expect(productionRenameResult.status()).toBe(200)
    await expect(productionDialog).toHaveAttribute('data-state', 'success')

    await closeProductionTagManagementPanel(page, productionDialog)
    const displayRenameDialog = await openProductionTagManagementPanel(page)
    const managedAfterProductionRename = await (await request.get('/api/tags')).json() as Array<{
      id: number
      displayName: string
    }>
    const productionSource = managedAfterProductionRename.find((tag) => tag.displayName === productionRename)
    expect(productionSource).toMatchObject({ id: backendTag!.id, displayName: productionRename })
    const productionDisplayName = productionRename.toUpperCase()
    await selectTagOption(displayRenameDialog, 'tag-management-source', productionSource!.displayName)
    await displayRenameDialog.locator('#tag-management-destination').fill(productionDisplayName)
    const displayRenamePreview = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/preview'
    ))
    await displayRenameDialog.locator('form button[type="submit"]').click()
    expect((await displayRenamePreview).status()).toBe(200)
    const displayRenameApply = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/apply'
    ))
    await displayRenameDialog.locator('.tag-management-preview .primary').click()
    const displayRenameResult = await displayRenameApply
    expect(displayRenameResult.status()).toBe(200)
    await expect(displayRenameDialog).toHaveAttribute('data-state', 'success')
    const displayApplied = await displayRenameResult.json() as {
      sourceTagId: number
      survivorTagId: number
      displayOnly: boolean
      sourceDeleted: boolean
    }
    expect(displayApplied).toMatchObject({
      sourceTagId: backendTag!.id,
      survivorTagId: backendTag!.id,
      displayOnly: true,
      sourceDeleted: false,
    })

    await closeProductionTagManagementPanel(page, displayRenameDialog)
    const finalProductionDialog = await openProductionTagManagementPanel(page)
    await expect(finalProductionDialog.locator('[data-operation="remove"]')).toHaveCount(1)
    await closeProductionTagManagementPanel(page, finalProductionDialog)
    await expect(page.locator('.navbar [data-testid="account-button"]')).toBeFocused()
  } finally {
    await cleanupCreatedPaths(request, createdPaths)
  }
})

test('authenticated Merge preserves the destination identity, deduplicates overlap, and keeps file boundaries', async ({ page, request }) => {
  const stamp = Date.now()
  const sourceName = `rabbit-${stamp}`
  const destinationName = `pets-${stamp}`
  const productionSourceName = `rabbit-production-${stamp}`
  const productionDestinationName = `pets-production-${stamp}`
  const raceSourceName = `rabbit-race-${stamp}`
  const raceDestinationName = `pets-race-${stamp}`
  const otherName = `work-${stamp}`
  const fixtures = [
    { slug: `inbox/t2-4-merge-source-${stamp}`, tags: [sourceName], body: 'Document A: source only.\n' },
    { slug: `inbox/t2-4-merge-destination-${stamp}`, tags: [destinationName], body: 'Document B: destination only.\n' },
    { slug: `inbox/t2-4-merge-overlap-${stamp}`, tags: [sourceName, destinationName], body: 'Document C: source and destination overlap.\n' },
    { slug: `inbox/t2-6-production-merge-source-${stamp}`, tags: [productionSourceName], body: 'Production source.\n' },
    { slug: `inbox/t2-6-production-merge-destination-${stamp}`, tags: [productionDestinationName], body: 'Production destination.\n' },
    { slug: `inbox/t2-4-merge-race-source-${stamp}`, tags: [raceSourceName], body: 'Race source.\n' },
    { slug: `inbox/t2-4-merge-race-destination-${stamp}`, tags: [raceDestinationName], body: 'Race destination.\n' },
    { slug: `inbox/t2-4-merge-other-${stamp}`, tags: [otherName], body: 'User selection target.\n' },
  ]
  const createdPaths: string[] = []
  const originalGit = gitSnapshot()
  const fileSnapshots = new Map<string, { bytes: Buffer; mtimeMs: number }>()
  const versionBefore = new Map<string, number>()

  try {
    for (const fixture of fixtures) {
      await createDoc(request, fixture.slug, `# ${fixture.slug}\n\n${fixture.body}`, createdPaths)
      const saved = await setDocumentTags(request, fixture.slug, fixture.tags)
      versionBefore.set(fixture.slug, saved.metadata.updatedAt)
      const filePath = path.join(E2E_VAULT, `${fixture.slug}.md`)
      fileSnapshots.set(fixture.slug, {
        bytes: await fs.readFile(filePath),
        mtimeMs: (await fs.stat(filePath)).mtimeMs,
      })
    }

    const managedBeforeResponse = await request.get('/api/tags')
    expect(managedBeforeResponse.status()).toBe(200)
    const managedBefore = await managedBeforeResponse.json() as Array<{
      id: number
      normalizedName: string
      displayName: string
    }>
    const source = managedBefore.find((tag) => tag.displayName === sourceName)
    const destination = managedBefore.find((tag) => tag.displayName === destinationName)
    const productionSource = managedBefore.find((tag) => tag.displayName === productionSourceName)
    const productionDestination = managedBefore.find((tag) => tag.displayName === productionDestinationName)
    const raceSource = managedBefore.find((tag) => tag.displayName === raceSourceName)
    const raceDestination = managedBefore.find((tag) => tag.displayName === raceDestinationName)
    expect(source?.id).toBeGreaterThan(0)
    expect(destination?.id).toBeGreaterThan(0)
    expect(productionSource?.id).toBeGreaterThan(0)
    expect(productionDestination?.id).toBeGreaterThan(0)
    expect(raceSource?.id).toBeGreaterThan(0)
    expect(raceDestination?.id).toBeGreaterThan(0)

    await page.goto('/vault')
    await waitForVaultReady(page)

    // T2-6 production-entry hardening: the Merge flow must work through the
    // Settings -> VaultView -> embedded TagManagementPanel path as well as the
    // focused harness below.
    const productionDialog = await openProductionTagManagementPanel(page)
    await productionDialog.locator('[data-operation="merge"]').click()
    await selectTagOption(productionDialog, 'tag-management-source', productionSourceName)
    await productionDialog.locator('#tag-management-destination-search').fill(productionDestinationName)
    await selectTagOption(productionDialog, 'tag-management-destination', productionDestinationName)
    const productionPreviewResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/preview'
    ))
    await productionDialog.locator('form button[type="submit"]').click()
    const productionPreview = await productionPreviewResponse
    expect(productionPreview.status()).toBe(200)
    expect(await productionPreview.json()).toMatchObject({
      operation: {
        kind: 'merge',
        sourceTagId: productionSource!.id,
        destinationTagId: productionDestination!.id,
      },
      affectedCount: 1,
      associationAdds: 1,
      associationRemoves: 1,
      tagDeletes: 1,
    })
    const productionApplyResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/apply'
    ))
    await productionDialog.locator('.tag-management-preview .primary').click()
    const productionApply = await productionApplyResponse
    expect(productionApply.status()).toBe(200)
    expect(await productionApply.json()).toMatchObject({
      kind: 'merge',
      sourceTagId: productionSource!.id,
      destinationTagId: productionDestination!.id,
      survivorTagId: productionDestination!.id,
      sourceDeleted: true,
    })
    await expect(productionDialog).toHaveAttribute('data-state', 'success')
    await closeProductionTagManagementPanel(page, productionDialog)

    const productionManagedAfter = await (await request.get('/api/tags')).json() as Array<{
      id: number
      displayName: string
    }>
    expect(productionManagedAfter.find((tag) => tag.id === productionSource!.id)).toBeUndefined()
    expect(productionManagedAfter.find((tag) => tag.id === productionDestination!.id)).toMatchObject({
      id: productionDestination!.id,
      displayName: productionDestinationName,
    })
    const productionSourceSlug = `inbox/t2-6-production-merge-source-${stamp}`
    const productionDestinationSlug = `inbox/t2-6-production-merge-destination-${stamp}`
    const productionSourceDetail = await readPostDetail(request, productionSourceSlug)
    const productionDestinationDetail = await readPostDetail(request, productionDestinationSlug)
    expect(productionSourceDetail.metadata.tags).toEqual([productionDestinationName])
    expect(productionDestinationDetail.metadata.tags).toEqual([productionDestinationName])
    expect(productionSourceDetail.metadata.updatedAt).toBeGreaterThan(versionBefore.get(productionSourceSlug)!)
    expect(productionDestinationDetail.metadata.updatedAt).toBe(versionBefore.get(productionDestinationSlug))
    for (const slug of [productionSourceSlug, productionDestinationSlug]) {
      const snapshot = fileSnapshots.get(slug)!
      expect(await fs.readFile(path.join(E2E_VAULT, `${slug}.md`))).toEqual(snapshot.bytes)
      expect((await fs.stat(path.join(E2E_VAULT, `${slug}.md`))).mtimeMs).toBe(snapshot.mtimeMs)
    }
    expect(gitSnapshot()).toEqual(originalGit)

    await mountTagManagementHarness(page)
    const dialog = page.locator('[data-tag-management-panel]')
    await expect(dialog).toHaveAttribute('data-state', 'ready')
    await page.evaluate((tag) => window.__t2TagManagementHarness?.setSelectedTag(tag), sourceName)
    await dialog.locator('[data-operation="merge"]').click()
    await selectTagOption(dialog, 'tag-management-source', sourceName)

    const destinationSelect = dialog.locator('#tag-management-destination')
    await destinationSelect.click()
    const destinationOptionLabels = await destinationSelect.getByRole('option').allTextContents()
    expect(destinationOptionLabels.some((label) => label.includes(`#${sourceName}`))).toBe(false)
    await page.keyboard.press('Escape')
    await dialog.locator('#tag-management-destination-search').fill(destinationName)
    await selectTagOption(dialog, 'tag-management-destination', destinationName)
    await expect(dialog.locator('.tag-management-preview .primary')).toHaveCount(0)

    const previewResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST'
        && url.pathname === '/api/tags/operations/preview'
    })
    await dialog.locator('form button[type="submit"]').click()
    const previewResponse = await previewResponsePromise
    expect(previewResponse.status()).toBe(200)
    const preview = await previewResponse.json() as {
      operation: { kind: string; sourceTagId: number; destinationTagId: number }
      destinationTag: { id: number; displayName: string }
      affectedCount: number
      associationAdds: number
      associationRemoves: number
      duplicateCollapses: number
      tagCreates: number
      tagDeletes: number
      sample: Array<unknown>
      planFingerprint: string
    }
    expect(preview).toMatchObject({
      operation: { kind: 'merge', sourceTagId: source!.id, destinationTagId: destination!.id },
      destinationTag: { id: destination!.id, displayName: destinationName },
      affectedCount: 2,
      associationAdds: 1,
      associationRemoves: 2,
      duplicateCollapses: 1,
      tagCreates: 0,
      tagDeletes: 1,
    })
    expect(preview.sample).toHaveLength(2)
    expect(preview.planFingerprint).toMatch(/^[0-9a-f]{64}$/)
    await expect(dialog).toHaveAttribute('data-state', 'preview-ready')
    await expect(dialog).toContainText('The destination tag will survive')
    await expect(dialog).toContainText('will be deleted')
    await expect(dialog).toContainText('Source-only documents receive the destination tag')
    await expect(dialog.locator('.tag-management-summary')).toContainText('1')

    const applyResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST'
        && url.pathname === '/api/tags/operations/apply'
    })
    await dialog.locator('.tag-management-preview .primary').click()
    const applyResponse = await applyResponsePromise
    expect(applyResponse.status()).toBe(200)
    const applied = await applyResponse.json() as {
      kind: string
      sourceTagId: number
      destinationTagId: number
      survivorTagId: number
      sourceDeleted: boolean
      tagCreates: number
      tagDeletes: number
      appliedFingerprint: string
    }
    expect(applied).toMatchObject({
      kind: 'merge',
      sourceTagId: source!.id,
      destinationTagId: destination!.id,
      survivorTagId: destination!.id,
      sourceDeleted: true,
      tagCreates: 0,
      tagDeletes: 1,
      appliedFingerprint: preview.planFingerprint,
    })
    await expect(dialog).toHaveAttribute('data-state', 'success')
    await expect(dialog.locator('.tag-management-state-success')).toHaveAttribute('data-selected-tag', destinationName)

    const managedAfterResponse = await request.get('/api/tags')
    expect(managedAfterResponse.status()).toBe(200)
    const managedAfter = await managedAfterResponse.json() as Array<{
      id: number
      displayName: string
    }>
    expect(managedAfter.find((tag) => tag.id === source!.id)).toBeUndefined()
    expect(managedAfter.find((tag) => tag.id === destination!.id)).toMatchObject({
      id: destination!.id,
      displayName: destinationName,
    })

    for (const fixture of fixtures.slice(0, 3)) {
      const beforeVersion = versionBefore.get(fixture.slug)!
      const after = await readPostDetail(request, fixture.slug)
      if (fixture.tags.includes(sourceName)) {
        expect(after.metadata.updatedAt).toBeGreaterThan(beforeVersion)
      } else {
        expect(after.metadata.updatedAt).toBe(beforeVersion)
      }
      expect(after.metadata.tags).not.toContain(sourceName)
      expect(after.metadata.tags.filter((tag) => tag === destinationName)).toHaveLength(1)
      const snapshot = fileSnapshots.get(fixture.slug)!
      expect(await fs.readFile(path.join(E2E_VAULT, `${fixture.slug}.md`))).toEqual(snapshot.bytes)
      expect((await fs.stat(path.join(E2E_VAULT, `${fixture.slug}.md`))).mtimeMs).toBe(snapshot.mtimeMs)
    }
    expect(gitSnapshot()).toEqual(originalGit)

    // Browser-level selection epoch case 2: hold the same authoritative sync
    // seam, change selection while it is pending, and verify the newer user
    // selection wins over the Merge survivor.
    await unmountTagManagementHarness(page)
    await mountTagManagementHarness(page)
    const raceDialog = page.locator('[data-tag-management-panel]')
    await expect(raceDialog).toHaveAttribute('data-state', 'ready')
    await page.evaluate((tag) => window.__t2TagManagementHarness?.setSelectedTag(tag), raceSourceName)
    await raceDialog.locator('[data-operation="merge"]').click()
    await selectTagOption(raceDialog, 'tag-management-source', raceSourceName)
    await raceDialog.locator('#tag-management-destination-search').fill(raceDestinationName)
    await selectTagOption(raceDialog, 'tag-management-destination', raceDestinationName)
    const racePreviewResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/preview'
    ))
    await raceDialog.locator('form button[type="submit"]').click()
    await racePreviewResponse
    await expect(raceDialog).toHaveAttribute('data-state', 'preview-ready')
    await page.evaluate(() => window.__t2TagManagementHarness?.holdSync())
    const raceApplyResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/apply'
    ))
    await raceDialog.locator('.tag-management-preview .primary').click()
    await raceApplyResponse
    await expect(raceDialog).toHaveAttribute('data-state', 'syncing')
    await page.evaluate((tag) => window.__t2TagManagementHarness?.setSelectedTag(tag), otherName)
    await page.evaluate(() => window.__t2TagManagementHarness?.releaseSync())
    await expect(raceDialog).toHaveAttribute('data-state', 'success')
    await expect(raceDialog.locator('.tag-management-state-success')).toHaveAttribute('data-selected-tag', otherName)
  } finally {
    await cleanupCreatedPaths(request, createdPaths)
  }
})

test('production Remove previews, confirms once, clears selection, and preserves files', async ({ page, request }) => {
  const stamp = Date.now()
  const sourceName = `remove-source-${stamp}`
  const unrelatedName = `remove-unrelated-${stamp}`
  const fixtures = [
    { slug: `inbox/t2-5-remove-one-${stamp}`, tags: [sourceName], body: 'Remove fixture one.\n' },
    { slug: `inbox/t2-5-remove-two-${stamp}`, tags: [sourceName], body: 'Remove fixture two.\n' },
    { slug: `inbox/t2-5-remove-three-${stamp}`, tags: [sourceName], body: 'Remove fixture three.\n' },
    { slug: `inbox/t2-5-remove-unrelated-${stamp}`, tags: [unrelatedName], body: 'Unrelated fixture.\n' },
  ]
  const createdPaths: string[] = []
  const originalGit = gitSnapshot()
  const fileSnapshots = new Map<string, { bytes: Buffer; mtimeMs: number }>()
  const versionBefore = new Map<string, number>()

  try {
    for (const fixture of fixtures) {
      await createDoc(request, fixture.slug, `# ${fixture.slug}\n\n${fixture.body}`, createdPaths)
      const saved = await setDocumentTags(request, fixture.slug, fixture.tags)
      versionBefore.set(fixture.slug, saved.metadata.updatedAt)
      const filePath = path.join(E2E_VAULT, `${fixture.slug}.md`)
      fileSnapshots.set(fixture.slug, {
        bytes: await fs.readFile(filePath),
        mtimeMs: (await fs.stat(filePath)).mtimeMs,
      })
    }

    const managedBeforeResponse = await request.get('/api/tags')
    expect(managedBeforeResponse.status(), await managedBeforeResponse.text()).toBe(200)
    const managedBefore = await managedBeforeResponse.json() as Array<{
      id: number
      normalizedName: string
      displayName: string
    }>
    const source = managedBefore.find((tag) => tag.displayName === sourceName)
    const unrelated = managedBefore.find((tag) => tag.displayName === unrelatedName)
    expect(source?.id).toBeGreaterThan(0)
    expect(unrelated?.id).toBeGreaterThan(0)

    await page.goto('/vault')
    await waitForVaultReady(page)
    await page.locator('.activity-bar .ab-btn').nth(1).click()
    const sourceRow = page.locator('.tag-entry').filter({ hasText: `#${sourceName}` })
    await expect(sourceRow).toHaveCount(1)
    await sourceRow.click()
    await expect(page.locator('.results')).toContainText('3')

    const dialog = await openProductionTagManagementPanel(page)
    await dialog.locator('[data-operation="remove"]').click()
    await selectTagOption(dialog, 'tag-management-source', sourceName)
    await expect(dialog.locator('#tag-management-destination')).toHaveCount(0)
    await expect(dialog.locator('#tag-management-destination-search')).toHaveCount(0)

    const previewResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/preview'
    ))
    await dialog.locator('form button[type="submit"]').click()
    const previewResponse = await previewResponsePromise
    expect(previewResponse.status(), await previewResponse.text()).toBe(200)
    const preview = await previewResponse.json() as {
      operation: { kind: string; sourceTagId: number }
      sourceTag: { id: number; displayName: string }
      affectedCount: number
      associationRemoves: number
      tagDeletes: number
      sample: Array<unknown>
      planFingerprint: string
    }
    expect(preview).toMatchObject({
      operation: { kind: 'remove', sourceTagId: source!.id },
      sourceTag: { id: source!.id, displayName: sourceName },
      affectedCount: 3,
      associationRemoves: 3,
      tagDeletes: 1,
    })
    expect(preview.sample).toHaveLength(3)
    expect(preview.planFingerprint).toMatch(/^[0-9a-f]{64}$/)
    await expect(dialog).toHaveAttribute('data-state', 'preview-ready')
    await expect(dialog).toContainText(`#${sourceName}`)
    await expect(dialog).toContainText('The documents themselves will not be deleted')
    await expect(dialog).toContainText('Markdown/frontmatter files')
    await expect(dialog).toContainText('global tag record will be deleted')
    await expect(dialog.locator('.tag-management-sample')).toContainText('t2-5-remove-one')

    let applyRequests = 0
    const onRequest = (requestEvent: import('@playwright/test').Request) => {
      if (requestEvent.method() === 'POST' && new URL(requestEvent.url()).pathname === '/api/tags/operations/apply') {
        applyRequests += 1
      }
    }
    page.on('request', onRequest)
    await dialog.locator('[data-action="remove-apply"]').click()
    const confirmation = page.locator('.n-dialog[role="dialog"]')
    await expect(confirmation).toContainText(`Remove tag #${sourceName}?`)
    const cancelButton = confirmation.getByRole('button', { name: 'Cancel' })
    await expect(cancelButton).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(confirmation).toHaveCount(0)
    expect(applyRequests).toBe(0)
    await expect(dialog).toHaveAttribute('data-state', 'preview-ready')
    await expect(dialog.locator('#tag-management-source')).toContainText(`#${sourceName}`)
    await expect(dialog).toContainText(`#${sourceName}`)
    await expect(dialog.locator('[data-action="remove-apply"]')).toBeFocused()

    const applyResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/apply'
    ))
    await dialog.locator('[data-action="remove-apply"]').click()
    const confirmationAgain = page.locator('.n-dialog[role="dialog"]')
    await confirmationAgain.getByRole('button', { name: `Remove #${sourceName}` }).click()
    const applyResponse = await applyResponsePromise
    expect(applyRequests).toBe(1)
    page.off('request', onRequest)
    expect(applyResponse.status(), await applyResponse.text()).toBe(200)
    const applied = await applyResponse.json() as {
      kind: string
      sourceTagId: number
      survivorTagId: number | null
      sourceDeleted: boolean
      affectedCount: number
      associationRemoves: number
      tagDeletes: number
      appliedFingerprint: string
    }
    expect(applied).toMatchObject({
      kind: 'remove',
      sourceTagId: source!.id,
      survivorTagId: null,
      sourceDeleted: true,
      affectedCount: 3,
      associationRemoves: 3,
      tagDeletes: 1,
      appliedFingerprint: preview.planFingerprint,
    })
    await expect(dialog).toHaveAttribute('data-state', 'success')
    await expect(dialog).toContainText(`#${sourceName} was removed`)
    await expect(dialog.locator('.tag-management-state-success')).not.toHaveAttribute('data-selected-tag')

    const managedAfterResponse = await request.get('/api/tags')
    expect(managedAfterResponse.status()).toBe(200)
    const managedAfter = await managedAfterResponse.json() as Array<{ id: number; displayName: string }>
    expect(managedAfter.find((tag) => tag.id === source!.id)).toBeUndefined()
    expect(managedAfter.find((tag) => tag.id === unrelated!.id)).toMatchObject({ id: unrelated!.id, displayName: unrelatedName })

    for (const fixture of fixtures) {
      const after = await readPostDetail(request, fixture.slug)
      expect(after.raw).toBeDefined()
      if (fixture.tags.includes(sourceName)) {
        expect(after.metadata.updatedAt).toBeGreaterThan(versionBefore.get(fixture.slug)!)
        expect(after.metadata.tags).not.toContain(sourceName)
      } else {
        expect(after.metadata.updatedAt).toBe(versionBefore.get(fixture.slug))
        expect(after.metadata.tags).toEqual([unrelatedName])
      }
      const snapshot = fileSnapshots.get(fixture.slug)!
      const filePath = path.join(E2E_VAULT, `${fixture.slug}.md`)
      expect(await fs.readFile(filePath)).toEqual(snapshot.bytes)
      expect((await fs.stat(filePath)).mtimeMs).toBe(snapshot.mtimeMs)
    }
    expect(gitSnapshot()).toEqual(originalGit)

    await closeProductionTagManagementPanel(page, dialog)
    await expect(page.locator('.results')).toHaveCount(0)
    await expect(page.locator('.tag-entry').filter({ hasText: `#${sourceName}` })).toHaveCount(0)
  } finally {
    await cleanupCreatedPaths(request, createdPaths)
  }
})

test('production Undo previews, confirms, and restores Rename, Display Rename, Merge, and Remove', async ({ page, request }) => {
  const stamp = Date.now()
  const renameSourceName = `undo-rename-source-${stamp}`
  const renameDestinationName = `undo-rename-destination-${stamp}`
  const displaySourceName = `undo-display-source-${stamp}`
  const displayDestinationName = displaySourceName.toUpperCase()
  const mergeSourceName = `undo-merge-source-${stamp}`
  const mergeDestinationName = `undo-merge-destination-${stamp}`
  const removeSourceName = `undo-remove-source-${stamp}`
  const fixtures = [
    { slug: `inbox/t2-1-5-undo-rename-${stamp}`, tags: [renameSourceName], body: 'Undo Rename fixture.\n' },
    { slug: `inbox/t2-1-5-undo-display-${stamp}`, tags: [displaySourceName], body: 'Undo Display Rename fixture.\n' },
    { slug: `inbox/t2-1-5-undo-merge-source-${stamp}`, tags: [mergeSourceName], body: 'Undo Merge source fixture.\n' },
    { slug: `inbox/t2-1-5-undo-merge-destination-${stamp}`, tags: [mergeDestinationName], body: 'Undo Merge destination fixture.\n' },
    { slug: `inbox/t2-1-5-undo-merge-overlap-${stamp}`, tags: [mergeSourceName, mergeDestinationName], body: 'Undo Merge overlap fixture.\n' },
    { slug: `inbox/t2-1-5-undo-remove-${stamp}`, tags: [removeSourceName], body: 'Undo Remove fixture.\n' },
  ]
  const createdPaths: string[] = []

  const tagByName = async (name: string): Promise<{ id: number; displayName: string }> => {
    const response = await request.get('/api/tags')
    expect(response.status(), await response.text()).toBe(200)
    const tags = await response.json() as Array<{ id: number; displayName: string }>
    const tag = tags.find((candidate) => candidate.displayName === name)
    expect(tag, `managed tag ${name}`).toBeTruthy()
    return tag!
  }

  const openDialog = async (): Promise<Locator> => {
    return openProductionTagManagementPanel(page)
  }

  const closeDialog = async (dialog: Locator): Promise<void> => {
    await closeProductionTagManagementPanel(page, dialog)
  }

  const ordinaryRename = async (
    dialog: Locator,
    sourceName: string,
    destinationName: string,
  ): Promise<void> => {
    await dialog.locator('[data-operation="rename"]').click()
    await selectTagOption(dialog, 'tag-management-source', sourceName)
    await dialog.locator('#tag-management-destination').fill(destinationName)
    const previewResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/preview'
    ))
    await dialog.locator('form button[type="submit"]').click()
    expect((await previewResponse).status()).toBe(200)
    const applyResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/apply'
    ))
    await dialog.locator('.tag-management-preview .primary').click()
    expect((await applyResponse).status()).toBe(200)
    await expect(dialog).toHaveAttribute('data-state', 'success')
    await expect(dialog).toHaveAttribute('data-undo-state', 'undo-available')
  }

  try {
    for (const fixture of fixtures) {
      await createDoc(request, fixture.slug, `# ${fixture.slug}\n\n${fixture.body}`, createdPaths)
      await setDocumentTags(request, fixture.slug, fixture.tags)
    }

    await page.goto('/vault')
    await waitForVaultReady(page)
    await page.locator('.activity-bar .ab-btn').nth(1).click()

    const renameSource = await tagByName(renameSourceName)
    await page.locator('.tag-entry').filter({ hasText: `#${renameSourceName}` }).click()
    let dialog = await openDialog()
    await ordinaryRename(dialog, renameSourceName, renameDestinationName)
    await undoLatestChange(page, dialog, 'Undo Rename', true)
    await closeDialog(dialog)
    expect(await tagByName(renameSourceName)).toMatchObject({ id: renameSource.id, displayName: renameSourceName })
    await expect(page.locator('.tag-entry').filter({ hasText: `#${renameSourceName}` })).toHaveCount(1)

    const displaySource = await tagByName(displaySourceName)
    await page.locator('.tag-entry').filter({ hasText: `#${displaySourceName}` }).click()
    dialog = await openDialog()
    await ordinaryRename(dialog, displaySourceName, displayDestinationName)
    await undoLatestChange(page, dialog, 'Undo Display Rename')
    await closeDialog(dialog)
    expect(await tagByName(displaySourceName)).toMatchObject({ id: displaySource.id, displayName: displaySourceName })

    const mergeSource = await tagByName(mergeSourceName)
    const mergeDestination = await tagByName(mergeDestinationName)
    await page.locator('.tag-entry').filter({ hasText: `#${mergeSourceName}` }).click()
    dialog = await openDialog()
    await dialog.locator('[data-operation="merge"]').click()
    await selectTagOption(dialog, 'tag-management-source', mergeSourceName)
    await dialog.locator('#tag-management-destination-search').fill(mergeDestinationName)
    await selectTagOption(dialog, 'tag-management-destination', mergeDestinationName)
    let previewResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/preview'
    ))
    await dialog.locator('form button[type="submit"]').click()
    expect((await previewResponse).status()).toBe(200)
    let applyResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/apply'
    ))
    await dialog.locator('.tag-management-preview .primary').click()
    expect((await applyResponse).status()).toBe(200)
    await expect(dialog).toHaveAttribute('data-state', 'success')
    await expect(dialog).toHaveAttribute('data-undo-state', 'undo-available')
    await undoLatestChange(page, dialog, 'Undo Merge')
    await closeDialog(dialog)
    expect(await tagByName(mergeSourceName)).toMatchObject({ id: mergeSource.id, displayName: mergeSourceName })
    expect(await tagByName(mergeDestinationName)).toMatchObject({ id: mergeDestination.id, displayName: mergeDestinationName })
    await expect((await readPostDetail(request, fixtures[2].slug)).metadata.tags).toEqual([mergeSourceName])
    await expect((await readPostDetail(request, fixtures[3].slug)).metadata.tags).toEqual([mergeDestinationName])
    expect((await readPostDetail(request, fixtures[4].slug)).metadata.tags.sort()).toEqual([mergeSourceName, mergeDestinationName].sort())

    const removeSource = await tagByName(removeSourceName)
    await page.locator('.tag-entry').filter({ hasText: `#${removeSourceName}` }).click()
    dialog = await openDialog()
    await dialog.locator('[data-operation="remove"]').click()
    await selectTagOption(dialog, 'tag-management-source', removeSourceName)
    previewResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/preview'
    ))
    await dialog.locator('form button[type="submit"]').click()
    expect((await previewResponse).status()).toBe(200)
    applyResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tags/operations/apply'
    ))
    await dialog.locator('[data-action="remove-apply"]').click()
    const removeConfirmation = page.locator('.n-dialog[role="dialog"]')
    await removeConfirmation.getByRole('button', { name: `Remove #${removeSourceName}` }).click()
    expect((await applyResponse).status()).toBe(200)
    await expect(dialog).toHaveAttribute('data-state', 'success')
    await expect(dialog).toHaveAttribute('data-undo-state', 'undo-available')
    await undoLatestChange(page, dialog, 'Undo Remove')
    await closeDialog(dialog)
    expect(await tagByName(removeSourceName)).toMatchObject({ id: removeSource.id, displayName: removeSourceName })
    await expect((await readPostDetail(request, fixtures[5].slug)).metadata.tags).toEqual([removeSourceName])
  } finally {
    await cleanupCreatedPaths(request, createdPaths)
  }
})
