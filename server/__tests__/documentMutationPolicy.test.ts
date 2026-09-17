import { describe, expect, it } from 'vitest'
import { validateDocumentMutation, validateFolderMutation } from '../documentMutationPolicy'

const allowed = (mutation: Parameters<typeof validateDocumentMutation>[0]) =>
  expect(() => validateDocumentMutation(mutation)).not.toThrow()
const blocked = (mutation: Parameters<typeof validateDocumentMutation>[0], message: RegExp) =>
  expect(() => validateDocumentMutation(mutation)).toThrow(message)

describe('server document mutation policy', () => {
  it('allows archive descendants through every document mutation path', () => {
    allowed({ operation: 'create', destinationPath: 'archive/new' })
    allowed({ operation: 'write', destinationPath: 'archive/new', destinationExists: false })
    allowed({ operation: 'write', destinationPath: 'archive/existing', destinationExists: true })
    allowed({ operation: 'delete', sourcePath: 'archive/existing' })
    allowed({ operation: 'rename', sourcePath: 'archive/a', destinationPath: 'archive/b' })
    allowed({ operation: 'rename', sourcePath: 'archive/a', destinationPath: 'literature/a' })
    allowed({ operation: 'rename', sourcePath: 'literature/a', destinationPath: 'archive/a' })
  })

  it('blocks every generic document destination inside the Diary namespace', () => {
    for (const destinationPath of ['diary/foo']) {
      blocked(
        { operation: 'rename', sourcePath: 'inbox/foo', destinationPath },
        /Diary namespace/,
      )
    }
    blocked(
      { operation: 'rename', sourcePath: 'inbox/foo', destinationPath: 'diary' },
      /protected root/,
    )

    blocked(
      { operation: 'rename', sourcePath: 'archive/foo', destinationPath: 'diary/foo' },
      /Diary namespace/,
    )
    blocked(
      { operation: 'rename', sourcePath: 'ledger/foo', destinationPath: 'diary/foo' },
      /Diary namespace/,
    )
    blocked(
      { operation: 'rename', sourcePath: 'inbox/foo', destinationPath: 'diary/2026-08-24' },
      /cannot change identity/,
    )
    allowed({ operation: 'rename', sourcePath: 'diary/foo', destinationPath: 'inbox/foo' })
    allowed({ operation: 'rename', sourcePath: 'inbox/foo', destinationPath: 'archive/foo' })
    allowed({ operation: 'rename', sourcePath: 'inbox/foo', destinationPath: 'literature/foo' })
  })

  it('reserves the system root names without restricting descendants', () => {
    blocked({ operation: 'create', destinationPath: 'archive' }, /protected root/)
    blocked({ operation: 'write', destinationPath: 'archive', destinationExists: true }, /protected root/)
    blocked({ operation: 'delete', sourcePath: 'archive' }, /protected root/)
    blocked({ operation: 'rename', sourcePath: 'archive', destinationPath: 'archive-renamed' }, /protected root/)
    blocked({ operation: 'rename', sourcePath: 'notes/a', destinationPath: 'archive' }, /protected root/)
  })

  it('requires the Diary date command or trusted history provenance for Diary creation', () => {
    blocked({ operation: 'create', destinationPath: 'diary/foo' }, /date command/)
    blocked({ operation: 'create', destinationPath: 'diary/2026-08-24' }, /date command/)
    blocked({ operation: 'write', destinationPath: 'diary/2026-08-24', destinationExists: false }, /date command/)
    allowed({ operation: 'write', destinationPath: 'diary/2026-08-24', destinationExists: true })
    allowed({ operation: 'recover', destinationPath: 'inbox/recovered' })
    blocked({ operation: 'recover', destinationPath: 'diary/2026-08-24' }, /verified prior identity/)
    blocked({ operation: 'recover', destinationPath: 'diary/recovered' }, /verified prior identity/)
    allowed({ operation: 'history-restore', destinationPath: 'diary/2026-08-24' })
    blocked({ operation: 'history-restore', destinationPath: 'diary/recovered' }, /managed date identity/)
  })

  it('allows managed Diary content writes/deletes but blocks identity changes', () => {
    allowed({ operation: 'delete', sourcePath: 'diary/2026-08-24' })
    blocked({ operation: 'rename', sourcePath: 'diary/2026-08-24', destinationPath: 'diary/2026-08-25' }, /cannot change identity/)
    blocked({ operation: 'rename', sourcePath: 'diary/2026-08-24', destinationPath: 'inbox/2026-08-24' }, /cannot change identity/)
    blocked({ operation: 'rename', sourcePath: 'inbox/note', destinationPath: 'diary/2026-08-24' }, /cannot change identity/)
  })

  it('preserves generic management for unmanaged Diary content', () => {
    allowed({ operation: 'write', destinationPath: 'diary/foo', destinationExists: true })
    allowed({ operation: 'delete', sourcePath: 'diary/foo' })
    allowed({ operation: 'rename', sourcePath: 'diary/foo', destinationPath: 'inbox/foo' })
    blocked({ operation: 'rename', sourcePath: 'diary/foo', destinationPath: 'diary/2026-08-24' }, /cannot change identity/)
  })

  it('blocks nested Diary folder creation while retaining root protection', () => {
    expect(() => validateFolderMutation({ operation: 'create', path: 'diary' })).toThrow(/protected root/)
    expect(() => validateFolderMutation({ operation: 'create', path: 'diary/2026' })).toThrow(/folders cannot be created/)
    expect(() => validateFolderMutation({ operation: 'rename', sourcePath: 'diary', destinationPath: 'inbox/diary' })).toThrow(/protected root/)
    expect(() => validateFolderMutation({ operation: 'delete', path: 'diary' })).toThrow(/protected root/)
  })
})
