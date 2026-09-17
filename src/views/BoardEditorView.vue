<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import ExcalidrawHost from '../components/board/ExcalidrawHost.vue'
import BoardMaterialPanel from '../components/board/BoardMaterialPanel.vue'
import {
  BoardApiError,
  createBoard,
  deleteBoard,
  getBoard,
  getBoardMetadata,
  renameBoard,
  saveBoardScene,
  type BoardAggregate,
} from '../features/board/api'
import { boardMetadataSource } from '../features/board/boardMetadataSource'
import { boardFolderSource } from '../features/board/folderSource'
import {
  assertSupportedExcalidrawScene,
  excalidrawAdapter,
  runtimePersistenceFingerprint,
} from '../features/board/engine/excalidrawAdapter'
import {
  BoardEngineCompatibilityError,
  type BoardRuntimeAsset,
  type ExcalidrawRuntimeScene,
} from '../features/board/engine/types'
import { useI18n } from '../composables/useI18n'
import { useTheme } from '../composables/useTheme'
import { useToast } from '../composables/useToast'
import { useConfirm } from '../composables/useConfirm'
import {
  createIndexedDbBoardCheckpointStore,
  BoardRecoveryStoreError,
  type BoardCheckpointStore,
} from '../features/board/checkpointStore'
import { createBoardCheckpointScheduler, type BoardCheckpointScheduler } from '../features/board/checkpointScheduler'
import { reconcileBoardCheckpoint, type BoardCheckpointReconciliation } from '../features/board/checkpointReconciliation'
import type { BoardCheckpoint } from '../features/board/recoveryTypes'
import { createBoardAssetSession, type BoardAssetSession } from '../features/board/assetSession'
import { BoardAssetError } from '../features/board/assetClient'
import { boardExportFilename, downloadBoardBlob, type BoardExportFormat } from '../features/board/boardExport'
import { createBoardThumbnailScheduler, type BoardThumbnailScheduler } from '../features/board/thumbnailScheduler'
import {
  createBoardSaveCoordinator,
  type BoardSaveCoordinator,
  type BoardSaveState,
} from '../features/board/saveCoordinator'
import { useBoardFavorites } from '../composables/useBoardFavorites'
import type { BoardEditorMenuOptions } from '../features/board/engine/excalidraw/reactIsland'
import type { BoardMaterial } from '../../shared/boardMaterialProtocol'

type EditorStatus = 'loading' | 'reconciling' | 'recovery-choice' | 'recovery-conflict' | 'hydrating' | 'ready' | 'error'
type EditorErrorKind = 'load' | 'not-found' | 'compatibility' | 'corrupt' | 'canvas' | 'recovery'

interface PendingRecovery {
  kind: 'choice' | 'conflict' | 'invalid' | 'read-error'
  aggregate: BoardAggregate
  checkpoint: BoardCheckpoint | null
  reason: string
}

interface BoardSession {
  boardId: string
  serverRevision: number
  baseRevision: number
  localRevision: number
}

interface BoardDeleteLifecycleSnapshot {
  currentSaveCoordinator: BoardSaveCoordinator<ExcalidrawRuntimeScene> | null
  currentThumbnailScheduler: BoardThumbnailScheduler<ExcalidrawRuntimeScene> | null
  currentCheckpointScheduler: BoardCheckpointScheduler<ExcalidrawRuntimeScene> | null
  currentAssetSession: BoardAssetSession | null
  currentAssetIntakePromise: Promise<void>
  currentHostChangePromise: Promise<void>
}

const route = useRoute()
const router = useRouter()
const { locale, t } = useI18n()
const { theme } = useTheme()
const toast = useToast()
const { confirm } = useConfirm()
const { isFavorite, setFavorite } = useBoardFavorites()
const status = ref<EditorStatus>('loading')
const errorKind = ref<EditorErrorKind | null>(null)
const errorMessage = ref('')
const errorMetadata = shallowRef<BoardAggregate['metadata'] | null>(null)
const aggregate = shallowRef<BoardAggregate | null>(null)
const session = shallowRef<BoardSession | null>(null)
const runtimeScene = shallowRef<ExcalidrawRuntimeScene | null>(null)
const saveCoordinator = shallowRef<BoardSaveCoordinator<ExcalidrawRuntimeScene> | null>(null)
const saveState = shallowRef<BoardSaveState | null>(null)
const checkpointScheduler = shallowRef<BoardCheckpointScheduler<ExcalidrawRuntimeScene> | null>(null)
const thumbnailScheduler = shallowRef<BoardThumbnailScheduler<ExcalidrawRuntimeScene> | null>(null)
const assetSession = shallowRef<BoardAssetSession | null>(null)
const pendingRecovery = shallowRef<PendingRecovery | null>(null)
const recoveryUnavailable = ref(false)
const exportBusy = ref<BoardExportFormat | null>(null)
const deleting = ref(false)
const renaming = ref(false)
const copying = ref(false)
const showMaterialPanel = ref(false)
const excalidrawHost = ref<{ insertMaterial: (material: BoardMaterial) => Promise<void> } | null>(null)
const loadGeneration = ref(0)
const recoveryStore: BoardCheckpointStore = createIndexedDbBoardCheckpointStore()
let assetIntakePromise: Promise<void> = Promise.resolve()
let hostChangePromise: Promise<void> = Promise.resolve()
let saveFailureNoticeKey: string | null = null
let librarySaveFailureNoticeShown = false
const assetFailureNoticeKeys = new Set<string>()
let goShortcutTimer: ReturnType<typeof setTimeout> | null = null

const boardId = computed(() => {
  const value = route.params.boardId
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
})
const boardTitle = computed(() => aggregate.value?.metadata.title ?? errorMetadata.value?.title ?? t('board.title'))
const favorite = computed(() => Boolean(session.value && isFavorite(session.value.boardId)))
const excalidrawLangCode = computed(() => locale.value.startsWith('zh') ? 'zh-CN' as const : 'en' as const)
const errorTitle = computed(() => {
  if (errorKind.value === 'not-found') return t('board.editor_not_found')
  if (errorKind.value === 'compatibility') return t('board.editor_scene_unsupported')
  if (errorKind.value === 'corrupt') return t('board.editor_scene_corrupt')
  if (errorKind.value === 'canvas') return t('board.editor_canvas_failed')
  if (errorKind.value === 'recovery') return t('board.editor_recovery_failed')
  return t('board.editor_load_failed')
})
const errorDescription = computed(() => errorMessage.value || errorTitle.value)

