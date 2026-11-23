// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useAiHistory } from '../../../composables/vault/useAiHistory'
import AiSessionPicker from '../AiSessionPicker.vue'

vi.mock('../../../composables/vault/useAiHistory', async () => {
  const { ref } = await import('vue')
  const history = {
    activeSession: ref(null),
    sessions: ref([]),
    busy: ref(false),
    isLoading: ref(false),
    refreshSessions: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
  }
  return { useAiHistory: () => history }
})

const history = useAiHistory()
enableAutoUnmount(afterEach)

async function editTitle(value: string) {
  const wrapper = mount(AiSessionPicker, { attachTo: document.body })
  const dialog = document.querySelector<HTMLElement>('.ai-sp-dialog')!
  const close = dialog.querySelector<HTMLButtonElement>('.ai-sp-close')!
  expect(document.activeElement).toBe(close)
  dialog.querySelector<HTMLButtonElement>('.ai-sp-action')!.click()
  await nextTick()
  const input = dialog.querySelector('input')!
  // jsdom does not apply native autofocus on dynamically inserted inputs.
  input.focus()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return { wrapper, close, input, dialog }
}

function press(target: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('AI session picker keyboard events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    history.sessions.value = [{ id: 21, title: 'Original', createdAt: 1, updatedAt: 1 }]
    history.activeSession.value = history.sessions.value[0]!
  })

  it('consumes Escape in the input, cancels the edit, and keeps focus inside the picker', async () => {
    const { wrapper, close, input, dialog } = await editTitle('Discarded')
    const documentKeydown = vi.fn()
    document.addEventListener('keydown', documentKeydown)
    try {
      expect(press(input, 'Escape').defaultPrevented).toBe(true)
      input.blur()
      await nextTick()
      expect(documentKeydown).not.toHaveBeenCalled()
      expect(history.renameSession).not.toHaveBeenCalled()
      expect(dialog.querySelector('.ai-sp-name')?.textContent).toBe('Original')
      expect(document.activeElement).toBe(close)
      expect(wrapper.emitted('close')).toBeUndefined()

      press(close, 'Escape')
      expect(wrapper.emitted('close')).toHaveLength(1)
      expect(documentKeydown).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', documentKeydown)
    }
  })

  it('commits once when Enter is followed by Blur', async () => {
    const { wrapper, close, input } = await editTitle('  Updated  ')
    expect(press(input, 'Enter').defaultPrevented).toBe(true)
    input.blur()
    await nextTick()

    expect(history.renameSession).toHaveBeenCalledExactlyOnceWith(21, 'Updated')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(document.activeElement).toBe(close)
  })

  it('still commits on Blur and leaves focus on the control the user chose', async () => {
    const { close } = await editTitle('Updated by blur')
    close.focus()
    await nextTick()

    expect(history.renameSession).toHaveBeenCalledExactlyOnceWith(21, 'Updated by blur')
    expect(document.activeElement).toBe(close)
  })
})
