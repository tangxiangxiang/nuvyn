<script setup lang="ts">
// Side panel for bi-directional links. Shows, for the active note:
//
//   - "Linked by" — notes that link TO the current note (backlinks)
//   - "Links to"  — notes the current note links to (outgoing)
//
// Both are derived from the server's link index (`useLinkIndex`):
// outgoing comes from the snapshot's `outgoing[path]` (no round-trip),
// backlinks come from a per-path fetch of `/api/backlinks?path=…`.
//
// Clicks emit the target path. Outgoing links also carry their destination
// anchor; backlink anchors belong to the target Note and are never navigated
// on the source Note.

import { computed, ref, watch, watchEffect, onMounted, onBeforeUnmount } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { ArrowLeft, ArrowRight, ArrowsLeftRight, FileText } from '@vicons/tabler'
import { useDebounceFn } from '@vueuse/core'
import type { PostSummary, BacklinkRecord } from '../../lib/api'
import { getLinkIndex, fetchBacklinks } from '../../composables/vault/useLinkIndex'
import { getFallbackVaultFileChanges } from '../../composables/vault/context/fileChanges'
import { useOptionalVaultContext } from '../../composables/vault/context/useVaultContext'
import { useVaultTocState } from '../../composables/vault/useTocState'
import { PROTECTED_ROOTS } from '../../../shared/archiveProtocol'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  /** Path of the currently active note, or null if no note is open. */
  path: string | null
  /** All posts (for friendly title resolution in the link rows). */
  posts: PostSummary[]
}>()

const emit = defineEmits<{
  navigate: [path: string, anchor?: string]
}>()
const { t } = useI18n()

const indexState = getLinkIndex()
const vaultContext = useOptionalVaultContext()
const fileBus = vaultContext?.fileChanges.events ?? getFallbackVaultFileChanges().events
const { linksEmpty } = useVaultTocState()

const backlinks = ref<BacklinkRecord[]>([])
let backlinksRun = 0

/** Path of the outgoing section. Stored separately from `props.path`
 *  so the debounce doesn't fire a re-fetch on every keystroke when
 *  the source path is unchanged (which it is — the user is editing
 *  the *content* of the current note, not switching notes). */
const activePath = computed(() => props.path)

/** Resolve a post's friendly title from the `posts` prop. Falls
 *  back to the path tail when the post is unknown (e.g. the index
 *  has been updated but the posts list hasn't). */
const titleByPath = computed(() => {
  const m = new Map<string, string>()
  for (const p of props.posts) m.set(p.path, p.title)
  return m
})

function displayTitle(p: string): string {
  return titleByPath.value.get(p) ?? p.split('/').at(-1) ?? p
}

const duplicateTitles = computed(() => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const title of titleByPath.value.values()) {
    if (seen.has(title)) duplicates.add(title)
    seen.add(title)
  }
  return duplicates
})

function linkTooltip(path: string, anchor?: string, alias?: string): string {
  return [displayTitle(path), anchor ? `${path}#${anchor}` : path, alias]
    .filter(Boolean).join('\n')
}

/** Compact directory labels disambiguate documents with the same title. */
function directoryLabel(p: string): string {
  const parts = p.split('/')
  parts.pop()
  if (!parts.length) return t('links.root')
  const labels = parts.map((part, index) => {
    if (index === 0 && PROTECTED_ROOTS.has(part)) return part.charAt(0).toUpperCase() + part.slice(1)
    return part.replace(/-/g, ' ')
  })
  return labels.length <= 2 ? labels.join(' / ') : `${labels[0]} / … / ${labels.at(-1)}`
}

/** Outgoing links for the current path, derived from the
 *  Vault-scoped index snapshot. No async fetch needed — the index
 *  is refreshed in the background by `useLinkIndexSubscription`. */
const outgoing = computed(() => {
  const p = activePath.value
  if (!p) return []
  return indexState.value.outgoing[p] ?? []
})

const outgoingDisplay = computed(() => {
  return outgoing.value.map((l) => ({
    target: l.target,
    label: displayTitle(l.target),
    alias: l.alias,
    anchor: l.anchor,
    kind: l.kind,
  }))
})

const relationshipGroups = computed(() => {
  const sources = new Set(backlinks.value.map((link) => link.source))
  const targets = new Map<string, typeof outgoingDisplay.value>()
  for (const link of outgoingDisplay.value) {
    const links = targets.get(link.target) ?? []
    links.push(link)
    targets.set(link.target, links)
  }
  const mutual = [...targets.keys()].filter((path) => sources.has(path))
  const row = (path: string, navigateToAnchor = false) => {
    const links = targets.get(path) ?? []
    return {
      path,
      label: displayTitle(path),
      anchor: navigateToAnchor ? links[0]?.anchor : undefined,
      tooltip: [...new Set(links.length
        ? links.map((link) => linkTooltip(path, link.anchor, link.alias))
        : [linkTooltip(path)])].join('\n'),
    }
  }
  return [
    { key: 'links.mutual', icon: ArrowsLeftRight, rows: mutual.map((path) => row(path)) },
    { key: 'links.backlinks', icon: ArrowLeft, rows: [...sources].filter((path) => !targets.has(path)).map((path) => row(path)) },
    { key: 'links.outgoing', icon: ArrowRight, rows: [...targets.keys()].filter((path) => !sources.has(path)).map((path) => row(path, true)) },
  ].filter((group) => group.rows.length)
})

async function refetchBacklinks() {
  const run = ++backlinksRun
  const p = activePath.value
  if (!p) {
    backlinks.value = []
    return
  }
  try {
    const result = await fetchBacklinks(p)
    if (run !== backlinksRun || activePath.value !== p) return
    backlinks.value = result
  } catch {
    // Network blip; keep the previous list. The next debounce will retry.
  }
}