function errorInfo(error: unknown): { kind: EditorErrorKind; message: string } {
  if (error instanceof BoardApiError && (error.status === 404 || error.code === 'BOARD_NOT_FOUND')) {
    return { kind: 'not-found', message: error.message }
  }
  if (error instanceof BoardEngineCompatibilityError) {
    return { kind: 'compatibility', message: error.message }
  }
  if (error instanceof BoardApiError && error.code === 'BOARD_SCENE_CORRUPT') {
    return { kind: 'corrupt', message: error.message }
  }
  if (error instanceof BoardAssetError) {
    return { kind: 'load', message: t('board.editor_asset_restore_failed') }
  }
  return {
    kind: 'load',
    message: error instanceof Error && error.message.trim() ? error.message : t('board.editor_load_failed'),
  }
}

function assetFailureMessage(error: unknown, fallback: 'upload' | 'restore'): string {
  if (!(error instanceof BoardAssetError)) {
    return t(fallback === 'upload' ? 'board.editor_asset_upload_failed' : 'board.editor_asset_restore_failed')
  }
  switch (error.code) {
    case 'UNSUPPORTED_ASSET_MIME':
      return t('board.editor_asset_unsupported_mime')
    case 'ASSET_TOO_LARGE':
      return t('board.editor_asset_too_large')
    case 'ASSET_EMPTY_BODY':
      return t('board.editor_asset_invalid_content')
    case 'ASSET_MIME_MISMATCH':
      return t(error.mimeType === 'image/svg+xml'
        ? 'board.editor_asset_invalid_svg'
        : 'board.editor_asset_invalid_content')
    case 'ASSET_PENDING_INVALID':
      return t('board.editor_asset_local_cache_failed')
    case 'ASSET_MISSING':
    case 'ASSET_RESOLVE_FAILED':
      return t('board.editor_asset_restore_failed')
    default:
      return t('board.editor_asset_upload_failed')
  }
}

interface AssetFailureContext {
  assetId?: string
  engineFileId?: string
}

function assetFailureIdentity(error: unknown, context: AssetFailureContext = {}): string {
  if (error instanceof BoardAssetError && error.assetId) return error.assetId
  if (context.assetId) return context.assetId
  if (error instanceof BoardAssetError && error.engineFileId) return error.engineFileId
  if (context.engineFileId) return context.engineFileId
  return 'unknown'
}

function assetFailureCode(error: unknown): string {
  return error instanceof BoardAssetError ? error.code : 'ASSET_RUNTIME_ERROR'
}

function reportAssetFailure(
  error: unknown,
  fallback: 'upload' | 'restore',
  context: AssetFailureContext = {},
  allowTransient = false,
): void {
  if (error instanceof BoardAssetError && error.transient && !allowTransient) return
  const currentBoardId = session.value?.boardId ?? boardId.value
  const key = `${currentBoardId}:${assetFailureIdentity(error, context)}:${assetFailureCode(error)}`
  if (assetFailureNoticeKeys.has(key)) return
  assetFailureNoticeKeys.add(key)
  toast.error(assetFailureMessage(error, fallback))
}

function clearAssetFailure(context: AssetFailureContext): void {
  const currentBoardId = session.value?.boardId ?? boardId.value
  const prefix = `${currentBoardId}:${assetFailureIdentity(null, context)}:`
  for (const key of assetFailureNoticeKeys) {
    if (key.startsWith(prefix)) assetFailureNoticeKeys.delete(key)
  }
}

function fileMapForSession(currentAssetSession: BoardAssetSession): Readonly<Record<string, string>> {
  try {
    return currentAssetSession.getFileMap()
  } catch {
    return {}
  }
}

function contextsForRuntimeAssets(
  assets: readonly BoardRuntimeAsset[],
  currentAssetSession: BoardAssetSession,
): AssetFailureContext[] {
  const fileMap = fileMapForSession(currentAssetSession)
  return assets.map((asset) => ({
    engineFileId: asset.engineFileId,
    assetId: fileMap[asset.engineFileId],
  }))
}

function contextsForRuntimeScene(
  nextRuntimeScene: ExcalidrawRuntimeScene,
  currentAssetSession: BoardAssetSession,
): AssetFailureContext[] {
  const fileMap = fileMapForSession(currentAssetSession)
  const seen = new Set<string>()
  const contexts: AssetFailureContext[] = []
  for (const element of nextRuntimeScene.elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue
    const value = element as { type?: unknown; isDeleted?: unknown; fileId?: unknown }
    if (value.type !== 'image' || value.isDeleted === true || typeof value.fileId !== 'string' || seen.has(value.fileId)) continue
    seen.add(value.fileId)
    contexts.push({ engineFileId: value.fileId, assetId: fileMap[value.fileId] })
  }
  return contexts
}

function clearAssetFailures(contexts: readonly AssetFailureContext[]): void {
  for (const context of contexts) clearAssetFailure(context)
}

function showLoadError(error: unknown): void {
  const info = errorInfo(error)
  status.value = 'error'
  errorKind.value = info.kind
  errorMessage.value = info.message
  aggregate.value = null
  session.value = null
  runtimeScene.value = null
  disposePersistence()
}

function disposePersistence(): void {
  thumbnailScheduler.value?.dispose()
  thumbnailScheduler.value = null
  checkpointScheduler.value?.dispose()
  checkpointScheduler.value = null
  saveCoordinator.value?.dispose()
  saveCoordinator.value = null
  assetSession.value?.dispose()
  assetSession.value = null
  saveState.value = null
  saveFailureNoticeKey = null
  librarySaveFailureNoticeShown = false
  assetFailureNoticeKeys.clear()
}

