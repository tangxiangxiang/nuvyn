import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/auth'
import { cleanupCreatedPaths, createDoc, gotoVaultReady, openDoc } from './helpers/edit-program'

type SpeechMock = {
  settingsReads: number
  syntheses: Array<{ text: string }>
  synthResponses: Array<{ status: number; contentType: string | undefined }>
  settingsWrites: Array<{ profileId: string | null; privacyConsent: boolean }>
  cacheClears: number
  pronunciations: Array<{ id: string; text: string; pinyin: string }>
}

async function mockSpeech(page: Page, privacyConsent: boolean): Promise<SpeechMock> {
  const state: SpeechMock = { settingsReads: 0, syntheses: [], synthResponses: [], settingsWrites: [], cacheClears: 0, pronunciations: [] }
  await page.route('**/api/ai/tts/pronunciations', async (route) => {
    if (route.request().method() === 'PUT') state.pronunciations = route.request().postDataJSON()
    return route.fulfill({ json: state.pronunciations })
  })
  page.on('response', (response) => {
    if (response.url().endsWith('/api/ai/tts/synthesize')) {
      state.synthResponses.push({ status: response.status(), contentType: response.headers()['content-type'] })
    }
  })
  let settings = { profileId: 'speech-profile-fixture', privacyConsent, voiceId: 'audiobook_male_1' }
  await page.route('**/api/ai/tts/cache', async (route) => {
    if (route.request().method() === 'DELETE') state.cacheClears++
    return route.fulfill({ json: { bytes: state.cacheClears ? 0 : 1048576, limitBytes: 536870912 } })
  })
  await page.addInitScript(() => {
    const sources = new WeakMap<HTMLMediaElement, string>()
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      get() { return sources.get(this) ?? '' },
      set(value: string) { sources.set(this, String(value)) },
    })
    const removeAttribute = HTMLMediaElement.prototype.removeAttribute
    HTMLMediaElement.prototype.removeAttribute = function removeAttributeMock(name: string) {
      if (name.toLowerCase() === 'src') {
        sources.delete(this)
        return
      }
      removeAttribute.call(this, name)
    }
    HTMLMediaElement.prototype.play = function play() { return Promise.resolve() }
    HTMLMediaElement.prototype.load = function load() {}
  })
  await page.route('**/api/ai/tts/settings', async (route) => {
    if (route.request().method() === 'GET') {
      state.settingsReads += 1
      return route.fulfill({ json: settings })
    }
    const input = JSON.parse(route.request().postData() ?? '{}') as typeof settings
    state.settingsWrites.push(input)
    settings = input
    return route.fulfill({ json: settings })
  })
  await page.route('**/api/ai/tts/synthesize', async (route) => {
    state.syntheses.push(JSON.parse(route.request().postData() ?? '{}') as { text: string })
    return route.fulfill({
      status: 200,
      contentType: 'audio/mpeg',
      body: Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0]),
    })
  })
  return state
}

