// @vitest-environment jsdom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BoardMaterialPanel from '../BoardMaterialPanel.vue'
import { boardMaterialSource } from '../../../features/board/boardMaterialSource'
import type { BoardMaterial } from '../../../../shared/boardMaterialProtocol'

const mocks = vi.hoisted(() => ({
  listBoardMaterials: vi.fn(),
  createBoardMaterial: vi.fn(),
  renameBoardMaterial: vi.fn(),
  archiveBoardMaterial: vi.fn(),
  restoreBoardMaterial: vi.fn(),
  deleteBoardMaterial: vi.fn(),
  confirm: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  BoardApiError: class BoardApiError extends Error {
    readonly status = 500
    readonly code = 'BOARD_API_ERROR'
    readonly uncertain: boolean

    constructor(message: string, uncertain = false) {
      super(message)
      this.uncertain = uncertain
    }
  },
}))

vi.mock('../../../features/board/api', () => mocks)
vi.mock('../../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: mocks.confirm }),
}))
vi.mock('../../../composables/useToast', () => ({
  useToast: () => ({ success: mocks.toastSuccess, error: mocks.toastError }),
}))
vi.mock('../../../composables/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

const SVG = '<svg viewBox="0 0 16 16"><path d="M0 8h16" /></svg>'

function material(id: string, archived = false): BoardMaterial {
  return { id, name: id, kind: 'svg', svg: SVG, archived, createdAt: 1, updatedAt: 2 }
}

async function settle(): Promise<void> {
  await flushPromises()
  await flushPromises()
}

async function mountPanel(): Promise<VueWrapper> {
  const wrapper = mount(BoardMaterialPanel, {
    attachTo: document.body,
    global: { stubs: { transition: false } },
  })
  await settle()
  return wrapper
}

function setSelectedFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function materialCard(wrapper: VueWrapper, id: string) {
  const card = wrapper.find(`.board-material-card[data-material-id="${id}"]`)
  if (!card.exists()) throw new Error(`Missing material card ${id}`)
  return card
}

async function openMaterialMenu(wrapper: VueWrapper, id: string): Promise<void> {
  await materialCard(wrapper, id).get('.board-material-menu').trigger('click')
  await settle()
}

async function chooseMenuOption(label: string): Promise<void> {
  const option = [...document.body.querySelectorAll<HTMLElement>('.n-dropdown-option')].reverse()
    .find((item) => item.textContent?.trim() === label)
  if (!option) throw new Error(`Missing material menu option ${label}`)
  ;(option.querySelector<HTMLElement>('.n-dropdown-option-body') ?? option).click()
  await settle()
}

async function openAddModal(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('.board-material-panel-footer button').trigger('click')
  await settle()
}

beforeEach(() => {
  boardMaterialSource.invalidate()
  mocks.listBoardMaterials.mockReset().mockImplementation(async (archived: boolean) => archived
    ? [material('archived-arrow', true)]
    : [material('arrow'), material('circle')])
  mocks.createBoardMaterial.mockReset()
  mocks.renameBoardMaterial.mockReset()
  mocks.archiveBoardMaterial.mockReset()
  mocks.restoreBoardMaterial.mockReset()
  mocks.deleteBoardMaterial.mockReset()
  mocks.confirm.mockReset().mockResolvedValue(true)
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
})

afterEach(() => {
  boardMaterialSource.invalidate()
  document.body.innerHTML = ''
})

describe('BoardMaterialPanel', () => {
  it('loads both scopes, searches the current scope, and keeps the menu separate from insert', async () => {
    const wrapper = await mountPanel()

    expect(mocks.listBoardMaterials).toHaveBeenCalledWith(false)
    expect(mocks.listBoardMaterials).toHaveBeenCalledWith(true)
    expect(wrapper.findAll('.board-material-card-open')).toHaveLength(2)
    expect(wrapper.findAll('.board-material-card-open img')).toHaveLength(2)
    expect(wrapper.find('.board-material-card-open img').attributes('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)

    await wrapper.get('.n-input[aria-label="board.materials_search"] input').setValue('arrow')
    expect(wrapper.findAll('.board-material-card-open')).toHaveLength(1)

    await wrapper.get('.board-material-menu').trigger('click')
    expect(wrapper.emitted('insert')).toBeUndefined()

    await wrapper.get('.board-material-card-open').trigger('click')
    expect(wrapper.emitted('insert')).toEqual([[material('arrow')]])

    await wrapper.findAll('.board-material-scope button')[1]!.trigger('click')
    expect(wrapper.findAll('.board-material-card-open')).toHaveLength(1)
    expect(wrapper.get('.board-material-card-open').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('reads a valid SVG file, derives its name, and keeps an invalid file in the modal', async () => {
    const wrapper = await mountPanel()
    await wrapper.get('.board-material-panel-footer button').trigger('click')

    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    if (!input) throw new Error('Missing file input')
    setSelectedFile(input, new File([SVG], 'mysql-database.svg', { type: 'image/svg+xml' }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    const modal = document.body.querySelector('.board-material-add-modal')
    expect(modal).not.toBeNull()
    expect(modal?.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect((modal?.querySelector('.n-input[aria-label="board.materials_name"] input') as HTMLInputElement | null)?.value)
      .toBe('mysql-database')

    setSelectedFile(input, new File(['not svg'], 'invalid.svg', { type: 'image/svg+xml' }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(document.body.querySelector('.board-material-error')?.textContent).toBe('board.materials_invalid_svg')
    wrapper.unmount()
  })

  it('renames an active material successfully', async () => {
    const wrapper = await mountPanel()
    const renamed = { ...material('arrow'), name: 'Renamed', updatedAt: 3 }
    mocks.renameBoardMaterial.mockResolvedValueOnce(renamed)

    await openMaterialMenu(wrapper, 'arrow')
    await chooseMenuOption('board.materials_rename')
    const input = wrapper.get('[data-material-rename-input="arrow"]')
    await input.setValue('Renamed')
    await input.trigger('keydown', { key: 'Enter' })
    await settle()

    expect(mocks.renameBoardMaterial).toHaveBeenCalledWith('arrow', 'Renamed')
    expect(wrapper.get('[data-material-id="arrow"] strong').text()).toBe('Renamed')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('board.materials_renamed')
    wrapper.unmount()
  })

  it('archives and restores a material through the active and archived scopes', async () => {
    const wrapper = await mountPanel()
    mocks.archiveBoardMaterial.mockResolvedValueOnce(material('arrow', true))
    mocks.restoreBoardMaterial.mockResolvedValueOnce(material('archived-arrow', false))

    await openMaterialMenu(wrapper, 'arrow')
    await chooseMenuOption('board.materials_archive')
    expect(mocks.archiveBoardMaterial).toHaveBeenCalledWith('arrow')
    expect(wrapper.find('[data-material-id="arrow"]').exists()).toBe(false)

    await wrapper.findAll('.board-material-scope button')[1]!.trigger('click')
    await openMaterialMenu(wrapper, 'archived-arrow')
    await chooseMenuOption('board.materials_restore')
    expect(mocks.restoreBoardMaterial).toHaveBeenCalledWith('archived-arrow')
    expect(wrapper.find('[data-material-id="archived-arrow"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('only offers permanent delete for archived materials and deletes them after confirmation', async () => {
    const wrapper = await mountPanel()

    await openMaterialMenu(wrapper, 'arrow')
    expect([...document.body.querySelectorAll('.n-dropdown-option')].map((item) => item.textContent?.trim()))
      .not.toContain('board.materials_delete')

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wrapper.findAll('.board-material-scope button')[1]!.trigger('click')
    mocks.deleteBoardMaterial.mockResolvedValueOnce(undefined)
    await openMaterialMenu(wrapper, 'archived-arrow')
    await chooseMenuOption('board.materials_delete')

    expect(mocks.confirm).toHaveBeenCalledOnce()
    expect(mocks.deleteBoardMaterial).toHaveBeenCalledWith('archived-arrow')
    expect(wrapper.find('[data-material-id="archived-arrow"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps different material mutations independent and same-material mutations busy', async () => {
    const wrapper = await mountPanel()
    const arrow = deferred<BoardMaterial>()
    const circle = deferred<BoardMaterial>()
    mocks.archiveBoardMaterial.mockImplementation((id: string) => id === 'arrow' ? arrow.promise : circle.promise)

    await openMaterialMenu(wrapper, 'arrow')
    await chooseMenuOption('board.materials_archive')
    await openMaterialMenu(wrapper, 'circle')
    await chooseMenuOption('board.materials_archive')

    expect(materialCard(wrapper, 'arrow').get('.board-material-menu').attributes('disabled')).toBeDefined()
    expect(materialCard(wrapper, 'circle').get('.board-material-menu').attributes('disabled')).toBeDefined()
    expect(materialCard(wrapper, 'circle').get('.board-material-card-open').attributes('disabled')).toBeDefined()

    arrow.resolve(material('arrow', true))
    await settle()
    expect(wrapper.find('[data-material-id="arrow"]').exists()).toBe(false)
    expect(materialCard(wrapper, 'circle').get('.board-material-menu').attributes('disabled')).toBeDefined()

    circle.resolve(material('circle', true))
    await settle()
    expect(wrapper.find('[data-material-id="circle"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('releases a material mutation after failure and shows one stable error toast', async () => {
    const wrapper = await mountPanel()
    mocks.archiveBoardMaterial.mockRejectedValueOnce(new Error('internal Excalidraw failure'))

    await openMaterialMenu(wrapper, 'arrow')
    await chooseMenuOption('board.materials_archive')
    await settle()

    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledWith('board.materials_archive_failed')
    expect(materialCard(wrapper, 'arrow').get('.board-material-menu').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('refreshes the authoritative snapshot after an uncertain rename', async () => {
    const wrapper = await mountPanel()
    mocks.renameBoardMaterial.mockRejectedValueOnce(new mocks.BoardApiError('network failed', true))
    mocks.listBoardMaterials.mockImplementation(async (archived: boolean) => archived
      ? [material('archived-arrow', true)]
      : [material('server-renamed')])

    await openMaterialMenu(wrapper, 'arrow')
    await chooseMenuOption('board.materials_rename')
    await wrapper.get('[data-material-rename-input="arrow"]').setValue('Renamed')
    await wrapper.get('[data-material-rename-input="arrow"]').trigger('keydown', { key: 'Enter' })
    await settle()

    expect(wrapper.find('[data-material-id="server-renamed"]').exists()).toBe(true)
    expect(wrapper.find('[data-material-id="arrow"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('refreshes the authoritative snapshot after an uncertain archive', async () => {
    const wrapper = await mountPanel()
    mocks.archiveBoardMaterial.mockRejectedValueOnce(new mocks.BoardApiError('network failed', true))
    mocks.listBoardMaterials.mockImplementation(async (archived: boolean) => archived
      ? [material('arrow', true), material('archived-arrow', true)]
      : [material('circle')])

    await openMaterialMenu(wrapper, 'arrow')
    await chooseMenuOption('board.materials_archive')
    await settle()

    expect(wrapper.find('[data-material-id="arrow"]').exists()).toBe(false)
    await wrapper.findAll('.board-material-scope button')[1]!.trigger('click')
    expect(wrapper.find('[data-material-id="arrow"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('refreshes the authoritative snapshot after an uncertain restore', async () => {
    const wrapper = await mountPanel()
    mocks.restoreBoardMaterial.mockRejectedValueOnce(new mocks.BoardApiError('network failed', true))
    mocks.listBoardMaterials.mockImplementation(async (archived: boolean) => archived
      ? [material('arrow', true)]
      : [material('restored-arrow')])

    await wrapper.findAll('.board-material-scope button')[1]!.trigger('click')
    await openMaterialMenu(wrapper, 'archived-arrow')
    await chooseMenuOption('board.materials_restore')
    await settle()

    expect(wrapper.find('[data-material-id="archived-arrow"]').exists()).toBe(false)
    await wrapper.findAll('.board-material-scope button')[0]!.trigger('click')
    expect(wrapper.find('[data-material-id="restored-arrow"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('refreshes the authoritative snapshot after an uncertain permanent delete', async () => {
    const wrapper = await mountPanel()
    mocks.deleteBoardMaterial.mockRejectedValueOnce(new mocks.BoardApiError('network failed', true))
    mocks.listBoardMaterials.mockImplementation(async (archived: boolean) => archived
      ? []
      : [material('arrow'), material('circle')])

    await wrapper.findAll('.board-material-scope button')[1]!.trigger('click')
    await openMaterialMenu(wrapper, 'archived-arrow')
    await chooseMenuOption('board.materials_delete')
    await settle()

    expect(wrapper.find('[data-material-id="archived-arrow"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('refreshes the authoritative snapshot after an uncertain create', async () => {
    const wrapper = await mountPanel()
    mocks.createBoardMaterial.mockRejectedValueOnce(new mocks.BoardApiError('network failed', true))
    mocks.listBoardMaterials.mockImplementation(async (archived: boolean) => archived
      ? [material('archived-arrow', true)]
      : [material('created')])

    await openAddModal(wrapper)
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement
    setSelectedFile(input, new File([SVG], 'created.svg', { type: 'image/svg+xml' }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    const nameInput = document.body.querySelector<HTMLInputElement>('.board-material-add-modal .n-input[aria-label="board.materials_name"] input')
    if (!nameInput) throw new Error('Missing add material name input')
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()

    expect(wrapper.find('[data-material-id="created"]').exists()).toBe(true)
    expect(document.body.querySelector('.board-material-error')?.textContent).toBe('board.materials_create_failed')
    wrapper.unmount()
  })

  it('only submits the add modal from the name input and preserves IME guards', async () => {
    const wrapper = await mountPanel()
    await openAddModal(wrapper)
    const chooseFile = document.body.querySelector<HTMLElement>('[data-testid="board-material-choose-file"]')
    expect(chooseFile).not.toBeNull()
    chooseFile?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(mocks.createBoardMaterial).not.toHaveBeenCalled()
    expect(document.body.querySelector('.board-material-add-modal')).not.toBeNull()

    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement
    setSelectedFile(input, new File([SVG], 'mysql.svg', { type: 'image/svg+xml' }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    const nameInput = document.body.querySelector<HTMLInputElement>('.board-material-add-modal .n-input[aria-label="board.materials_name"] input')
    expect(nameInput).not.toBeNull()
    if (!nameInput) throw new Error('Missing add material name input')
    mocks.createBoardMaterial.mockResolvedValueOnce(material('mysql'))
    nameInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(mocks.createBoardMaterial).not.toHaveBeenCalled()
    nameInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })
    nameInput.dispatchEvent(composingEnter)
    expect(mocks.createBoardMaterial).not.toHaveBeenCalled()

    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(mocks.createBoardMaterial).toHaveBeenCalledWith('mysql', SVG)
    wrapper.unmount()
  })

  it('does not submit when Enter is pressed on add modal actions and closes from Cancel', async () => {
    const wrapper = await mountPanel()
    await openAddModal(wrapper)

    const cancel = document.body.querySelector<HTMLElement>('[data-testid="board-material-add-cancel"]')
    expect(cancel).not.toBeNull()
    cancel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()

    expect(mocks.createBoardMaterial).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(document.body.querySelector('.board-material-add-modal')).toBeNull())
    wrapper.unmount()
  })
})