async function flushAndDisposePersistence(): Promise<void> {
  const currentThumbnailScheduler = thumbnailScheduler.value
  const currentCheckpointScheduler = checkpointScheduler.value
  const currentSaveCoordinator = saveCoordinator.value
  const currentAssetSession = assetSession.value
  const currentAssetIntakePromise = assetIntakePromise
  const currentHostChangePromise = hostChangePromise

  try {
    await currentAssetIntakePromise.catch(() => {})
    await currentHostChangePromise.catch(() => {})
    const result = await currentSaveCoordinator?.flush()
    if (result && !result.ok && saveFailureNoticeKey === null) {
      toast.error(t('board.editor_save_failed_notice'))
    }
  } catch {
    if (saveFailureNoticeKey === null) toast.error(t('board.editor_save_failed_notice'))
  } finally {
    currentThumbnailScheduler?.dispose()
    currentCheckpointScheduler?.dispose()
    await currentCheckpointScheduler?.waitForIdle()
    currentSaveCoordinator?.dispose()
    currentAssetSession?.dispose()
    if (thumbnailScheduler.value === currentThumbnailScheduler) thumbnailScheduler.value = null
    if (checkpointScheduler.value === currentCheckpointScheduler) checkpointScheduler.value = null
    if (saveCoordinator.value === currentSaveCoordinator) saveCoordinator.value = null
    if (assetSession.value === currentAssetSession) assetSession.value = null
    saveState.value = null
    saveFailureNoticeKey = null
  }
}

async function mountScene(
  nextAggregate: BoardAggregate,
  chosenScene: BoardAggregate['sceneRecord']['scene'],
  checkpoint: BoardCheckpoint | null,
  recoveryConflict: boolean,
): Promise<void> {
  const generation = loadGeneration.value
  status.value = 'hydrating'
  const record = nextAggregate.sceneRecord
  const id = record.boardId
  const nextAssetSession = createBoardAssetSession({ boardId: id, store: recoveryStore })
  try {
    nextAssetSession.seedScene(chosenScene)
    const resolvedAssets = await nextAssetSession.resolveSceneAssets(chosenScene)
    const nextRuntimeScene = await excalidrawAdapter.hydrate(chosenScene, resolvedAssets)
    if (generation !== loadGeneration.value) {
      nextAssetSession.dispose()
      return
    }

    assetSession.value = nextAssetSession
    assetIntakePromise = Promise.resolve()
    hostChangePromise = Promise.resolve()
    saveFailureNoticeKey = null
    librarySaveFailureNoticeShown = false
    aggregate.value = nextAggregate
    boardMetadataSource.upsert(nextAggregate.metadata)
    session.value = {
      boardId: id,
      serverRevision: record.revision,
      baseRevision: checkpoint?.baseRevision ?? record.revision,
      localRevision: checkpoint?.localRevision ?? 0,
    }
    runtimeScene.value = nextRuntimeScene

    const serialize = (scene: ExcalidrawRuntimeScene) => (
      excalidrawAdapter.serialize(scene, nextAssetSession.getFileMap())
    )
    const scheduler = createBoardCheckpointScheduler<ExcalidrawRuntimeScene>({
      boardId: id,
      sceneVersion: record.sceneVersion,
      initialRuntimeScene: nextRuntimeScene,
      initialLocalRevision: checkpoint?.localRevision,
      initialBaseRevision: checkpoint?.baseRevision ?? record.revision,
      serialize,
      store: recoveryStore,
      onStateChange: (nextState) => {
        if (nextState.status === 'error' || nextState.status === 'unavailable') {
          recoveryUnavailable.value = true
          toast.error(t('board.editor_recovery_unavailable'))
        }
      },
    })
    checkpointScheduler.value = scheduler
    const thumbnail = createBoardThumbnailScheduler<ExcalidrawRuntimeScene>({
      boardId: id,
      adapter: excalidrawAdapter,
      onSuccess: ({ response }) => {
        if (thumbnailScheduler.value !== thumbnail || aggregate.value?.metadata.id !== id) return
        const metadata = {
          ...aggregate.value.metadata,
          thumbnailAssetId: response.thumbnailAssetId,
        }
        aggregate.value = { ...aggregate.value, metadata }
        boardMetadataSource.upsert(metadata)
      },
      onFailure: () => {
        if (thumbnailScheduler.value !== thumbnail) return
        toast.error(t('board.editor_thumbnail_failed'))
      },
    })
    thumbnailScheduler.value = thumbnail
    const coordinator = createBoardSaveCoordinator<ExcalidrawRuntimeScene>({
      boardId: id,
      engine: record.engine,
      sceneVersion: record.sceneVersion,
      currentServerRevision: record.revision,
      initialBaseRevision: checkpoint?.baseRevision,
      initialLocalRevision: checkpoint?.localRevision,
      initialLastSavedLocalRevision: checkpoint ? 0 : undefined,
      initialDirty: Boolean(checkpoint),
      initialConflict: recoveryConflict,
      initialRuntimeScene: nextRuntimeScene,
      initialFingerprint: runtimePersistenceFingerprint(nextRuntimeScene),
      serialize,
      prepareSave: async (scene) => {
        await nextAssetSession.ensureSceneAssetsReady(serialize(scene))
      },
      onMeaningfulChange: ({ runtimeScene: changedScene, localRevision, baseRevision }) => {
        scheduler.schedule(changedScene, localRevision, baseRevision)
      },
      onSaveSucceeded: (event) => {
        scheduler.onServerSaveSucceeded(event)
        thumbnail.schedule({ runtimeScene: event.runtimeScene, revision: event.revision })
        clearAssetFailures(Object.values(nextAssetSession.getFileMap()).map((assetId) => ({ assetId })))
      },
      onStateChange: (nextState) => {
        saveState.value = nextState
        if (nextState.status === 'error') {
          if (nextState.lastError instanceof BoardAssetError) {
            const contexts = contextsForRuntimeScene(runtimeScene.value ?? nextRuntimeScene, nextAssetSession)
            reportAssetFailure(nextState.lastError, 'upload', contexts[0], true)
          } else {
            const errorLabel = nextState.lastError instanceof Error ? nextState.lastError.message : String(nextState.lastError ?? '')
            const noticeKey = `${nextState.localRevision}:${errorLabel}`
            if (saveFailureNoticeKey !== noticeKey) {
              saveFailureNoticeKey = noticeKey
              toast.error(t('board.editor_save_failed_notice'))
            }
          }
        } else if (nextState.status === 'saved' || nextState.status === 'dirty' || nextState.status === 'saving') {
          saveFailureNoticeKey = null
        }
        if (!session.value || session.value.boardId !== id) return
        session.value = {
          ...session.value,
          serverRevision: nextState.currentServerRevision,
          baseRevision: nextState.baseRevision,
          localRevision: nextState.localRevision,
        }
      },
      onMetadataUpdated: (updatedAt) => {
        if (aggregate.value?.metadata.id !== id) return
        const metadata = { ...aggregate.value.metadata, updatedAt }
        aggregate.value = { ...aggregate.value, metadata }
        boardMetadataSource.upsert(metadata)
      },
    })
    saveCoordinator.value = coordinator
    saveState.value = coordinator.getSnapshot()
    if (checkpoint && !recoveryConflict) coordinator.schedule()
  } catch (error) {
    nextAssetSession.dispose()
    throw error
  }
}