test('reads the active unsaved Markdown snapshot, asks consent once, and controls playback', async ({ page, request }) => {
  const documentPath = `inbox/read-aloud-${randomUUID()}`
  const created: string[] = []
  const mock = await mockSpeech(page, false)
  const unsaved = [
    '# Unsaved reading',
    '',
    'This sentence was **not saved yet**.',
    '',
    '![Do not speak this image alt](local-image.png)',
    '',
    '```js',
    'console.log("private code block")',
    '```',
  ].join('\n')

  try {
    await createDoc(request, documentPath, '# Saved title\n\nSaved body.', created)
    await gotoVaultReady(page)
    await openDoc(page, documentPath)
    await page.locator('.monaco-host').evaluate((host, value) => {
      const editor = (host as any).__vueParentComponent.setupState.editor
      editor.getModel().setValue(value)
    }, unsaved)
    await expect.poll(() => page.locator('.monaco-host').evaluate((host) => (
      (host as any).__vueParentComponent.setupState.editor.getValue()
    ))).toBe(unsaved)

    const readAll = page.getByTestId('note-speech-menu')
    await expect(readAll).toBeVisible()
    await readAll.click()
    const readAllOption = page.locator('.n-dropdown-option').filter({ hasText: /朗读全文|Read note aloud/i })
    await expect(readAllOption).toBeVisible()
    await readAllOption.click()
    const privacyDialog = page.getByRole('dialog', { name: /Confirm before using Read Aloud|确认使用朗读/ })
    await expect(privacyDialog).toBeVisible()
    await expect(privacyDialog).toContainText(/MiniMax/)
    expect(mock.syntheses).toHaveLength(0)
    await privacyDialog.getByRole('button', { name: /确认|Confirm/i }).click()

    await expect.poll(() => mock.settingsWrites.length).toBe(1)
    await expect.poll(() => mock.syntheses.length).toBe(2)
    expect(mock.settingsWrites[0]).toEqual({ profileId: 'speech-profile-fixture', privacyConsent: true })
    expect(mock.syntheses.map(({ text }) => text)).toEqual(['Unsaved reading\n\n', 'This sentence was not saved yet.'])
    const spoken = mock.syntheses.map(({ text }) => text).join('')
    expect(spoken).not.toContain('Saved title')
    expect(spoken).not.toContain('private code block')
    expect(spoken).not.toContain('Do not speak this image alt')
    expect(mock.synthResponses).toContainEqual({ status: 200, contentType: 'audio/mpeg' })

    const player = page.getByTestId('note-speech-player')
    await expect(player).toBeVisible()
    await expect(player).toContainText(/正在朗读|Reading aloud/)
    await player.getByRole('button', { name: /暂停|Pause/i }).click()
    await expect(player).toContainText(/已暂停|Paused/)
    await player.getByRole('button', { name: /继续|Resume/i }).click()
    await expect(player).toContainText(/正在朗读|Reading aloud/)
    await player.getByRole('button', { name: /停止朗读|Stop reading/i }).click()
    await expect(player).toHaveCount(0)
  } finally {
    await cleanupCreatedPaths(request, created)
  }
})

test('Monaco context menu reads only a non-empty selection without editing the document', async ({ page, request }) => {
  const documentPath = `inbox/read-selection-${randomUUID()}`
  const created: string[] = []
  const mock = await mockSpeech(page, true)
  const source = '# Selection\n\nSpeak only this phrase.\n\nKeep this line.'

  try {
    await createDoc(request, documentPath, source, created)
    await gotoVaultReady(page)
    await openDoc(page, documentPath)
    const host = page.locator('.monaco-host')
    await expect.poll(() => host.evaluate((element) => {
      const editor = (element as any).__vueParentComponent.setupState.editor
      return Boolean(editor.getAction('nuvyn.read-note-selection'))
    })).toBe(true)

    const clickEditorAt = async (lineNumber: number, column: number, button: 'right' | 'left' = 'right') => {
      const point = await host.evaluate((element, position) => {
        const editor = (element as any).__vueParentComponent.setupState.editor
        const visible = editor.getScrolledVisiblePosition(position)
        const bounds = editor.getDomNode().getBoundingClientRect()
        if (!visible) throw new Error('Editor position is not visible')
        return { x: bounds.left + visible.left + 2, y: bounds.top + visible.top + visible.height / 2 }
      }, { lineNumber, column })
      await page.mouse.click(point.x, point.y, { button })
    }

    await host.evaluate((element) => {
      const editor = (element as any).__vueParentComponent.setupState.editor
      editor.setSelection({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 })
      editor.focus()
    })
    await clickEditorAt(3, 1)
    const noSelectionMenu = page.getByRole('menuitem', { name: /朗读所选内容|Read selection aloud/i })
    await expect(noSelectionMenu).toHaveCount(0)
    await page.keyboard.press('Escape')

    await host.evaluate((element) => {
      const editor = (element as any).__vueParentComponent.setupState.editor
      editor.setSelection({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 24 })
      editor.focus()
    })
    await clickEditorAt(3, 5)
    const selectionMenu = page.getByRole('menuitem', { name: /朗读所选内容|Read selection aloud/i })
    await expect(selectionMenu).toBeVisible()
    // Monaco registers its menu mouse-up handler shortly after the right-click opens it.
    await page.waitForTimeout(120)
    await selectionMenu.click()
    await expect.poll(() => mock.settingsReads).toBe(1)
    await expect.poll(() => mock.syntheses.length).toBe(1)
    expect(mock.syntheses[0]?.text).toBe('Speak only this phrase.')
    const current = await host.evaluate((element) => (element as any).__vueParentComponent.setupState.editor.getValue())
    expect(current).toBe(source)
  } finally {
    await cleanupCreatedPaths(request, created)
  }
})

