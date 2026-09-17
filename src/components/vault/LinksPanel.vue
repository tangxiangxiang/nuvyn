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
// Click on any item emits `navigate` with the target path so the
// parent (VaultView) can route through `useEditorTabs.openPost`.
// Same shape as FileTree / TagPanel emits.

import { computed, ref, watch, watchEffect, onMounted, onBeforeUnmount } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { FileText } from '@vicons/tabler'
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
  navigate: [path: string]
}>()
const { t } = useI18n()

const indexState = getLinkIndex()
const vaultContext = useOptionalVaultContext()
const fileBus = vaultContext?.fileChanges.events ?? getFallbackVaultFileChanges().events
const { linksEmpty } = useVaultTocState()

const backlinks = ref<BacklinkRecord[]>([])

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

/** Drop the leading protected root (`inbox/`, `archive/`, etc.) so
 *  the panel rows read as "the meaningful tail", matching what
 *  TagPanel / FileTree do. */
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
    label: l.alias ?? displayTitle(l.target),
    anchor: l.anchor,
    kind: l.kind,
  }))
})

async function refetchBacklinks() {
  const p = activePath.value
  if (!p) {
    backlinks.value = []
    return
  }
  try {
    backlinks.value = await fetchBacklinks(p)
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
  if (busStop) {
    busStop()
    busStop = null
  }
})

// Re-fetch when the active path changes (no debounce — switching
// notes is a discrete user action).
watch(activePath, () => {
  // Cancel any pending debounce — a path change overrides it.
  const d = debouncedRefetch as { cancel?: () => void }
  d.cancel?.()
  void refetchBacklinks()
})

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
      <section v-if="backlinks.length" class="section" :aria-label="t('links.backlinks')">
        <header class="section-header">
          <span class="section-title">{{ t('links.count', { label: t('links.backlinks'), count: backlinks.length }) }}</span>
        </header>
        <ul class="link-list">
          <li v-for="b in backlinks" :key="b.source">
            <NButton
              class="link-entry"
              attr-type="button"
              text
              :bordered="false"
              :title="b.source"
              @click="emit('navigate', b.source)"
            >
              <NIcon class="link-icon" aria-hidden="true"><FileText /></NIcon>
              <span class="link-copy">
                <span class="link-title">{{ displayTitle(b.source) }}</span>
                <span class="link-path">{{ directoryLabel(b.source) }}</span>
              </span>
            </NButton>
          </li>
        </ul>
      </section>

      <section v-if="outgoingDisplay.length" class="section" :aria-label="t('links.outgoing')">
        <header class="section-header">
          <span class="section-title">{{ t('links.count', { label: t('links.outgoing'), count: outgoingDisplay.length }) }}</span>
        </header>
        <ul class="link-list">
          <li v-for="l in outgoingDisplay" :key="l.target + (l.anchor ?? '')">
            <NButton
              class="link-entry"
              attr-type="button"
              text
              :bordered="false"
              :title="l.target"
              @click="emit('navigate', l.target)"
            >
              <NIcon class="link-icon" aria-hidden="true"><FileText /></NIcon>
              <span class="link-copy">
                <span class="link-title">{{ l.label }}</span>
                <span class="link-path">{{ directoryLabel(l.target) }}</span>
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
.section + .section { margin-top: 18px; }
.section-header {
  display: flex;
  align-items: center;
  padding: 0 22px 5px;
  font-size: 0.7rem;
  color: var(--vs-text-2, var(--text-muted));
}
.section-title { font-weight: 600; }

.link-list {
  list-style: none;
  margin: 0;
  padding: 0 14px;
  display: grid;
  gap: 6px;
}
.link-entry {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border-radius: 4px;
  background: transparent;
  border: 0;
  color: var(--vs-text, var(--text));
  text-align: left;
  cursor: pointer;
  font: inherit;
  font-size: 0.84rem;
}
.link-entry:hover {
  background: color-mix(in srgb, var(--vs-hover-bg, var(--bg-soft)) 58%, transparent);
  color: var(--vs-text-1, var(--text));
}
.link-entry:active {
  background: color-mix(in srgb, var(--vs-accent, var(--accent)) 10%, transparent);
}
.link-icon {
  display: inline-flex;
  margin-top: 2px;
  color: var(--vs-text-3, var(--text-muted));
}
.link-copy { min-width: 0; display: grid; gap: 1px; }
.link-title {
  font-weight: 500;
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