function recoveryReason(reconciliation: BoardCheckpointReconciliation): string {
  if (reconciliation.kind !== 'invalid') return ''
  return t(`board.editor_recovery_invalid_${reconciliation.reason}` as Parameters<typeof t>[0])
}

async function loadBoard(): Promise<void> {
  const generation = ++loadGeneration.value
  disposePersistence()
  status.value = 'loading'
  errorKind.value = null
  errorMessage.value = ''
  errorMetadata.value = null
  aggregate.value = null
  session.value = null
  runtimeScene.value = null
  pendingRecovery.value = null
  recoveryUnavailable.value = false
  const id = boardId.value
  if (!id) return

  try {
    const nextAggregate = await getBoard(id)
    if (generation !== loadGeneration.value) return
    const record = nextAggregate.sceneRecord
    assertSupportedExcalidrawScene(record.engine, record.sceneVersion)
    // Validate the server scene before asking the user about any local copy.
    excalidrawAdapter.validate(record.scene)
    status.value = 'reconciling'
    let checkpoint: BoardCheckpoint | null
    try {
      checkpoint = await recoveryStore.get(id)
    } catch (error) {
      if (error instanceof BoardRecoveryStoreError && error.code === 'BOARD_RECOVERY_UNAVAILABLE') {
        recoveryUnavailable.value = true
        toast.error(t('board.editor_recovery_unavailable'))
        await mountScene(nextAggregate, record.scene, null, false)
        return
      }
      pendingRecovery.value = {
        kind: 'read-error',
        aggregate: nextAggregate,
        checkpoint: null,
        reason: error instanceof Error ? error.message : t('board.editor_recovery_read_failed'),
      }
      status.value = 'recovery-choice'
      return
    }
    if (generation !== loadGeneration.value) return
    const reconciliation = reconcileBoardCheckpoint({
      serverRecord: record,
      checkpoint,
      validateScene: (scene) => { excalidrawAdapter.validate(scene) },
    })
    if (reconciliation.kind === 'server') {
      await mountScene(nextAggregate, reconciliation.scene, null, false)
      return
    }
    if (reconciliation.kind === 'recover-local') {
      pendingRecovery.value = {
        kind: 'choice',
        aggregate: nextAggregate,
        checkpoint: reconciliation.checkpoint,
        reason: t('board.editor_recovery_found_detail'),
      }
      status.value = 'recovery-choice'
      return
    }
    if (reconciliation.kind === 'conflict') {
      pendingRecovery.value = {
        kind: 'conflict',
        aggregate: nextAggregate,
        checkpoint: reconciliation.checkpoint,
        reason: t('board.editor_recovery_conflict_detail'),
      }
      status.value = 'recovery-conflict'
      return
    }
    pendingRecovery.value = {
      kind: 'invalid',
      aggregate: nextAggregate,
      checkpoint,
      reason: recoveryReason(reconciliation),
    }
    status.value = 'recovery-choice'
  } catch (error) {
    if (generation !== loadGeneration.value) return
    if (error instanceof BoardApiError && error.code === 'BOARD_SCENE_CORRUPT') {
      try {
        const metadata = await getBoardMetadata(id)
        if (generation === loadGeneration.value) errorMetadata.value = metadata
      } catch {
        // The error surface remains useful even if the metadata fallback is
        // unavailable; never hide the original scene error.
      }
    }
    if (generation !== loadGeneration.value) return
    showLoadError(error)
  }
}

async function recoverLocal(): Promise<void> {
  const pending = pendingRecovery.value
  if (!pending?.checkpoint) return
  pendingRecovery.value = null
  try {
    await mountScene(pending.aggregate, pending.checkpoint.scene, pending.checkpoint, false)
  } catch (error) {
    showLoadError(error)
  }
}

async function discardLocal(): Promise<void> {
  const pending = pendingRecovery.value
  if (!pending) return
  if (pending.checkpoint) {
    try {
      await recoveryStore.delete(pending.aggregate.metadata.id)
    } catch (error) {
      pendingRecovery.value = { ...pending, reason: error instanceof Error ? error.message : t('board.editor_recovery_delete_failed') }
      return
    }
  }
  pendingRecovery.value = null
  try {
    await mountScene(pending.aggregate, pending.aggregate.sceneRecord.scene, null, false)
  } catch (error) {
    showLoadError(error)
  }
}

async function openServerVersionFromRecovery(): Promise<void> {
  const pending = pendingRecovery.value
  if (!pending) return
  if (pending.kind === 'conflict') {
    await discardLocal()
    return
  }
  pendingRecovery.value = null
  try {
    await mountScene(pending.aggregate, pending.aggregate.sceneRecord.scene, null, false)
  } catch (error) {
    showLoadError(error)
  }
}

function retryRecoveryRead(): void {
  void loadBoard()
}

async function keepLocalRecoveryOpen(): Promise<void> {
  const pending = pendingRecovery.value
  if (!pending?.checkpoint) return
  pendingRecovery.value = null
  try {
    await mountScene(pending.aggregate, pending.checkpoint.scene, pending.checkpoint, true)
  } catch (error) {
    showLoadError(error)
  }
}

function onHostReady(): void {
  if (status.value === 'hydrating') status.value = 'ready'
}