test('reading selection is scoped to the current article and Note eligibility excludes phone and other workspaces', async ({ page, request }) => {
  const documentPath = `inbox/reader-speech-${randomUUID()}`
  const created: string[] = []
  const mock = await mockSpeech(page, true)

  try {
    await createDoc(request, documentPath, '# Reader\n\nRead this visible selection only.\n\nAnother paragraph.', created)
    await gotoVaultReady(page)
    await openDoc(page, documentPath)
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.getByTestId('view-toggle').click()
    const reader = page.locator('.reading-pane .article')
    await expect(reader).toBeVisible()
    const paragraph = reader.locator('p').filter({ hasText: 'Read this visible selection only.' }).first()
    await paragraph.evaluate((element) => {
      const selection = window.getSelection()
      if (!selection) throw new Error('Selection API unavailable')
      const range = document.createRange()
      range.selectNodeContents(element)
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    const actions = page.getByTestId('note-reading-selection-actions')
    await expect(actions).toBeVisible()
    await actions.getByRole('button', { name: /朗读所选内容|Read selection aloud/i }).click()
    await expect.poll(() => mock.syntheses.length).toBe(1)
    expect(mock.syntheses[0]?.text).toBe('Read this visible selection only.')

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('note-speech-menu')).toHaveCount(0)
    await page.goto('/ledger')
    await expect(page.getByTestId('note-speech-menu')).toHaveCount(0)
    await page.goto('/board')
    await expect(page.getByTestId('note-speech-menu')).toHaveCount(0)
    await page.goto('/vault/diary')
    await expect(page.getByTestId('note-speech-menu')).toHaveCount(0)
  } finally {
    await cleanupCreatedPaths(request, created)
  }
})

test('speech profile menu is clickable above the Settings backdrop and saves the selected profile', async ({ page }) => {
  const mock = await mockSpeech(page, false)
  await page.route('**/api/ai/profiles', (route) => route.fulfill({ json: {
    activeProfileId: null, migrationError: null,
    profiles: [{ id: 'speech-profile-fixture', name: 'Speech fixture', provider: 'anthropic',
      configured: true, credentialError: null, baseURL: '', model: '', createdAt: 1, updatedAt: 1 }],
  } }))
  await gotoVaultReady(page)
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-settings').click()
  const settings = page.locator('.settings-modal')
  const select = page.getByTestId('settings-speech-profile')
  await select.click()
  const option = page.locator('.n-base-select-option').filter({ hasText: 'Speech fixture' })
  await expect(option).toBeVisible()
  await expect.poll(() => option.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  })).toBe(true)
  await option.click()
  await expect(select).toContainText('Speech fixture')
  await select.click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  await expect(settings).toBeVisible()
  await page.getByTestId('settings-speech-voice').click()
  await page.locator('.n-base-select-option').filter({ hasText: /有声书女声|Audiobook female/ }).click()
  await settings.locator('.settings-speech-card').getByRole('button', { name: /^(保存|Save)$/ }).click()
  await expect.poll(() => mock.settingsWrites).toEqual([{ profileId: 'speech-profile-fixture', privacyConsent: false, voiceId: 'audiobook_female_1' }])
  await settings.getByRole('button', { name: /^(关闭|Close)$/ }).click()
  await expect(settings).toHaveCount(0)
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-settings').click()
  await expect(page.getByTestId('settings-speech-voice')).toContainText(/有声书女声|Audiobook female/)
  await page.getByTestId('settings-speech-voice').click()
  await page.keyboard.press('Escape')
  await expect(settings).toBeVisible()

  const speech = settings.locator('.settings-speech-card')
  await expect(speech).toContainText(/1\.0 \/ 512 MiB/)
  await speech.getByRole('button', { name: /清除朗读缓存|Clear speech cache/ }).click()
  const confirmation = page.getByRole('dialog').filter({ hasText: /重新生成音频|regenerate audio/ })
  await expect(confirmation).toBeVisible()
  expect(mock.cacheClears).toBe(0)
  await confirmation.getByRole('button', { name: /^(确定|Confirm)$/ }).click()
  await expect.poll(() => mock.cacheClears).toBe(1)
  await expect(speech).toContainText(/0\.0 \/ 512 MiB/)
  await speech.getByRole('button', { name: /发音词典|Pronunciation dictionary/ }).click()
  let dictionary = page.getByTestId('speech-pronunciations')
  await expect(dictionary).toBeVisible()
  await dictionary.getByRole('textbox', { name: /^(词语|Word)$/ }).fill('天姥')
  await dictionary.getByRole('textbox', { name: /正确拼音|Correct pinyin/ }).fill('tian1 mu3')
  await dictionary.getByRole('button', { name: /^(保存|Save)$/ }).click()
  await expect(dictionary).toContainText('天姥 · tian1 mu3')
  await page.keyboard.press('Escape')
  await expect(dictionary).toHaveCount(0)
  await expect(settings).toBeVisible()
  await speech.getByRole('button', { name: /发音词典|Pronunciation dictionary/ }).click()
  dictionary = page.getByTestId('speech-pronunciations')
  await expect(dictionary).toContainText('天姥 · tian1 mu3')
  await dictionary.getByRole('button', { name: /^(编辑|Edit)$/ }).click()
  await dictionary.getByRole('textbox', { name: /正确拼音|Correct pinyin/ }).fill('tian1 lao3')
  await dictionary.getByRole('button', { name: /^(保存|Save)$/ }).click()
  await expect(dictionary).toContainText('天姥 · tian1 lao3')
  await dictionary.getByRole('button', { name: /^(删除|Delete)$/ }).click()
  const deleteConfirm = page.getByRole('dialog').filter({ hasText: /确认删除|Delete “/ })
  await expect(deleteConfirm).toBeVisible()
  expect(mock.pronunciations).toHaveLength(1)
  await deleteConfirm.getByRole('button', { name: /^(确定|Confirm)$/ }).click()
  await expect.poll(() => mock.pronunciations.length).toBe(0)
  await expect(dictionary.locator('.speech-pronunciation-row')).toHaveCount(0)
})


