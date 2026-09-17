// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DocumentSavePresentation } from '../../../composables/vault/editor-tabs/savePresentation'
import { useI18n } from '../../../composables/useI18n'
import StatusBar from '../StatusBar.vue'

function save(overrides: Partial<DocumentSavePresentation> = {}): DocumentSavePresentation {
  return {
    status: 'idle',
    dirty: false,
    inFlight: false,
    hasNewerChanges: false,
    retryable: false,
    attention: false,
    ...overrides,
  }
}

function mountBar(presentation: DocumentSavePresentation, error: string | null = null) {
  return mount(StatusBar, {
    props: {
      path: 'inbox/test',
      save: presentation,
      error,
      size: 10,
      focusWidth: false,
    },
  })
}

describe('StatusBar save presentation', () => {
  beforeEach(() => useI18n().setLocale('en'))

  it('distinguishes saving from saving with newer unsaved changes', () => {
    const saving = mountBar(save({ status: 'saving', dirty: true, inFlight: true }))
    expect(saving.get('.sb-status').attributes('data-status')).toBe('saving')
    expect(saving.get('.sb-status').text()).toBe('Saving…')

    const savingDirty = mountBar(save({
      status: 'saving-dirty',
      dirty: true,
      inFlight: true,
      hasNewerChanges: true,
    }))
    expect(savingDirty.get('.sb-status').attributes('data-status')).toBe('saving-dirty')
    expect(savingDirty.get('.sb-status').text()).toContain('newer changes pending')
    expect(savingDirty.find('.sb-status-retry').exists()).toBe(false)
    expect(savingDirty.find('[aria-label="Copy current document content"]').exists()).toBe(true)
  })

  it.each(['error', 'offline'] as const)('keeps retry available for %s', (status) => {
    const wrapper = mountBar(save({ status, dirty: true, retryable: true, attention: true }), 'Full failure detail')
    const retry = wrapper.get('.sb-status-retry')
    expect(retry.attributes('data-status')).toBe(status)
    expect(retry.attributes('aria-label')).toBe('Save failed, click to retry')
    if (status === 'error') expect(retry.attributes('title')).toContain('Full failure detail')
  })

  it('preserves all external-conflict actions', async () => {
    const wrapper = mountBar(save({ status: 'external', dirty: true, attention: true }))
    for (const label of [
      'View local and disk differences',
      'Use disk version',
      'Keep local version and overwrite disk',
    ]) {
      expect(wrapper.find(`[aria-label="${label}"]`).exists()).toBe(true)
    }
  })

  it('hides the unavailable disk action for a deleted document', () => {
    const wrapper = mount(StatusBar, {
      props: {
        path: 'inbox/test',
        save: save({ status: 'external', attention: true }),
        error: 'deleted',
        size: 10,
        focusWidth: false,
        externalKind: 'deleted',
      },
    })
    expect(wrapper.find('[aria-label="Use disk version"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="View local and disk differences"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Keep local version and overwrite disk"]').exists()).toBe(true)
  })

  it('does not offer a misleading diff while the disk version is unreadable', () => {
    const wrapper = mount(StatusBar, {
      props: {
        path: 'inbox/test',
        save: save({ status: 'external', attention: true }),
        error: 'unreadable',
        size: 10,
        focusWidth: false,
        externalKind: 'unreadable',
      },
    })
    expect(wrapper.find('[aria-label="View local and disk differences"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="Use disk version"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Keep local version and overwrite disk"]').exists()).toBe(true)
  })

  it('announces the complete status atomically and uses presentation data-status', () => {
    const wrapper = mountBar(save({ status: 'saved' }))
    expect(wrapper.get('.sb-left').attributes('aria-live')).toBe('polite')
    expect(wrapper.get('.sb-left').attributes('aria-atomic')).toBe('true')
    expect(wrapper.get('.sb-status').attributes('data-status')).toBe('saved')
  })
})