function hasIncompleteRuntimeImage(runtime: ExcalidrawRuntimeScene): boolean {
  return runtime.elements.some((element) => {
    if (!element || typeof element !== 'object' || Array.isArray(element)) return false
    const value = element as { type?: unknown; isDeleted?: unknown; fileId?: unknown }
    if (value.type !== 'image' || value.isDeleted === true) return false
    return typeof value.fileId !== 'string' || value.fileId.length === 0
  })
}

let hostChangeSequence = 0

function onHostAssetsChanged(assets: readonly BoardRuntimeAsset[]): void {
  if (deleting.value) return
  const currentAssetSession = assetSession.value
  if (!currentAssetSession) return
  const contexts = contextsForRuntimeAssets(assets, currentAssetSession)
  const intake = currentAssetSession.observeRuntimeAssets(assets)
  const nextIntakePromise = Promise.all([
    assetIntakePromise.catch(() => {}),
    intake,
  ]).then(() => undefined)
  assetIntakePromise = nextIntakePromise
  void nextIntakePromise.then(() => {
    if (currentAssetSession === assetSession.value) clearAssetFailures(contexts)
  }, () => {
    // The checkpoint/save gate classifies intake failures. A rejected intake
    // promise alone is not a terminal remote upload failure.
  })
}

function onHostChange(nextRuntimeScene: ExcalidrawRuntimeScene): void {
  if (deleting.value || status.value !== 'ready' || !session.value || !saveCoordinator.value || !assetSession.value) return
  // Excalidraw can emit one intermediate image element before its BinaryFile
  // has received the final file ID. It is not a persistable scene yet, and a
  // later change carries the same scene with the completed image reference.
  // Waiting here avoids presenting that bridge snapshot as a local-cache
  // failure while keeping the authoritative save validation strict.
  if (hasIncompleteRuntimeImage(nextRuntimeScene)) return
  const sequence = ++hostChangeSequence
  const currentCoordinator = saveCoordinator.value
  const currentAssetSession = assetSession.value
  const currentIntake = assetIntakePromise
  const contexts = contextsForRuntimeScene(nextRuntimeScene, currentAssetSession)
  const change = currentIntake.then(() => currentAssetSession.ensureCheckpointAssetsDurable(nextRuntimeScene)).then(() => {
    if (sequence !== hostChangeSequence
      || status.value !== 'ready'
      || currentCoordinator !== saveCoordinator.value
      || currentAssetSession !== assetSession.value) return
    runtimeScene.value = nextRuntimeScene
    currentCoordinator.recordChange(nextRuntimeScene, runtimePersistenceFingerprint(nextRuntimeScene))
    clearAssetFailures(contexts)
  }).catch((error: unknown) => {
    if (sequence !== hostChangeSequence || currentAssetSession !== assetSession.value) return
    reportAssetFailure(error, 'upload', contexts[0])
  })
  hostChangePromise = Promise.all([
    hostChangePromise.catch(() => {}),
    change,
  ]).then(() => undefined)
}

function onHostError(error: unknown): void {
  if (status.value === 'error') return
  status.value = 'error'
  errorKind.value = 'canvas'
  errorMessage.value = error instanceof Error ? error.message : String(error)
  session.value = null
  runtimeScene.value = null
}

function onHostAssetError(error: unknown): void {
  if (status.value === 'error') return
  // The React island can observe an intermediate BinaryFiles snapshot before
  // the authoritative Asset Session/checkpoint gate settles. Only a typed,
  // non-transient Asset error is safe to show at this bridge boundary.
  if (error instanceof BoardAssetError) reportAssetFailure(error, 'upload')
}

function onLibrarySaveError(): void {
  if (!session.value || librarySaveFailureNoticeShown) return
  librarySaveFailureNoticeShown = true
  toast.error(t('board.editor_library_save_failed'))
}

const displayedSaveStatus = computed(() => {
  if (status.value !== 'ready') return null
  return saveState.value?.status ?? 'saved'
})

const hasSaveRisk = computed(() => {
  const state = saveState.value
  return Boolean(state && (state.dirty || state.saveInFlight || state.status === 'error' || state.status === 'conflict' || state.status === 'uncertain'))
})

const saveStatusLabel = computed(() => {
  switch (displayedSaveStatus.value) {
    case 'saving': return t('board.editor_save_saving')
    case 'dirty': return t('board.editor_save_dirty')
    case 'error': return t('board.editor_save_error')
    case 'conflict': return t('board.editor_save_conflict')
    case 'uncertain': return t('board.editor_save_uncertain')
    default: return t('board.editor_save_saved')
  }
})

async function leaveAfterFlush(): Promise<boolean> {
  let assetPreparationFailed = false
  try {
    await assetIntakePromise
  } catch {
    assetPreparationFailed = true
  }
  try {
    await hostChangePromise
  } catch {
    assetPreparationFailed = true
  }
  if (assetPreparationFailed) {
    const leave = await confirm(
      t('board.editor_leave_title'),
      t('board.editor_leave_detail'),
      {
        confirmLabel: t('board.editor_leave_anyway'),
        cancelLabel: t('board.editor_stay'),
        destructive: true,
      },
    )
    if (!leave) return false
  }
  const coordinator = saveCoordinator.value
  if (!coordinator) return true
  const result = await coordinator.flush()
  if (result.ok) return true
  const leave = await confirm(
    t('board.editor_leave_title'),
    t('board.editor_leave_detail'),
    {
      confirmLabel: t('board.editor_leave_anyway'),
      cancelLabel: t('board.editor_stay'),
      destructive: true,
    },
  )
  return leave
}

onBeforeRouteLeave(() => leaveAfterFlush())
onBeforeRouteUpdate((to) => {
  if (to.params.boardId === route.params.boardId) return true
  return leaveAfterFlush()
})

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasSaveRisk.value) return
  event.preventDefault()
  event.returnValue = ''
}

async function reloadServerVersion(): Promise<void> {
  const discard = await confirm(
    t('board.editor_reload_title'),
    t('board.editor_reload_detail'),
    {
      confirmLabel: t('board.editor_reload_confirm'),
      cancelLabel: t('board.editor_stay'),
      destructive: true,
    },
  )
  if (!discard) return
  try {
    if (session.value) await recoveryStore.delete(session.value.boardId)
  } catch {
    toast.error(t('board.editor_recovery_delete_failed'))
    return
  }
  await loadBoard()
}