test('corrupt pronunciation recovery requires confirmation and works above Settings on a tablet', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  const mock = await mockSpeech(page, false)
  let corrupt = true
  let resets = 0
  await page.route('**/api/ai/tts/pronunciations', async (route) => {
    if (corrupt) return route.fulfill({ status: 503, json: { error: 'Dictionary is corrupt', code: 'tts-pronunciations-corrupt' } })
    if (route.request().method() === 'PUT') mock.pronunciations = route.request().postDataJSON()
    return route.fulfill({ json: mock.pronunciations })
  })
  await page.route('**/api/ai/tts/pronunciations/reset', async (route) => {
    resets++
    corrupt = false
    return route.fulfill({ json: [] })
  })
  await gotoVaultReady(page)
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-settings').click()
  await page.locator('.settings-speech-card').getByRole('button', { name: /发音词典|Pronunciation dictionary/ }).click()
  const dictionary = page.getByTestId('speech-pronunciations')
  await expect(dictionary.getByRole('alert')).toContainText(/损坏|corrupt/)
  const recover = dictionary.getByRole('button', { name: /重置发音词典|Reset pronunciation dictionary/ })
  await recover.click()
  const confirmation = page.getByRole('dialog').filter({ hasText: /确认重置损坏|Reset the corrupt/ })
  await confirmation.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
  expect(resets).toBe(0)
  await recover.click()
  await confirmation.getByRole('button', { name: /^(确定|Confirm)$/ }).click()
  await expect.poll(() => resets).toBe(1)
  await expect(dictionary.getByRole('alert')).toHaveCount(0)
  await dictionary.getByRole('textbox', { name: /^(词语|Word)$/ }).fill('天姥')
  await dictionary.getByRole('textbox', { name: /正确拼音|Correct pinyin/ }).fill('tian1 mu3')
  await dictionary.getByRole('button', { name: /^(保存|Save)$/ }).click()
  await expect(dictionary).toContainText('天姥 · tian1 mu3')
  expect(mock.syntheses).toHaveLength(0)
})