// Debounced re-fetch on (a) path change, (b) any bus event.
// `useLinkIndexSubscription` is what populates the outgoing index;
// this is its mirror for the backlinks (which aren't in the snapshot
// for wire-size reasons).
const debouncedRefetch = useDebounceFn(() => { void refetchBacklinks() }, 400)

let busStop: (() => void) | null = null
let lastSeenSeq = 0

onMounted(() => {
  void refetchBacklinks()
  // Subscribe to bus for "any file changed → backlinks may have moved"
  // notifications. Same `seq` dedup pattern useEditorTabs uses.
  busStop = watch(
    () => fileBus.value,
    (events) => {
      const latest = events.at(-1)?.seq ?? lastSeenSeq
      if (latest <= lastSeenSeq) return
      lastSeenSeq = latest
      debouncedRefetch()
    },
    { flush: 'post' },
  )
})

onBeforeUnmount(() => {
  backlinksRun += 1
  if (busStop) {
    busStop()
    busStop = null
  }
})

// Re-fetch when the active path changes (no debounce — switching
// notes is a discrete user action).
watch(activePath, () => {
  // A path switch must never present the previous note's backlinks while
  // the new request is pending or if it fails. Same-path refreshes leave
  // the current presentation untouched on transient errors.
  backlinks.value = []
  // Cancel any pending debounce — a path change overrides it.
  const d = debouncedRefetch as { cancel?: () => void }
  d.cancel?.()
  void refetchBacklinks()
}, { flush: 'sync' })

const isEmpty = computed(() =>
  !activePath.value ||
  (backlinks.value.length === 0 && outgoingDisplay.value.length === 0),
)

/* Publish the empty state to the right-rail state module so RightRail
   (a sibling, not a parent) can drive the rail's collapse. A
   watchEffect re-runs whenever `isEmpty` flips, which is what
   keeps the published ref in lockstep. The `isEmpty` computed
   depends on activePath, backlinks, and outgoing — watchEffect
   tracks all three transitively. */
watchEffect(() => {
  linksEmpty.value = isEmpty.value
})
</script>

<template>
  <aside class="links-panel" :aria-label="t('links.panel')">
    <div v-if="!activePath" class="right-rail-empty-state">
      {{ t('links.open_document') }}
    </div>
    <div v-else-if="isEmpty" class="right-rail-empty-state">
      {{ t('links.empty') }}
    </div>

    <div v-else class="links-content">
      <!-- Hide a section entirely when it has nothing to show. The
           overall isEmpty branch above covers the "both empty" case,
           so the per-section "No backlinks" / "No outgoing" messages
           and the section headers (with their "0" count) are
           redundant — dropping them keeps the panel down to what
           the note actually has. -->
      <section v-for="group in relationshipGroups" :key="group.key" class="section" :aria-label="t(group.key)">
        <header class="section-header">
          <span class="section-title">
            <NIcon class="section-icon" aria-hidden="true"><component :is="group.icon" /></NIcon>
            {{ t(group.key) }}
          </span>
          <span class="section-count">{{ group.rows.length }}</span>
        </header>
        <ul class="link-list">
          <li v-for="link in group.rows" :key="link.path">
            <NButton
              class="link-entry"
              :class="{ 'is-active': link.path === activePath }"
              attr-type="button"
              text
              :bordered="false"
              :title="link.tooltip"
              @click="link.anchor ? emit('navigate', link.path, link.anchor) : emit('navigate', link.path)"
            >
              <NIcon class="link-icon" aria-hidden="true"><FileText /></NIcon>
              <span class="link-copy">
                <span class="link-title">{{ link.label }}</span>
                <span v-if="duplicateTitles.has(link.label)" class="link-path">{{ directoryLabel(link.path) }}</span>
              </span>
            </NButton>
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.links-panel {
  display: block;
  background: var(--vs-side-bg, var(--vs-bg-1));
  color: var(--vs-text, var(--text));
  height: auto;
  overflow: visible;
}
.links-content {
  padding-top: 8px;
}

.section {
  display: block;
}
.section + .section { margin-top: 8px; }
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 16px 6px;
  font-size: 0.7rem;
  color: var(--vs-text-2, var(--text-muted));
}
.section-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.section-icon { font-size: 14px; }
.section-count { font-weight: 400; font-variant-numeric: tabular-nums; }

.link-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0;
}
.link-entry {
  display: flex;
  justify-content: flex-start;
  width: 100%;
  height: auto;
  min-height: 30px;
  padding: 5px 16px;
  border-radius: 0;
  background: transparent;
  border: 0;
  color: var(--vs-text, var(--text));
  text-align: left;
  cursor: pointer;
  font: inherit;
  font-size: 0.84rem;
}
.link-entry :deep(.n-button__content) {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
}
.links-panel .link-entry:hover,
.links-panel .link-entry:focus-visible {
  background: var(--vs-hover-bg, var(--bg-soft));
  color: var(--vs-text-1, var(--text));
}
.links-panel .link-entry.is-active {
  background: var(--vs-selection-bg, var(--bg-soft));
  color: var(--vs-text-1, var(--text));
}
.link-entry.is-active .link-title { font-weight: 600; }
.link-icon {
  display: inline-flex;
  color: var(--vs-text-3, var(--text-muted));
}
.link-copy { min-width: 0; display: grid; gap: 1px; }
.link-title {
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.link-path {
  font-size: 0.7rem;
  color: var(--vs-text-3, var(--text-muted));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
</style>