function keepEditingLocally(): void {
  toast.info(t('board.editor_keep_local'))
}

async function retrySave(): Promise<void> {
  await saveCoordinator.value?.retry()
}

async function exportBoard(format: BoardExportFormat): Promise<void> {
  const scene = runtimeScene.value
  if (exportBusy.value !== null || status.value !== 'ready' || !scene) return
  exportBusy.value = format
  try {
    const output = format === 'png'
      ? await excalidrawAdapter.exportPng(scene)
      : await excalidrawAdapter.exportSvg(scene)
    const blob = typeof output === 'string'
      ? new Blob([output], { type: 'image/svg+xml;charset=utf-8' })
      : output
    downloadBoardBlob(blob, boardExportFilename(boardTitle.value, format))
  } catch {
    toast.error(t('board.editor_export_failed'))
  } finally {
    exportBusy.value = null
  }
}

async function renameCurrentBoard(title: string): Promise<boolean> {
  const id = session.value?.boardId
  const normalizedTitle = title.trim()
  if (!id || !normalizedTitle || renaming.value) return false
  if (normalizedTitle === boardTitle.value) return true
  renaming.value = true
  try {
    const metadata = await renameBoard(id, normalizedTitle)
    if (aggregate.value?.metadata.id !== id) return false
    aggregate.value = { ...aggregate.value, metadata }
    boardMetadataSource.upsert(metadata)
    toast.success(t('board.renamed'))
    return true
  } catch (error) {
    if (error instanceof BoardApiError && error.uncertain) boardMetadataSource.invalidate()
    toast.error(t('board.rename_failed'))
    return false
  } finally {
    renaming.value = false
  }
}

function toggleCurrentFavorite(): void {
  const id = session.value?.boardId
  if (!id) return
  const nextFavorite = !isFavorite(id)
  setFavorite(id, nextFavorite)
  toast.success(t(nextFavorite ? 'board.favorited' : 'board.unfavorited'))
}

async function copyCurrentBoard(): Promise<void> {
  const currentSession = session.value
  const currentAssetSession = assetSession.value
  if (!currentSession || !runtimeScene.value || !currentAssetSession || copying.value || status.value !== 'ready') return
  copying.value = true
  let createdId: string | null = null
  try {
    await assetIntakePromise
    await hostChangePromise
    const latestScene = runtimeScene.value
    if (!latestScene || session.value !== currentSession || assetSession.value !== currentAssetSession) return
    const serializedScene = excalidrawAdapter.serialize(latestScene, currentAssetSession.getFileMap())
    await currentAssetSession.ensureSceneAssetsReady(serializedScene)
    const copied = await createBoard({
      title: t('board.editor_copy_title', { title: boardTitle.value }),
      folderId: aggregate.value?.metadata.folderId ?? null,
    })
    createdId = copied.metadata.id
    const saved = await saveBoardScene(createdId, {
      expectedRevision: copied.sceneRecord.revision,
      engine: copied.sceneRecord.engine,
      sceneVersion: copied.sceneRecord.sceneVersion,
      scene: serializedScene,
    })
    boardMetadataSource.upsert({ ...copied.metadata, updatedAt: saved.updatedAt })
    boardFolderSource.invalidate()
    toast.success(t('board.editor_copied'))
    await router.push({ name: 'board-editor', params: { boardId: createdId } })
  } catch {
    if (createdId) {
      try { await deleteBoard(createdId) } catch { boardMetadataSource.invalidate() }
    }
    toast.error(t('board.editor_copy_failed'))
  } finally {
    copying.value = false
  }
}

const editorMenu = computed<BoardEditorMenuOptions>(() => ({
  title: boardTitle.value,
  saveStatusLabel: saveStatusLabel.value,
  favorite: favorite.value,
  busy: status.value !== 'ready' || deleting.value || renaming.value || copying.value || exportBusy.value !== null,
  labels: {
    back: t('board.back_to_boards'),
    rename: t('board.rename'),
    favorite: t('board.favorite'),
    unfavorite: t('board.unfavorite'),
    exportPng: t('board.editor_export_png'),
    exportSvg: t('board.editor_export_svg'),
    copy: t('board.editor_copy'),
    delete: t('board.editor_delete'),
    materials: t('board.materials_open'),
    titleInput: t('board.title_label'),
  },
  onBack: backToBoards,
  onRename: renameCurrentBoard,
  onToggleFavorite: toggleCurrentFavorite,
  onExportPng: () => { void exportBoard('png') },
  onExportSvg: () => { void exportBoard('svg') },
  onCopy: () => { void copyCurrentBoard() },
  onDelete: () => { void deleteCurrentBoard() },
  onOpenMaterials: () => { showMaterialPanel.value = true },
}))

async function insertBoardMaterial(material: BoardMaterial): Promise<void> {
  try {
    const host = excalidrawHost.value
    if (!host) throw new Error(t('board.materials_insert_failed'))
    await host.insertMaterial(material)
    showMaterialPanel.value = false
  } catch (error) {
    console.error('Failed to insert Board material', error)
    toast.error(t('board.materials_insert_failed'))
  }
}

async function finalizeDeletedBoard(
  id: string,
  folderId: string | null,
  snapshot: BoardDeleteLifecycleSnapshot,
): Promise<void> {
  // DELETE success, including a confirmed 404 reconciliation, is the
  // lifecycle authority. Fence every callback before mutating client caches.
  snapshot.currentSaveCoordinator?.dispose()
  saveCoordinator.value = null
  saveState.value = null
  snapshot.currentThumbnailScheduler?.dispose({ drain: false })
  thumbnailScheduler.value = null
  snapshot.currentCheckpointScheduler?.dispose({ drain: false })
  checkpointScheduler.value = null
  snapshot.currentAssetSession?.dispose()
  assetSession.value = null
  hostChangeSequence += 1

  boardMetadataSource.remove(id)
  boardFolderSource.invalidate()
  await Promise.all([
    snapshot.currentAssetIntakePromise.catch(() => {}),
    snapshot.currentHostChangePromise.catch(() => {}),
    snapshot.currentCheckpointScheduler?.waitForIdle() ?? Promise.resolve(),
  ])
  try {
    await recoveryStore.clearBoardRecovery(id)
  } catch {
    toast.error(t('board.recovery_cleanup_failed'))
  }
  await router.push(folderId
    ? { name: 'board-folder', params: { folderId } }
    : { name: 'board' })
}