test.describe('pronunciation correction with touch capability', () => {
  test.use({ hasTouch: true })

  test('Note editor and tablet reader correct selected pronunciation without editing or starting speech', async ({ page, request }) => {
    const documentPath = `inbox/pronunciation-${randomUUID()}`
    const created: string[] = []
    const mock = await mockSpeech(page, true)
    const source = '# 诗词\n\n天姥连天向天横。'
    try {
      await createDoc(request, documentPath, source, created)
      await gotoVaultReady(page)
      await openDoc(page, documentPath)
      const host = page.locator('.monaco-host')
      await expect.poll(() => host.evaluate((element) => Boolean((element as any).__vueParentComponent.setupState.editor.getAction('nuvyn.correct-note-pronunciation')))).toBe(true)
      const point = await host.evaluate((element) => {
        const editor = (element as any).__vueParentComponent.setupState.editor
        editor.setSelection({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 3 })
        editor.focus()
        const visible = editor.getScrolledVisiblePosition({ lineNumber: 3, column: 2 })
        const bounds = editor.getDomNode().getBoundingClientRect()
        return { x: bounds.left + visible.left + 1, y: bounds.top + visible.top + visible.height / 2 }
      })
      await page.mouse.click(point.x, point.y, { button: 'right' })
      const action = page.getByRole('menuitem', { name: /纠正发音|Correct pronunciation/ })
      await expect(action).toBeVisible()
      await action.hover()
      await page.keyboard.press('Enter')
      let dictionary = page.getByTestId('speech-pronunciations')
      await expect(dictionary).toBeVisible()
      await expect(dictionary.getByRole('textbox', { name: /^(词语|Word)$/ })).toHaveValue('天姥')
      await dictionary.getByRole('textbox', { name: /正确拼音|Correct pinyin/ }).fill('tian1 mu3')
      await dictionary.getByRole('button', { name: /^(保存|Save)$/ }).click()
      await expect(dictionary).toHaveCount(0)
      expect(mock.syntheses).toHaveLength(0)
      expect(await host.evaluate((element) => {
        const editor = (element as any).__vueParentComponent.setupState.editor
        return { value: editor.getValue(), selected: editor.getModel().getValueInRange(editor.getSelection()) }
      })).toEqual({ value: source, selected: '天姥' })
      await page.setViewportSize({ width: 768, height: 1024 })
      await page.getByTestId('view-toggle').click()
      const paragraph = page.locator('.reading-pane .article p').filter({ hasText: '天姥连天向天横。' })
      await paragraph.evaluate((element) => {
        const range = document.createRange()
        range.setStart(element.firstChild!, 0)
        range.setEnd(element.firstChild!, 2)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
      await page.getByTestId('note-reading-selection-actions').getByRole('button', { name: /纠正发音|Correct pronunciation/ }).tap()
      dictionary = page.getByTestId('speech-pronunciations')
      await expect(dictionary.getByRole('textbox', { name: /正确拼音|Correct pinyin/ })).toHaveValue('tian1 mu3')
      expect(mock.syntheses).toHaveLength(0)
      await page.keyboard.press('Escape')
      await expect(dictionary).toHaveCount(0)
      await expect(paragraph).toHaveText('天姥连天向天横。')
    } finally { await cleanupCreatedPaths(request, created) }
  })
})
