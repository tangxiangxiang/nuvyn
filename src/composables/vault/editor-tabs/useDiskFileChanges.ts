import type { Ref } from 'vue'
import type { Tab } from '../../../components/vault/tabs'
import { getFileStates, getPost, recoverPost, type PostSummary } from '../../../lib/api'
import type { VaultFileChanges } from '../context/fileChanges'
import { classifyDiaryPath } from '../../../../shared/diaryProtocol'
import { captureDiarySessionGeneration, isDiarySessionGenerationCurrent } from '../../diary/useDiaryAccessSession'

export function useDiskFileChanges(options: {
  tabs: Ref<Tab[]>
  doSave: (path: string) => Promise<void>
  scheduleSave: (path: string, delay?: number) => void
  applyPostSummary: (post: PostSummary) => void
  fileChanges: VaultFileChanges
}) {
  let externalPollTimer: ReturnType<typeof setInterval> | null = null
  const externalResolutionIds = new Map<string, number>()
  // Per-path generation counter for every in-flight disk read (poll or
  // manual resolution). Bumped by every poll read AND by
  // `beginExternalResolution`, so a poll that began before a manual
  // resolution cannot overwrite state the resolution writes and an older
  // poll cannot overwrite state a newer poll observes. Field-snapshot
  // equality still handles state changes between captures (edit, save,
  // recovery), while `diskReadIds` handles the case where two reads race
  // without the captured fields having moved (same mtime, same revision).
  const diskReadIds = new Map<string, number>()
  // Per-path generation counter for `getFileStates()` observations. Allocated
  // BEFORE the network call so that when two polls race, the newer poll's
  // state observation invalidates the older one, preventing a stale
  // exists=false from overwriting a fresh exists=true (and vice versa).
  const stateObservationIds = new Map<string, number>()
  // Per-path record of which manual external resolution id is currently in
  // flight. While a resolution is pending for a path, polls must neither
  // read nor write the tab — the user's click is authoritative and a poll
  // that races with it could otherwise change `externalKind` away from the
  // value the resolution's `isCurrentExternalResolution` check expects
  // (causing the resolution to silently drop) or set the tab to
  // `unreadable` and make a subsequent `recoverPost` 200 invisible to the
  // `recoveryObservedByPoll` shortcut. Cleared in `resolveExternal`'s
  // `finally` once the id is no longer the latest for the path.
  const pendingExternalResolutions = new Map<string, number>()

  function invalidateDiskRead(path: string): number {
    const id = (diskReadIds.get(path) ?? 0) + 1
    diskReadIds.set(path, id)
    return id
  }

  function isCurrentDiskRead(path: string, id: number): boolean {
    return diskReadIds.get(path) === id
  }

  function beginStateObservation(path: string): number {
    const id = (stateObservationIds.get(path) ?? 0) + 1
    stateObservationIds.set(path, id)
    return id
  }

  function isCurrentStateObservation(path: string, id: number): boolean {
    return stateObservationIds.get(path) === id
  }

  // Unified invalidation for external events (AI deletes/writes). Bumps both
  // the disk-read generation (so in-flight getPost responses are discarded)
  // AND the state-observation generation (so in-flight getFileStates responses
  // are discarded). Without the state-observation bump, a stale exists=true
  // state response arriving after an AI delete could still route into getPost
  // and flip the tab to unreadable.
  function invalidateDiskObservation(path: string): void {
    invalidateDiskRead(path)
    beginStateObservation(path)
  }

  function beginExternalResolution(path: string): number {
    const id = (externalResolutionIds.get(path) ?? 0) + 1
    externalResolutionIds.set(path, id)
    // Manual resolution is the user's authoritative intent. Invalidate any
    // poll read that began before this click so it cannot race the
    // resolution's writes once it returns.
    invalidateDiskRead(path)
    // Also invalidate any in-flight `getFileStates()` observation for this
    // path so a poll whose state request was already in flight cannot
    // overwrite the resolution's result once the request returns.
    beginStateObservation(path)
    // Also block any *new* poll that starts during this resolution from
    // touching the path at all. Polls check this map at both the loaded
    // filter and the per-state loop; the resolution clears it in `finally`.
    pendingExternalResolutions.set(path, id)
    return id
  }

  function endExternalResolutionIfCurrent(path: string, id: number): void {
    // Only the resolution whose id is still recorded as pending may clear
    // the entry. A newer resolution will have overwritten the slot and
    // owns the cleanup for its own lifetime.
    if (pendingExternalResolutions.get(path) === id) {
      pendingExternalResolutions.delete(path)
    }
  }

  function isCurrentExternalResolution(
    path: string,
    id: number,
    tab: Tab,
    externalKind: Tab['externalKind'],
  ): boolean {
    // Resolution-level check: only newer resolutions invalidate. A poll
    // that runs concurrently is allowed to observe and write intermediate
    // state (e.g. `recoveryObservedByPoll`) without forcing this
    // resolution to drop its work.
    const latestTab = options.tabs.value.find((item) => item.path === path)
    return externalResolutionIds.get(path) === id
      && latestTab === tab
      && latestTab.path === path
      && latestTab.saveStatus === 'external'
      && latestTab.externalKind === externalKind
  }

  function sessionStillCurrent(path: string, generation: number): boolean {
    return classifyDiaryPath(path.replace(/\.md$/, '')) !== 'managed'
      || isDiarySessionGenerationCurrent(generation)
  }

  async function pollExternalChanges() {
    const loaded = options.tabs.value.filter((tab) =>
      !tab.loading
      && (!tab.loadError || tab.externalKind === 'deleted')
      && !pendingExternalResolutions.has(tab.path),
    )
    if (!loaded.length) return
    // Allocate state observation IDs BEFORE the network call. When two
    // polls race, the newer observation invalidates the older one so a
    // stale `exists=false` response cannot overwrite a fresh `exists=true`
    // (or vice versa).
    const pathObservationIds = new Map<string, number>()
    for (const tab of loaded) {
      pathObservationIds.set(tab.path, beginStateObservation(tab.path))
    }
    let states: Awaited<ReturnType<typeof getFileStates>>
    try { states = await getFileStates(loaded.map((tab) => tab.path)) } catch { return }
    for (const state of states) {
      // Drop results from a state observation superseded by a newer poll or
      // manual resolution.
      const observationId = pathObservationIds.get(state.path)
      if (observationId == null || !isCurrentStateObservation(state.path, observationId)) continue
      // A resolution may have begun between the loaded filter and now. Skip
      // so the poll does not write intermediate state the resolution will
      // overwrite (or that invalidates its `externalKind` check).
      if (pendingExternalResolutions.has(state.path)) continue
      const tab = options.tabs.value.find((item) => item.path === state.path)
      if (!tab || tab.savingRevision !== null) continue
      // Bump the read generation FIRST, before any state observation. This
      // invalidates any in-flight `getPost` for this path from a previous
      // poll as soon as we observe the new state — including the deleted
      // branch below, where a pending content read would otherwise be
      // allowed to write its stale body.
      const readId = invalidateDiskRead(state.path)
      if (!state.exists) {
        tab.saveStatus = 'external'
        tab.error = '文件已从磁盘删除'
        tab.externalRaw = null
        tab.externalKind = 'deleted'
        continue
      }
      if (
        tab.externalKind !== 'deleted'
        && tab.externalKind !== 'unreadable'
        && state.mtime === tab.serverMtime
      ) continue

      const requestedPath = tab.path
      const requestedRevision = tab.revision
      const requestedSavedRevision = tab.savedRevision
      const requestedOriginalRaw = tab.originalRaw
      const requestedServerMtime = tab.serverMtime
      const requestedExternalKind = tab.externalKind
      const requestedSaveStatus = tab.saveStatus
      const requestedExternalRaw = tab.externalRaw
      const requestedLoadError = tab.loadError
      const requestedTab = tab
      const sessionGeneration = captureDiarySessionGeneration()
      try {
        const post = await getPost(requestedPath)
        if (!sessionStillCurrent(requestedPath, sessionGeneration)) continue
        if (!isCurrentDiskRead(requestedPath, readId)) continue
        const latestTab = options.tabs.value.find((item) => item.path === requestedPath)
        if (
          latestTab !== requestedTab
          || latestTab.path !== requestedPath
          || latestTab.savingRevision !== null
          || (
            requestedExternalKind !== 'deleted'
            && requestedExternalKind !== 'unreadable'
            && state.mtime === latestTab.serverMtime
          )
          || latestTab.revision !== requestedRevision
          || latestTab.savedRevision !== requestedSavedRevision
          || latestTab.originalRaw !== requestedOriginalRaw
          || latestTab.serverMtime !== requestedServerMtime
          || latestTab.saveStatus !== requestedSaveStatus
          || latestTab.externalRaw !== requestedExternalRaw
          || latestTab.loadError !== requestedLoadError
        ) continue

        if (requestedExternalKind === 'deleted') {
          latestTab.externalRaw = post.raw
          latestTab.externalKind = 'modified'
          latestTab.serverMtime = post.mtime
          latestTab.saveStatus = 'external'
          latestTab.error = '磁盘文件已重新出现，请选择使用磁盘或保留本地版本'
          latestTab.loadError = null
          continue
        }

        const dirty = latestTab.raw !== latestTab.originalRaw
          || latestTab.revision !== latestTab.savedRevision
        if (dirty) {
          latestTab.externalRaw = post.raw
          latestTab.externalKind = 'modified'
          latestTab.serverMtime = post.mtime
          latestTab.saveStatus = 'external'
          latestTab.error = '磁盘文件已变化，本地修改尚未保存'
          continue
        }

        latestTab.raw = post.raw
        latestTab.originalRaw = post.raw
        latestTab.revision += 1
        latestTab.savedRevision = latestTab.revision
        latestTab.serverMtime = post.mtime
        latestTab.saveStatus = 'idle'
        latestTab.error = null
        latestTab.externalKind = null
      } catch {
        if (!sessionStillCurrent(requestedPath, sessionGeneration)) continue
        if (!isCurrentDiskRead(requestedPath, readId)) continue
        const latestTab = options.tabs.value.find((item) => item.path === requestedPath)
        if (
          latestTab === requestedTab
          && latestTab.savingRevision === null
          && latestTab.revision === requestedRevision
          && latestTab.savedRevision === requestedSavedRevision
          && latestTab.originalRaw === requestedOriginalRaw
          && latestTab.serverMtime === requestedServerMtime
          && latestTab.saveStatus === requestedSaveStatus
          && latestTab.externalRaw === requestedExternalRaw
          && latestTab.loadError === requestedLoadError
        ) {
          // State confirmed that the path exists. A failed body read is not
          // evidence of deletion and must not route keep-local through recover.
          latestTab.externalKind = 'unreadable'
          latestTab.saveStatus = 'external'
          latestTab.loadError = null
          latestTab.error = '暂时无法读取磁盘文件，将在下次检查时重试'
        }
      }
    }
  }

  function handleOnline() {
    for (const tab of options.tabs.value) {
      if (tab.saveStatus === 'offline') void options.doSave(tab.path)
    }
  }

  async function resolveExternal(path: string, strategy: 'disk' | 'local') {
    const tab = options.tabs.value.find((item) => item.path === path)
    if (!tab || tab.saveStatus !== 'external') return
    if (tab.externalKind === 'deleted' && strategy === 'disk') return
    const requestedExternalKind = tab.externalKind
    const sessionGeneration = captureDiarySessionGeneration()
    const resolutionId = beginExternalResolution(path)
    try {
    if (tab.externalKind === 'unreadable') {
      const requestedTab = tab
      const requestedPath = tab.path
      const requestedRevision = tab.revision
      try {
        const post = await getPost(requestedPath)
        if (!sessionStillCurrent(requestedPath, sessionGeneration)) return
        if (!isCurrentExternalResolution(
          requestedPath,
          resolutionId,
          requestedTab,
          requestedExternalKind,
        )) return
        const latestTab = options.tabs.value.find((item) => item.path === requestedPath)
        if (latestTab !== requestedTab || latestTab.path !== requestedPath) return

        latestTab.externalRaw = post.raw
        latestTab.externalKind = 'modified'
        latestTab.serverMtime = post.mtime
        latestTab.loadError = null
        if (latestTab.revision !== requestedRevision) {
          if (strategy === 'local') {
            latestTab.originalRaw = post.raw
            latestTab.externalRaw = null
            latestTab.externalKind = null
            latestTab.saveStatus = latestTab.raw === post.raw ? 'idle' : 'dirty'
            if (latestTab.saveStatus === 'idle') {
              latestTab.savedRevision = latestTab.revision
            } else {
              options.scheduleSave(path, 0)
            }
            latestTab.error = null
          } else {
            latestTab.error = null
          }
          return
        }
      } catch {
        if (!sessionStillCurrent(requestedPath, sessionGeneration)) return
        if (!isCurrentExternalResolution(
          requestedPath,
          resolutionId,
          requestedTab,
          requestedExternalKind,
        )) return
        const latestTab = options.tabs.value.find((item) => item.path === requestedPath)
        if (latestTab === requestedTab) {
          latestTab.error = '暂时无法读取磁盘文件，将在下次检查时重试'
        }
        return
      }
    }
    if (strategy === 'disk') {
      if (!sessionStillCurrent(path, sessionGeneration)) return
      const diskRaw = tab.externalRaw
      const post = diskRaw === null ? await getPost(path) : null
      if (!sessionStillCurrent(path, sessionGeneration)) return
      const resolvedRaw = diskRaw ?? post!.raw
      tab.raw = resolvedRaw
      tab.originalRaw = resolvedRaw
      tab.revision += 1
      tab.savedRevision = tab.revision
      if (post) tab.serverMtime = post.mtime
      tab.savingRevision = null
      tab.saveStatus = 'idle'
    } else if (tab.externalKind === 'deleted') {
      const sentRaw = tab.raw
      const sentRevision = tab.revision
      let recovered: Awaited<ReturnType<typeof recoverPost>>
      try {
        recovered = await recoverPost(path, sentRaw)
        if (!sessionStillCurrent(path, sessionGeneration)) return
        // Concurrent deleted keep-local requests express the same intent. If an
        // older request is the one that recreates the file, applying that
        // successful transaction also settles any newer duplicate request.
        const latestTab = options.tabs.value.find((item) => item.path === path)
        const recoveryObservedByPoll = latestTab?.saveStatus === 'external'
          && latestTab.externalKind === 'modified'
          && latestTab.externalRaw === recovered.raw
        if (
          latestTab !== tab
          || latestTab.saveStatus !== 'external'
          || (
            latestTab.externalKind !== requestedExternalKind
            && !recoveryObservedByPoll
          )
        ) return
      } catch (recoverError) {
        if (!isCurrentExternalResolution(
          path,
          resolutionId,
          tab,
          requestedExternalKind,
        )) return
        try {
          const post = await getPost(path)
          if (!sessionStillCurrent(path, sessionGeneration)) return
          if (!isCurrentExternalResolution(
            path,
            resolutionId,
            tab,
            requestedExternalKind,
          )) return
          const latestTab = options.tabs.value.find((item) => item.path === path)
          if (latestTab !== tab || latestTab.path !== path) return
          if (post.raw === latestTab.raw) {
            latestTab.originalRaw = post.raw
            latestTab.savedRevision = latestTab.revision
            latestTab.serverMtime = post.mtime
            latestTab.savingRevision = null
            latestTab.saveStatus = 'saved'
            latestTab.externalRaw = null
            latestTab.externalKind = null
            latestTab.loadError = null
            latestTab.error = null
            return
          }
          latestTab.externalRaw = post.raw
          latestTab.externalKind = 'modified'
          latestTab.serverMtime = post.mtime
          latestTab.saveStatus = 'external'
          latestTab.loadError = null
          latestTab.error = '磁盘文件已重新出现，请重新选择使用磁盘或保留本地版本'
          return
        } catch {
          throw recoverError
        }
      }
      tab.originalRaw = recovered.raw
      tab.savedRevision = sentRevision
      tab.serverMtime = recovered.mtime
      options.applyPostSummary(recovered.post)
      options.fileChanges.publish({
        path,
        kind: 'write',
        source: 'editor-lifecycle',
        newMtime: recovered.mtime,
      })
      if (tab.revision === sentRevision) {
        tab.saveStatus = 'saved'
      } else {
        tab.saveStatus = 'dirty'
        options.scheduleSave(path, 0)
      }
    } else {
      if (!sessionStillCurrent(path, sessionGeneration)) return
      const diskRaw = tab.externalRaw
      if (diskRaw == null) return
      tab.originalRaw = diskRaw
      tab.externalRaw = null
      tab.externalKind = null
      if (tab.raw === diskRaw) {
        tab.savedRevision = tab.revision
        tab.saveStatus = 'idle'
      } else {
        tab.saveStatus = 'dirty'
        options.scheduleSave(path, 0)
      }
    }
    if (!sessionStillCurrent(path, sessionGeneration)) return
    tab.externalRaw = null
    tab.externalKind = null
    tab.error = null
    tab.loadError = null
    } finally {
      // Release the pending-resolution slot only if this resolution is still
      // the latest one for the path; a newer resolution owns its own slot.
      endExternalResolutionIfCurrent(path, resolutionId)
    }
  }

  function startExternalPolling() {
    externalPollTimer = setInterval(() => { void pollExternalChanges() }, 5_000)
  }

  function stopExternalPolling() {
    if (externalPollTimer) clearInterval(externalPollTimer)
    externalPollTimer = null
  }

  return {
    handleOnline,
    pollExternalChanges,
    resolveExternal,
    startExternalPolling,
    stopExternalPolling,
    invalidateDiskRead,
    invalidateDiskObservation,
  }
}