function isBoardNotFound(error: unknown): boolean {
  return error instanceof BoardApiError && (error.status === 404 || error.code === 'BOARD_NOT_FOUND')
}

async function deleteCurrentBoard(): Promise<void> {
  if (deleting.value || !session.value) return
  const id = session.value.boardId
  const confirmed = await confirm(
    t('board.editor_delete_title', { title: boardTitle.value }),
    t('board.editor_delete_detail'),
    {
      confirmLabel: t('board.delete'),
      cancelLabel: t('board.editor_stay'),
      destructive: true,
    },
  )
  if (!confirmed || !session.value || session.value.boardId !== id) return

  const folderId = aggregate.value?.metadata.folderId ?? null
  const currentSaveCoordinator = saveCoordinator.value
  const currentThumbnailScheduler = thumbnailScheduler.value
  const currentCheckpointScheduler = checkpointScheduler.value
  const currentAssetSession = assetSession.value
  const currentAssetIntakePromise = assetIntakePromise
  const currentHostChangePromise = hostChangePromise
  const snapshot: BoardDeleteLifecycleSnapshot = {
    currentSaveCoordinator,
    currentThumbnailScheduler,
    currentCheckpointScheduler,
    currentAssetSession,
    currentAssetIntakePromise,
    currentHostChangePromise,
  }
  deleting.value = true
  try {
    await deleteBoard(id)
    await finalizeDeletedBoard(id, folderId, snapshot)
  } catch (error) {
    if (!(error instanceof BoardApiError) || !error.uncertain) {
      toast.error(error instanceof Error && error.message.trim()
        ? error.message
        : t('board.editor_delete_failed'))
      return
    }

    try {
      await getBoardMetadata(id)
      // The authoritative metadata still exists, so the editor and its local
      // recovery state remain usable for another user-initiated attempt.
      toast.error(t('board.editor_delete_failed'))
    } catch (reconciliationError) {
      if (isBoardNotFound(reconciliationError)) {
        await finalizeDeletedBoard(id, folderId, snapshot)
        return
      }
      toast.error(t('board.editor_delete_uncertain'))
    }
  } finally {
    deleting.value = false
  }
}

function backToBoards(): void {
  const folderId = aggregate.value?.metadata.folderId ?? null
  void router.push(folderId
    ? { name: 'board-folder', params: { folderId } }
    : { name: 'board' })
}

function clearGoShortcut(): void {
  if (goShortcutTimer !== null) clearTimeout(goShortcutTimer)
  goShortcutTimer = null
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .excalidraw-wysiwyg'))
}

function hasOpenEditorOverlay(): boolean {
  return Boolean(document.querySelector([
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    '.dropdown-menu',
    '.n-dropdown-menu',
    '.n-modal',
    '.n-drawer',
    '.n-popover',
    '.excalidraw .popover',
    '.excalidraw .Popover',
    '[data-radix-popper-content-wrapper]',
    '[data-board-material-panel]',
  ].join(', ')))
}

function handleGoShortcut(event: KeyboardEvent): void {
  if (event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey
    || status.value !== 'ready' || renaming.value || isTextEditingTarget(event.target) || hasOpenEditorOverlay()) {
    clearGoShortcut()
    return
  }

  const key = event.key.toLocaleLowerCase()
  if (goShortcutTimer !== null) {
    clearGoShortcut()
    if (key !== 'b') return
    event.preventDefault()
    event.stopPropagation()
    backToBoards()
    return
  }

  if (key !== 'g') return
  event.preventDefault()
  event.stopPropagation()
  goShortcutTimer = setTimeout(() => { goShortcutTimer = null }, 700)
}

watch(() => boardId.value, () => { void loadBoard() }, { immediate: true })
let previousDocumentTitle = 'Nuvyn'
watch(() => aggregate.value?.metadata.title, (title) => {
  if (title) document.title = `${title} · Nuvyn`
})
onMounted(() => {
  previousDocumentTitle = document.title || 'Nuvyn'
  if (aggregate.value?.metadata.title) document.title = `${aggregate.value.metadata.title} · Nuvyn`
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('keydown', handleGoShortcut, true)
})
onBeforeUnmount(() => {
  loadGeneration.value += 1
  clearGoShortcut()
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('keydown', handleGoShortcut, true)
  document.title = previousDocumentTitle
  void flushAndDisposePersistence()
})
</script>

