<script setup lang="ts">
// Unified right rail. Lightweight tabs switch one shared content
// region between the TOC, bi-directional links, document properties,
// single-file history, and AI assistant.
//
// Components:
//   - The TOC list comes from ReadingPane via Vault-scoped useTocState
//     (ReadingPane owns the IntersectionObserver scroll-
//     spy, RightRail only renders the active-highlighted list).
//   - The Links panel is a full embed of <LinksPanel>. It needs
//     `path` and `posts` props, which VaultView passes through.
//     We forward `navigate` to VaultView as `link-navigate` so the
//     parent can route through openPost.

import { computed, nextTick, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { useVaultTocState } from '../../composables/vault/useTocState'
import { useI18n } from '../../composables/useI18n'
import type { DocumentMetadata, PostSummary } from '../../lib/api'
import LinksPanel from './LinksPanel.vue'
import AiPanel from './AiPanel.vue'
import DocumentMetadataForm from './DocumentMetadataForm.vue'
import type { MetadataContext } from './metadataDraftStore'
import RightRailHistory from './RightRailHistory.vue'
import { resolveFileHistoryTarget, type FileHistoryState } from '../../composables/vault/useFileHistory'
import type { HistoryRevisionSelection } from '../../composables/vault/useHistoryComparisons'
import type { RightRailTab } from '../../composables/vault/useVaultLayout'

const { tocHeadings, tocActiveId, tocScrollTo } = useVaultTocState()
const { t } = useI18n()

const props = defineProps<{
  /** Active note path. Forwarded to <LinksPanel>. */
  path: string | null
  /** All posts (title resolution for link rows). Forwarded to <LinksPanel>. */
  posts: PostSummary[]
  activeTab: RightRailTab
  /** True when the vault is showing the reading surface. */
  isReadMode?: boolean
  /** Shared single-file history state owned by VaultView. */
  fileHistory?: FileHistoryState
  metadataContext?: MetadataContext
  metadataReadonly?: boolean
  summarySource?: string | null
}>()

const emit = defineEmits<{
  /** Emitted when the user clicks a row in the Links panel. */
  'link-navigate': [path: string]
  'metadata-saved': [metadata: DocumentMetadata]
  'update:activeTab': [tab: RightRailTab]
  'switch-to-read': []
  'open-history-revision': [selection: HistoryRevisionSelection]
}>()

// Keep the rail outline compact: the first three heading levels provide
// enough document structure without flooding the narrow sidebar with
// deeply nested details.
const visibleHeadings = computed(() => tocHeadings.value.filter((heading) => heading.level <= 3))
const hasHeadings = computed(() => visibleHeadings.value.length > 0)
const documentPaths = computed(() => props.posts.map((post) => post.path))
const aiHasOpened = ref(props.activeTab === 'ai')
const tabsRef = ref<HTMLElement | null>(null)
const metadataDirty = ref(false)

async function scrollActiveTabIntoView(tab: RightRailTab): Promise<void> {
  await nextTick()
  const active = tabsRef.value?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)
  active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

// Mount AI only when the user first visits it, then keep it mounted while
// switching tabs so its conversation, draft, picker, and scroll position
// remain intact. The immediate run also handles a tab restored from
// localStorage before the rail first paints.
watch(() => props.activeTab, (tab) => {
  if (tab === 'ai') aiHasOpened.value = true
  void scrollActiveTabIntoView(tab)
}, { immediate: true })

function openHistoryForCurrentPath(force = false): void {
  const fileHistory = props.fileHistory
  const path = props.path
  if (!fileHistory || !path || fileHistory.loading.value) return

  const targetMatches = fileHistory.target.value?.documentPath === path
  if (targetMatches && fileHistory.loaded.value && !(force && fileHistory.error.value)) return
  if (targetMatches && fileHistory.error.value && force) {
    void fileHistory.refresh()
    return
  }
  void fileHistory.open(resolveFileHistoryTarget(path, props.posts))
}

watch(
  () => [props.activeTab, props.path, props.fileHistory?.target.value?.documentPath] as const,
  ([tab]) => {
    if (tab !== 'history') return
    openHistoryForCurrentPath()
  },
  { immediate: true },
)

function onTocClick(id: string) {
  tocScrollTo.value?.(id)
}

function onLinkNavigate(p: string) {
  emit('link-navigate', p)
}

function onHistoryTabClick(): void {
  emit('update:activeTab', 'history')
  openHistoryForCurrentPath(true)
}
</script>

<template>
  <div class="right-rail">
    <nav ref="tabsRef" class="sidebar-tabs" role="tablist" :aria-label="t('rail.navigation')">
      <!-- Edit-10.3: the old "no AI in read-only views" gate is lifted —
           History/Diff/Recovery views now transport their own live
           context (readOnly snapshots) instead of being cut off. -->
      <NButton
        attr-type="button"
        text
        :bordered="false"
        role="tab"
        data-tab="ai"
        :aria-selected="activeTab === 'ai'"
        :class="{ active: activeTab === 'ai' }"
        @click="emit('update:activeTab', 'ai')"
      >{{ t('rail.ai') }}</NButton>
      <NButton attr-type="button" text :bordered="false" role="tab" data-tab="toc" :aria-selected="activeTab === 'toc'" :class="{ active: activeTab === 'toc' }" @click="emit('update:activeTab', 'toc')">{{ t('rail.toc') }}</NButton>
      <NButton attr-type="button" text :bordered="false" role="tab" data-tab="links" :aria-selected="activeTab === 'links'" :class="{ active: activeTab === 'links' }" @click="emit('update:activeTab', 'links')">{{ t('rail.links') }}</NButton>
      <NButton
        attr-type="button"
        text
        :bordered="false"
        role="tab"
        data-tab="properties"
        :aria-selected="activeTab === 'properties'"
        :aria-label="metadataDirty ? `${t('rail.properties')}，${t('metadata.unsaved')}` : t('rail.properties')"
        :class="{ active: activeTab === 'properties' }"
        @click="emit('update:activeTab', 'properties')"
      >{{ t('rail.properties') }}<span v-if="metadataDirty" class="metadata-dirty-mark" aria-hidden="true">●</span></NButton>
      <NButton attr-type="button" text :bordered="false" role="tab" data-tab="history" :aria-selected="activeTab === 'history'" :class="{ active: activeTab === 'history' }" @click="onHistoryTabClick">{{ t('rail.history') }}</NButton>
    </nav>

    <section v-show="activeTab === 'toc'" class="toc-panel" role="tabpanel" :aria-label="t('rail.toc')">
      <header v-if="path" class="right-rail-path-header">
        <span :title="path">{{ path }}</span>
      </header>

      <div v-if="!hasHeadings" class="right-rail-empty-state">
        <p>{{ props.isReadMode ? t('rail.toc_empty') : t('rail.toc_empty_edit') }}</p>
        <NButton
          v-if="!props.isReadMode"
          attr-type="button"
          :bordered="false"
          class="right-rail-empty-action"
          @click="emit('switch-to-read')"
        >{{ t('rail.switch_to_read') }}</NButton>
      </div>
      <ul v-else class="toc-panel-list">
        <li
          v-for="h in visibleHeadings"
          :key="h.id"
          :class="['toc-panel-item', `lvl-${h.level}`, { active: tocActiveId === h.id }]"
        >
          <a
            class="toc-panel-link"
            :href="`#${h.id}`"
            :title="h.text"
            @click.prevent="onTocClick(h.id)"
          >
            <span class="toc-panel-link-text">{{ h.text }}</span>
          </a>
        </li>
      </ul>
    </section>

    <section v-show="activeTab === 'links'" class="links-slot" role="tabpanel" :aria-label="t('rail.links_panel')">
      <header v-if="path" class="right-rail-path-header">
        <span :title="path">{{ path }}</span>
      </header>
      <LinksPanel
        :path="path"
        :posts="posts"
        @navigate="onLinkNavigate"
      />
    </section>
    <section v-show="activeTab === 'properties'" class="metadata-slot" role="tabpanel" :aria-label="t('metadata.title')">
      <header v-if="path" class="right-rail-path-header">
        <span :title="path">{{ path }}</span>
      </header>
      <DocumentMetadataForm
        :path="path"
        :enabled="activeTab === 'properties'"
        :show-cancel="false"
        :readonly="metadataReadonly ?? false"
        :context="metadataContext ?? 'document'"
        :summary-source="summarySource"
        @saved="emit('metadata-saved', $event)"
        @dirty-change="metadataDirty = $event"
      />
    </section>
    <section v-show="activeTab === 'history'" class="history-slot" role="tabpanel" :aria-label="t('rail.history')">
      <RightRailHistory
        v-if="fileHistory"
        :file-history="fileHistory"
        :path="path"
        @open-revision="emit('open-history-revision', $event)"
      />
      <div v-else class="right-rail-history-empty right-rail-empty-state">{{ t('rail.history_empty') }}</div>
    </section>
    <section v-if="aiHasOpened" v-show="activeTab === 'ai'" class="ai-slot" role="tabpanel" :aria-label="t('rail.ai')">
      <AiPanel :document-paths="documentPaths" />
    </section>
  </div>
</template>

<style scoped>
.right-rail {
  height: 100%;
  min-height: 0;
  background: var(--vs-side-bg, var(--vs-bg-1));
  overflow-x: hidden;
  overflow-y: hidden;
}

/* Right-rail tab nav. Modeled on Figma / Linear / Notion / Cursor
   right-side panel headers: text-only, no per-tab cards or vertical
   dividers, a single thin strip with a short accent line under the
   active label.

   - The active indicator is `border-bottom` on the button itself.
     Because the button is `inline-flex` with `padding: 0`, its width
     collapses to the label width, so the 2px accent reads as an
     underline under just the active text — not a full-width tab bar.
   - The transparent default border reserves the same 2px on inactive
     tabs so the label never shifts when a tab becomes active.
   - `box-sizing: border-box` keeps the reserved 2px inside the 36px
     row height instead of pushing the button past it. */
.sidebar-tabs {
  display: flex;
  align-items: stretch;
  gap: clamp(8px, 2vw, 20px);
  height: 36px;
  box-sizing: border-box;
  padding: 0 14px;
  border-bottom: 1px solid var(--vs-border, var(--border));
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.sidebar-tabs::-webkit-scrollbar { display: none; }
.sidebar-tabs button {
  display: inline-flex;
  align-items: center;
  height: 100%;
  padding: 0;
  border: 0;
  border-bottom: 2px solid transparent;
  box-sizing: border-box;
  background: transparent;
  color: var(--vs-text-3, var(--text-muted));
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  flex: 0 0 auto;
  white-space: nowrap;
}
.sidebar-tabs button:hover { color: var(--vs-text-1, var(--text)); }
.sidebar-tabs button:disabled { cursor: not-allowed; opacity: 0.45; }
.sidebar-tabs button.active {
  color: var(--vs-text-1, var(--text));
  font-weight: 600;
  border-bottom-color: var(--vs-accent, var(--accent));
}
.metadata-dirty-mark { margin-left: 4px; color: var(--vs-accent, var(--accent)); font-size: 0.7em; }

.toc-panel,
.links-slot,
.metadata-slot,
.history-slot {
  display: block;
  height: calc(100% - 36px);
  box-sizing: border-box;
  padding-top: 14px;
  padding-bottom: 24px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.ai-slot { height: calc(100% - 36px); min-height: 0; }
.ai-slot :deep(.ai-panel) { height: 100%; }
.toc-panel {
  padding-top: 0;
  padding-bottom: 0;
}
.links-slot {
  padding-top: 0;
  padding-bottom: 0;
}
.metadata-slot {
  display: flex;
  flex-direction: column;
  padding-top: 0;
  padding-bottom: 0;
  overflow: hidden;
}
.history-slot {
  padding: 0;
  overflow: hidden;
}
.history-slot :deep(.right-rail-history) { height: 100%; }
.metadata-slot :deep(.document-metadata-form) {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.metadata-slot :deep(.document-metadata-body),
.metadata-slot :deep(.document-metadata-empty) {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.metadata-slot :deep(.document-metadata-body) {
  gap: 9px;
  padding: 11px 12px 12px;
}

/* Labels: uppercase letter-spaced micro labels (VS Code form section style).
   text-transform is a no-op on CJK glyphs but harmless and keeps EN parity.

   The field's CSS-grid gap is forced to 0 (with !important as a defensive
   override of DocumentMetadataForm.vue's scoped `gap: 6px`). The label itself
   uses line-height: 1 so the box collapses to the actual glyph height, and
   the visual gap to the input is controlled by the input's own margin-top
   instead of the label's margin-bottom — that way the spacing rule lives
   next to the element it affects. */
.metadata-slot :deep(.document-metadata-field) {
  gap: 0 !important;
}
.metadata-slot :deep(.document-metadata-field > span),
/* The summary field's label sits inside .document-metadata-field-head (a flex
   row that also hosts the AI-generate button), so the direct-child selector
   above doesn't match it. Mirror the same rules for the head's span so the
   three field labels stay visually identical. */
.metadata-slot :deep(.document-metadata-field-head > span) {
  font-size: 0.58rem;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.metadata-slot :deep(.document-metadata-field > .document-metadata-input) {
  margin-top: 2px;
}

/* Inputs: invisible border by default — only show on hover/focus, like inline
   editing. Cursor/VS Code settings UI uses this pattern to keep the form from
   feeling like a stack of "form fields" and more like a labeled document. */
.metadata-slot :deep(.document-metadata-field input),
.metadata-slot :deep(.document-metadata-field textarea) {
  font-family: inherit;
  padding: 4px 7px;
  font-size: 0.8rem;
  line-height: 1.35;
  border: 1px solid transparent;
  border-radius: 3px;
  background: var(--bg-soft);
  transition: border-color 0.12s ease, background 0.12s ease;
}
.metadata-slot :deep(.document-metadata-field input:hover:not(:disabled)),
.metadata-slot :deep(.document-metadata-field textarea:hover:not(:disabled)) {
  border-color: var(--border);
}
.metadata-slot :deep(.document-metadata-field input:focus),
.metadata-slot :deep(.document-metadata-field textarea:focus) {
  border-color: var(--accent);
  background: var(--bg);
}
.metadata-slot :deep(.document-metadata-field input) {
  height: 26px;
  min-height: 26px;
}
.metadata-slot :deep(.document-metadata-textarea-wrap textarea) {
  padding-right: 8px;
  padding-bottom: 20px;
}
.metadata-slot :deep(.document-metadata-field textarea) {
  min-height: 60px;
  resize: vertical;
}

/* Char counter — tabular numerals, sits inside the textarea's bottom-right. */
.metadata-slot :deep(.document-metadata-field small) {
  right: 6px;
  bottom: 5px;
  font-size: 0.58rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

/* AI generate — ghost button on the field-head row, label left, action right.
   No positioning needed; the head is a flex row with space-between. */
.metadata-slot :deep(.metadata-generate-summary) {
  min-height: 18px;
  padding: 0 5px;
  font-size: 0.58rem;
  border-radius: 3px;
  color: var(--text-muted);
  background: transparent;
}
.metadata-slot :deep(.metadata-generate-summary:hover:not(:disabled)) {
  color: var(--accent);
  background: var(--code-bg);
}
.metadata-slot :deep(.metadata-generate-summary-icon) {
  flex-basis: 11px;
}
.metadata-slot :deep(.metadata-generate-summary-icon svg) {
  width: 11px;
  height: 11px;
}

/* Readonly section — vertical key-value list (VS Code info panel).
   Label on the left in tiny uppercase, value on the right with tabular
   numerals (mono where it's an ID or path). Hairline dividers separate
   the rows; the section is capped by a top border so it reads as its
   own block. */
.metadata-slot :deep(.document-metadata-readonly) {
  display: grid;
  grid-template-columns: 1fr;
  margin: 4px 0 0;
  border-top: 1px solid var(--border);
}
.metadata-slot :deep(.document-metadata-readonly > div) {
  display: grid;
  grid-template-columns: minmax(72px, max-content) 1fr;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}
.metadata-slot :deep(.document-metadata-readonly > div:last-child) {
  border-bottom: 0;
}
.metadata-slot :deep(.document-metadata-readonly > div:nth-child(odd)),
.metadata-slot :deep(.document-metadata-readonly > div:nth-child(even)) {
  padding-left: 12px;
  padding-right: 12px;
  border-left: 0;
}
.metadata-slot :deep(.document-metadata-readonly span) {
  font-size: 0.58rem;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.metadata-slot :deep(.document-metadata-readonly output) {
  font-size: 0.72rem;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.metadata-slot :deep(.document-metadata-readonly output.is-mono) {
  font-family: var(--mono);
  font-size: 0.68rem;
}

/* Action footer — ghost text buttons. Save uses accent text on hover tint. */
.metadata-slot :deep(.document-metadata-actions) {
  justify-content: flex-end;
  padding: 7px 10px;
  gap: 4px;
  background: transparent;
  border-top: 1px solid var(--border);
}
.metadata-slot :deep(.document-metadata-actions .btn) {
  flex: 0 0 auto;
  min-height: 22px;
  padding: 2px 9px;
  font-size: 0.72rem;
  line-height: 1.3;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--text-muted);
}
.metadata-slot :deep(.document-metadata-actions .btn:hover:not(:disabled)) {
  background: var(--bg-soft);
  color: var(--text);
}
.metadata-slot :deep(.document-metadata-actions .btn-primary) {
  color: var(--accent);
}
.metadata-slot :deep(.document-metadata-actions .btn-primary:hover:not(:disabled)) {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-color: transparent;
}
.toc-panel-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.toc-panel-item {
  position: relative;
  margin: 0;
  overflow: hidden;
}

/* Row uses the same vertical rhythm as a .link-entry (6px/12px
   padding, 0.88rem font-size, 1.4 line-height) so the two halves
   have matching row heights. The heading text fills the available
   width and is truncated with ellipsis on overflow.

   Hierarchy is conveyed by typography, not just indent:

     - lvl-1/2 (sections): full text-1 color, 0.82rem, weight 500 —
       these are the spine of the document and should read at a
       glance when scanning.
     - lvl-3+ (sub-items): muted color, 0.76rem, weight 400, deeper
       indent + a 1px guide line at left:12px. The guide line
       continues through every sub-item of a section so the user
       reads each cluster as one group, not as a flat indented list.

   Active state is communicated by text weight + a light row
   background, modeled on Cursor / VS Code Outline rather than the
   file-tree's accent-bar style — a TOC is a reading aid, not a
   navigation tree. The .active rule below bumps color/weight on
   the active link regardless of its level, so a focused sub-item
   still pops out of its muted siblings. */
.toc-panel-link {
  display: block;
  width: calc(100% - 28px);
  margin: 0 14px;
  /* min-width: 0 lets this flex item shrink below its intrinsic
     content width when the column is narrow. */
  min-width: 0;
  padding: 5px 10px;
  font-size: 0.82rem;
  line-height: 1.35;
  color: var(--vs-text-1, var(--text));
  font-weight: 500;
  text-decoration: none;
  border-radius: 5px;
  transition: background 0.12s ease, color 0.12s ease;
}

.toc-panel-link-text {
  display: block;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toc-panel-link:hover {
  color: var(--vs-text-1, var(--text));
  background: transparent;
}

.toc-panel-item:hover {
  background: var(--vs-hover-bg, var(--bg-soft));
}

.toc-panel-item.active .toc-panel-link {
  color: var(--vs-text-1, var(--text));
  font-weight: 600;
  background: transparent;
}

.toc-panel-item.active {
  background: var(--vs-hover-bg, var(--bg-soft));
}

/* Sections (lvl-1/2): baseline indent only, no guide line. */
.toc-panel-item.lvl-1 .toc-panel-link,
.toc-panel-item.lvl-2 .toc-panel-link {
  padding-left: 10px;
}

/* Sub-items (lvl-3+): muted, smaller, deeper indent + vertical guide
   line at left:12px connecting the sub-item visually to its parent
   section. The line stops at the top/bottom of the link box, so a
   chain of sub-items reads as a continuous hanging tree. */
.toc-panel-item.lvl-3 .toc-panel-link,
.toc-panel-item.lvl-4 .toc-panel-link,
.toc-panel-item.lvl-5 .toc-panel-link,
.toc-panel-item.lvl-6 .toc-panel-link {
  padding-left: 24px;
  font-size: 0.76rem;
  font-weight: 400;
  color: var(--text-muted);
  position: relative;
}
.toc-panel-item.lvl-3 .toc-panel-link::before,
.toc-panel-item.lvl-4 .toc-panel-link::before,
.toc-panel-item.lvl-5 .toc-panel-link::before,
.toc-panel-item.lvl-6 .toc-panel-link::before {
  content: '';
  position: absolute;
  left: 12px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--border) 70%, transparent);
}

/* LinksPanel renders its own <aside class="links-panel">. We strip
   the right border (the .right-rail already provides the column
   boundary) and make the panel fill the slot — LinksPanel's own
   styles set height: 100%. */
.links-slot :deep(.links-panel) {
  border-right: 0;
  height: auto;
}
</style>
