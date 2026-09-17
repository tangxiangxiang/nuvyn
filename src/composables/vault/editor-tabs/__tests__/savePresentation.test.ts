import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../components/vault/tabs'
import { deriveDocumentSavePresentation } from '../savePresentation'

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    path: 'inbox/test',
    title: 'Test',
    raw: 'saved',
    originalRaw: 'saved',
    revision: 1,
    savedRevision: 1,
    savingRevision: null,
    saveStatus: 'idle',
    error: null,
    loadError: null,
    loading: false,
    serverMtime: 1,
    ...overrides,
  }
}

describe('deriveDocumentSavePresentation', () => {
  it.each([
    ['null tab', null, 'idle', false, false, false],
    ['clean idle', tab(), 'idle', false, false, false],
    ['dirty', tab({ raw: 'changed', revision: 2, saveStatus: 'dirty' }), 'dirty', true, false, false],
    ['saving current revision', tab({ raw: 'changed', revision: 2, savingRevision: 2, saveStatus: 'saving' }), 'saving', true, true, false],
    ['saving a stale revision', tab({ raw: 'newer', revision: 3, savingRevision: 2, saveStatus: 'dirty' }), 'saving-dirty', true, true, true],
    ['clean saved', tab({ saveStatus: 'saved' }), 'saved', false, false, false],
    ['dirty error', tab({ raw: 'changed', revision: 2, saveStatus: 'error' }), 'error', true, false, false],
    ['dirty offline', tab({ raw: 'changed', revision: 2, saveStatus: 'offline' }), 'offline', true, false, false],
    ['dirty external', tab({ raw: 'changed', revision: 2, saveStatus: 'external' }), 'external', true, false, false],
  ] as const)(
    '%s',
    (_name, input, status, dirty, inFlight, hasNewerChanges) => {
      expect(deriveDocumentSavePresentation(input)).toMatchObject({
        status,
        dirty,
        inFlight,
        hasNewerChanges,
      })
    },
  )

  it('prioritizes external, offline, and error over in-flight presentation', () => {
    for (const status of ['external', 'offline', 'error'] as const) {
      expect(deriveDocumentSavePresentation(tab({
        raw: 'newer',
        revision: 3,
        savingRevision: 2,
        saveStatus: status,
      })).status).toBe(status)
    }
  })

  it('uses savingRevision as the in-flight truth even when runtime status is dirty', () => {
    expect(deriveDocumentSavePresentation(tab({
      raw: 'v2',
      originalRaw: 'saved',
      revision: 2,
      savedRevision: 0,
      savingRevision: 1,
      saveStatus: 'dirty',
    }))).toMatchObject({
      status: 'saving-dirty',
      dirty: true,
      inFlight: true,
      hasNewerChanges: true,
    })
  })

  it('does not report newer changes when the current content is back at its baseline', () => {
    expect(deriveDocumentSavePresentation(tab({
      revision: 3,
      savedRevision: 3,
      savingRevision: 2,
      saveStatus: 'dirty',
    }))).toMatchObject({
      status: 'saving',
      dirty: false,
      inFlight: true,
      hasNewerChanges: false,
    })
  })

  it('derives retry and attention flags from presentation priority', () => {
    expect(deriveDocumentSavePresentation(tab({ saveStatus: 'error' }))).toMatchObject({ retryable: true, attention: true })
    expect(deriveDocumentSavePresentation(tab({ saveStatus: 'offline' }))).toMatchObject({ retryable: true, attention: true })
    expect(deriveDocumentSavePresentation(tab({ saveStatus: 'external' }))).toMatchObject({ retryable: false, attention: true })
    expect(deriveDocumentSavePresentation(tab({ raw: 'changed', revision: 2 }))).toMatchObject({ retryable: false, attention: false })
  })
})