<template>
  <main class="board-editor" data-testid="board-editor">
    <div
      class="board-editor-status-sr"
      :data-status="status"
      :data-save-status="displayedSaveStatus"
      data-testid="board-editor-status"
      role="status"
      aria-live="polite"
    >
      <span>{{ status === 'ready' ? t('board.editor_ready') : status }}</span>
      <span v-if="session" data-testid="board-local-revision" :data-local-revision="session.localRevision">{{ session.localRevision }}</span>
    </div>

    <section v-if="status === 'loading'" class="board-editor-state" data-testid="board-editor-loading" role="status">
      <NSpin size="medium" />
      <span>{{ t('board.editor_loading') }}</span>
    </section>

    <section v-else-if="status === 'reconciling'" class="board-editor-state" data-testid="board-editor-reconciling" role="status">
      <NSpin size="medium" />
      <span>{{ t('board.editor_reconciling') }}</span>
    </section>

    <section v-else-if="status === 'recovery-choice'" class="board-editor-state board-editor-recovery" data-testid="board-editor-recovery" role="alert">
      <h1>{{ pendingRecovery?.kind === 'invalid' ? t('board.editor_recovery_damaged') : t('board.editor_recovery_found') }}</h1>
      <p>{{ pendingRecovery?.reason }}</p>
      <div class="board-editor-actions">
        <NButton v-if="pendingRecovery?.kind === 'choice'" attr-type="button" type="primary" @click="recoverLocal">{{ t('board.editor_recover_local') }}</NButton>
        <NButton v-if="pendingRecovery?.kind !== 'read-error'" attr-type="button" @click="discardLocal">{{ t('board.editor_discard_local') }}</NButton>
        <NButton v-if="pendingRecovery?.kind === 'read-error' || pendingRecovery?.kind === 'invalid'" attr-type="button" @click="openServerVersionFromRecovery">{{ t('board.editor_open_server') }}</NButton>
        <NButton v-if="pendingRecovery?.kind === 'read-error'" attr-type="button" @click="retryRecoveryRead">{{ t('common.retry') }}</NButton>
      </div>
    </section>

    <section v-else-if="status === 'recovery-conflict'" class="board-editor-state board-editor-recovery" data-testid="board-editor-recovery-conflict" role="alert">
      <h1>{{ t('board.editor_recovery_conflict') }}</h1>
      <p>{{ pendingRecovery?.reason }}</p>
      <div class="board-editor-actions">
        <NButton attr-type="button" type="primary" @click="keepLocalRecoveryOpen">{{ t('board.editor_keep_local_recovery') }}</NButton>
        <NButton attr-type="button" @click="openServerVersionFromRecovery">{{ t('board.editor_open_server') }}</NButton>
      </div>
    </section>

    <section v-else-if="status === 'error'" class="board-editor-state" data-testid="board-editor-error" role="alert">
      <h1>{{ errorTitle }}</h1>
      <p v-if="errorMetadata" class="board-editor-error-board-title" data-testid="board-error-board-title">{{ errorMetadata.title }}</p>
      <p>{{ errorDescription }}</p>
      <div class="board-editor-actions">
        <NButton attr-type="button" type="primary" @click="loadBoard">{{ t('common.retry') }}</NButton>
        <NButton attr-type="button" @click="backToBoards">{{ t('board.back_to_boards') }}</NButton>
      </div>
    </section>

    <section v-else class="board-editor-surface" data-testid="board-editor-surface" :aria-label="t('board.editor_canvas_label')">
      <div
        v-if="displayedSaveStatus === 'saving'"
        class="board-editor-save-notice"
        data-testid="board-editor-save-notice"
        role="status"
        aria-live="polite"
      >
        {{ saveStatusLabel }}
      </div>
      <div
        v-else-if="displayedSaveStatus === 'error' || displayedSaveStatus === 'uncertain'"
        class="board-editor-save-notice is-error"
        data-testid="board-editor-save-error"
        role="alert"
      >
        <span>⚠ {{ saveStatusLabel }}</span>
        <NButton text size="tiny" attr-type="button" @click="retrySave">{{ t('board.editor_retry_save') }}</NButton>
      </div>
      <div v-if="recoveryUnavailable" class="board-editor-save-notice is-error" data-testid="board-recovery-unavailable" role="alert">
        ⚠ {{ t('board.editor_recovery_unavailable_short') }}
      </div>
      <div v-if="displayedSaveStatus === 'conflict'" class="board-editor-conflict" data-testid="board-editor-conflict" role="alert">
        <p>{{ t('board.editor_conflict_detail') }}</p>
        <div class="board-editor-actions">
          <NButton attr-type="button" type="primary" @click="reloadServerVersion">{{ t('board.editor_reload_server') }}</NButton>
          <NButton attr-type="button" @click="keepEditingLocally">{{ t('board.editor_keep_editing') }}</NButton>
        </div>
      </div>
      <ExcalidrawHost
        v-if="runtimeScene && session"
        ref="excalidrawHost"
        :initial-scene="runtimeScene"
        :theme="theme"
        :lang-code="excalidrawLangCode"
        :editor-menu="editorMenu"
        @change="onHostChange"
        @assets-changed="onHostAssetsChanged"
        @asset-error="onHostAssetError"
        @library-save-error="onLibrarySaveError"
        @ready="onHostReady"
        @error="onHostError"
      />
      <BoardMaterialPanel
        v-if="showMaterialPanel && status === 'ready'"
        @close="showMaterialPanel = false"
        @insert="insertBoardMaterial"
      />
    </section>
  </main>
</template>

<style scoped>
.board-editor { position: relative; display: flex; width: 100%; height: 100dvh; min-height: 0; overflow: hidden; background: var(--bg); color: var(--text); }
.board-editor-status-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.board-editor-surface { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.board-editor-surface :deep(.excalidraw-host) { min-height: 0; height: 100%; }
.board-editor-state { display: grid; flex: 1; place-content: center; justify-items: center; gap: .75rem; min-height: 18rem; padding: 2rem; background: var(--surface, var(--bg)); color: var(--text); text-align: center; }
.board-editor-state h1, .board-editor-state p { max-width: 36rem; margin: 0; }
.board-editor-state h1 { color: var(--text-h, inherit); font-size: 1.2rem; }
.board-editor-state p { color: var(--text-muted, #6b7280); }
.board-editor-recovery { min-height: 360px; }
.board-editor-actions { display: flex; gap: .5rem; }
.board-editor-conflict { position: absolute; z-index: 2; top: .75rem; right: .75rem; max-width: 28rem; padding: .75rem; border: 1px solid var(--border, #d1d5db); border-radius: .5rem; background: var(--surface, var(--bg)); box-shadow: 0 .5rem 1.5rem rgb(0 0 0 / 12%); }
.board-editor-conflict p { margin: 0 0 .75rem; color: var(--text-h, inherit); }
.board-editor-surface { position: relative; }
.board-editor-save-notice { position: absolute; z-index: 3; top: 1rem; right: 1rem; display: flex; min-height: 32px; box-sizing: border-box; align-items: center; gap: .5rem; padding: .4rem .7rem; border: 1px solid color-mix(in srgb, var(--border) 78%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--surface, var(--bg)) 94%, transparent); color: var(--text-muted, #6b7280); box-shadow: 0 4px 16px rgb(0 0 0 / 8%); font-size: .78rem; backdrop-filter: blur(8px); }
.board-editor-save-notice.is-error { border-color: color-mix(in srgb, var(--nuvyn-negative, #b42318) 34%, transparent); color: var(--nuvyn-negative, #b42318); }
</style>
