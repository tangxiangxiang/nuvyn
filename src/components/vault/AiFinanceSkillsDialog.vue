<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NIcon, NModal } from 'naive-ui'
import { Check, ChevronLeft, Edit, Plus, Trash, X } from '@vicons/tabler'
import {
  createFinanceSkill,
  deleteFinanceSkill,
  getFinanceSkill,
  getFinanceSkills,
  updateFinanceSkill,
  type FinanceSkill,
  type FinanceSkillMetadata,
} from '../../lib/ai-api'
import { FINANCE_CUSTOM_SKILL_LIMITS } from '../../../shared/financeSkills'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const skills = ref<FinanceSkillMetadata[]>([])
const selected = ref<FinanceSkill | null>(null)
const loading = ref(false)
const pending = ref(false)
const error = ref('')
const view = ref<'list' | 'detail' | 'add' | 'edit'>('list')
const draft = ref({ title: '', description: '', content: '' })
const confirmDelete = ref(false)
const latestVersion = ref<FinanceSkill | null>(null)
const isConflict = ref(false)
const isInstanceConflict = ref(false)
const editBaseline = ref<{ name: string; id: number; revision: number } | null>(null)

const builtinSkills = computed(() => skills.value.filter(skill => skill.source === 'builtin'))
const customSkills = computed(() => skills.value.filter(skill => skill.source === 'custom'))
const selectedName = computed(() => selected.value ? displayName(selected.value) : '')
const editing = computed(() => view.value === 'add' || view.value === 'edit')
const draftContentCount = computed(() => Array.from(draft.value.content).length)
const canSaveDraft = computed(() => Boolean(draft.value.title.trim() && draft.value.description.trim() && draft.value.content.trim())
  && Array.from(draft.value.title).length <= FINANCE_CUSTOM_SKILL_LIMITS.titleCharacters
  && Array.from(draft.value.description).length <= FINANCE_CUSTOM_SKILL_LIMITS.descriptionCharacters
  && draftContentCount.value <= FINANCE_CUSTOM_SKILL_LIMITS.contentCharacters)

const skillKeys: Record<string, string> = {
  'monthly-review': 'monthly_review',
  'spending-analysis': 'spending_analysis',
  'debt-analysis': 'debt_analysis',
  'cashflow-analysis': 'cashflow_analysis',
  'financial-planning': 'financial_planning',
}

function displayName(skill: Pick<FinanceSkillMetadata, 'name' | 'title' | 'source'>): string {
  if (skill.source === 'custom') return skill.title
  const key = skillKeys[skill.name]
  return key ? t(`ai.finance_skill.${key}.name`) : skill.title
}

function displayDescription(skill: Pick<FinanceSkillMetadata, 'name' | 'description' | 'source'>): string {
  if (skill.source === 'custom') return skill.description
  const key = skillKeys[skill.name]
  return key ? t(`ai.finance_skill.${key}.description`) : skill.description
}

function clearConflict(): void {
  latestVersion.value = null
  isConflict.value = false
  isInstanceConflict.value = false
}

function errorCode(cause: unknown): string {
  if (!cause || typeof cause !== 'object') return ''
  if ('body' in cause && cause.body && typeof cause.body === 'object' && 'code' in cause.body && typeof cause.body.code === 'string') {
    return cause.body.code
  }
  if ('message' in cause && typeof cause.message === 'string') {
    if (cause.message.includes('stale-instance')) return 'stale-instance'
    if (cause.message.includes('stale-revision')) return 'stale-revision'
  }
  return ''
}

async function loadList(): Promise<void> {
  loading.value = true
  error.value = ''
  selected.value = null
  view.value = 'list'
  clearConflict()
  try {
    skills.value = await getFinanceSkills()
  } catch {
    error.value = t('ai.finance_skills_load_failed')
  } finally {
    loading.value = false
  }
}

watch(() => props.open, open => {
  if (open) void loadList()
  else {
    selected.value = null
    view.value = 'list'
    error.value = ''
    confirmDelete.value = false
    clearConflict()
  }
}, { immediate: true })

async function openSkill(name: string): Promise<void> {
  loading.value = true
  error.value = ''
  clearConflict()
  try {
    selected.value = await getFinanceSkill(name)
    view.value = 'detail'
  } catch {
    error.value = t('ai.finance_skill_load_failed')
  } finally {
    loading.value = false
  }
}

function backToList(): void {
  selected.value = null
  view.value = 'list'
  draft.value = { title: '', description: '', content: '' }
  error.value = ''
  confirmDelete.value = false
  editBaseline.value = null
  clearConflict()
}

function beginAdd(): void {
  selected.value = null
  draft.value = { title: '', description: '', content: '' }
  view.value = 'add'
  editBaseline.value = null
  error.value = ''
  clearConflict()
}

function beginEdit(): void {
  if (!selected.value || selected.value.source !== 'custom' || pending.value) return
  draft.value = {
    title: selected.value.title,
    description: selected.value.description,
    content: selected.value.content,
  }
  editBaseline.value = {
    name: selected.value.name,
    id: selected.value.id,
    revision: selected.value.revision,
  }
  view.value = 'edit'
  error.value = ''
  confirmDelete.value = false
  clearConflict()
}

function cancelDraft(): void {
  if (pending.value) return
  if (view.value === 'add') {
    backToList()
    return
  }
  if (view.value !== 'edit') return
  draft.value = selected.value
    ? { title: selected.value.title, description: selected.value.description, content: selected.value.content }
    : { title: '', description: '', content: '' }
  view.value = selected.value ? 'detail' : 'list'
  confirmDelete.value = false
  error.value = isInstanceConflict.value ? t('ai.finance_skill_instance_conflict') : ''
  if (!isInstanceConflict.value) clearConflict()
}

async function saveDraft(): Promise<void> {
  if (pending.value || !canSaveDraft.value) return
  pending.value = true
  error.value = ''
  try {
    if (view.value === 'add') {
      const result = await createFinanceSkill(draft.value.title, draft.value.description, draft.value.content)
      selected.value = result.skill
      skills.value = [
        ...skills.value.filter(skill => skill.name !== result.skill.name),
        { id: result.skill.id, name: result.skill.name, title: result.skill.title, description: result.skill.description, source: 'custom', revision: result.skill.revision },
      ]
      view.value = 'detail'
      clearConflict()
    } else if (view.value === 'edit' && selected.value?.source === 'custom') {
      const baseline = editBaseline.value
      if (!baseline) return
      const retryVersion = isConflict.value && !isInstanceConflict.value && latestVersion.value?.source === 'custom'
        ? latestVersion.value
        : null
      const result = await updateFinanceSkill(selected.value.name, {
        ...draft.value,
        expectedId: retryVersion?.id ?? baseline.id,
        expectedRevision: retryVersion?.revision ?? baseline.revision,
      })
      selected.value = result.skill
      editBaseline.value = { name: result.skill.name, id: result.skill.id, revision: result.skill.revision }
      skills.value = skills.value.map(skill => skill.name === result.skill.name
        ? { id: result.skill.id, name: result.skill.name, title: result.skill.title, description: result.skill.description, source: 'custom', revision: result.skill.revision }
        : skill)
      view.value = 'detail'
      clearConflict()
    }
  } catch (cause) {
    const code = errorCode(cause)
    if ((code === 'stale-revision' || code === 'stale-instance') && editBaseline.value) {
      try {
        const latest = await getFinanceSkill(editBaseline.value.name)
        if (code === 'stale-instance' || latest.id !== editBaseline.value.id) {
          latestVersion.value = latest
          isInstanceConflict.value = true
          isConflict.value = true
          error.value = t('ai.finance_skill_instance_conflict')
        } else {
          latestVersion.value = latest
          selected.value = latest
          isConflict.value = true
          error.value = t('ai.finance_skill_conflict')
        }
      } catch {
        isInstanceConflict.value = code === 'stale-instance'
        isConflict.value = isInstanceConflict.value
        error.value = isInstanceConflict.value ? t('ai.finance_skill_instance_missing') : t('ai.finance_skill_conflict_reload_failed')
      }
    } else error.value = t(view.value === 'add' ? 'ai.finance_skill_add_failed' : 'ai.finance_skill_save_failed')
  } finally {
    pending.value = false
  }
}

async function removeSkill(): Promise<void> {
  if (pending.value || !confirmDelete.value || !selected.value || selected.value.source !== 'custom') return
  const skill = selected.value
  pending.value = true
  error.value = ''
  try {
    await deleteFinanceSkill(skill.name, skill.id, skill.revision)
    skills.value = skills.value.filter(item => item.name !== skill.name)
    backToList()
  } catch (cause) {
    const code = errorCode(cause)
    if (code === 'stale-revision' || code === 'stale-instance') {
      try {
        const latest = await getFinanceSkill(skill.name)
        latestVersion.value = latest
        isConflict.value = true
        confirmDelete.value = false
        if (code === 'stale-instance' || latest.id !== skill.id) {
          isInstanceConflict.value = true
          error.value = t('ai.finance_skill_instance_conflict')
        } else {
          selected.value = latest
          error.value = t('ai.finance_skill_conflict_delete')
        }
      } catch {
        isInstanceConflict.value = code === 'stale-instance'
        isConflict.value = isInstanceConflict.value
        error.value = isInstanceConflict.value ? t('ai.finance_skill_instance_missing') : t('ai.finance_skill_conflict_reload_failed')
      }
    } else error.value = t('ai.finance_skill_delete_failed')
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <NModal :show="open" :mask-closable="true" :close-on-esc="true" @update:show="value => !value && emit('close')">
    <section class="ai-finance-skills-dialog" role="dialog" aria-modal="true" :aria-label="t('ai.finance_skills_title')" :aria-busy="loading || pending">
      <header class="ai-finance-skills-header">
        <button v-if="view !== 'list'" type="button" :aria-label="t('ai.finance_skills_back')" :disabled="pending" @click="backToList">
          <NIcon :size="18" aria-hidden="true"><ChevronLeft /></NIcon>
        </button>
        <h2>{{ view === 'list' ? t('ai.finance_skills_title') : view === 'add' ? t('ai.finance_skill_add') : selectedName }}</h2>
        <button v-if="view === 'list'" type="button" :aria-label="t('ai.finance_skill_add')" :title="t('ai.finance_skill_add')" :disabled="loading" @click="beginAdd">
          <NIcon :size="18" aria-hidden="true"><Plus /></NIcon>
        </button>
        <button type="button" :aria-label="t('ai.close')" @click="emit('close')">
          <NIcon :size="18" aria-hidden="true"><X /></NIcon>
        </button>
      </header>

      <div class="ai-finance-skills-body">
        <p v-if="error" class="ai-finance-skills-error" role="alert">{{ error }}</p>
        <p v-if="loading" class="ai-finance-skills-muted" role="status">{{ t('ai.loading') }}</p>

        <form v-else-if="editing" class="ai-finance-skill-form" @submit.prevent="saveDraft">
          <label>
            <span>{{ t('ai.finance_skill_title_label') }}</span>
            <input v-model="draft.title" :maxlength="FINANCE_CUSTOM_SKILL_LIMITS.titleCharacters" :disabled="pending" required />
            <small>{{ Array.from(draft.title).length }}/{{ FINANCE_CUSTOM_SKILL_LIMITS.titleCharacters }}</small>
          </label>
          <label>
            <span>{{ t('ai.finance_skill_description_label') }}</span>
            <input v-model="draft.description" :maxlength="FINANCE_CUSTOM_SKILL_LIMITS.descriptionCharacters" :disabled="pending" required />
            <small>{{ Array.from(draft.description).length }}/{{ FINANCE_CUSTOM_SKILL_LIMITS.descriptionCharacters }}</small>
          </label>
          <label>
            <span>{{ t('ai.finance_skill_content_label') }}</span>
            <textarea v-model="draft.content" rows="12" :disabled="pending" required />
            <small>{{ draftContentCount }}/{{ FINANCE_CUSTOM_SKILL_LIMITS.contentCharacters }}</small>
          </label>
          <div v-if="isConflict && latestVersion" class="ai-finance-skill-latest" role="status">
            <strong>{{ t('ai.finance_skill_latest') }}</strong>
            <span>{{ latestVersion.title }}</span>
            <span>{{ latestVersion.description }}</span>
            <pre>{{ latestVersion.content }}</pre>
          </div>
          <div class="ai-finance-skill-actions">
            <button type="button" :disabled="pending" @click="cancelDraft">{{ t('ai.finance_memory_cancel') }}</button>
            <button class="is-primary" type="submit" :disabled="pending || !canSaveDraft || isInstanceConflict">
              <NIcon :size="16" aria-hidden="true"><Check /></NIcon>{{ t('ai.finance_memory_save') }}
            </button>
          </div>
        </form>

        <template v-else-if="view === 'detail' && selected">
          <p class="ai-finance-skill-description">{{ selected.description }}</p>
          <pre class="ai-finance-skill-content">{{ selected.content }}</pre>
          <div v-if="isConflict && latestVersion" class="ai-finance-skill-latest" role="status">
            <strong>{{ t('ai.finance_skill_latest') }}</strong>
            <span>{{ latestVersion.description }}</span>
            <pre>{{ latestVersion.content }}</pre>
          </div>
          <div v-if="selected.source === 'custom' && !isInstanceConflict" class="ai-finance-skill-actions">
            <div v-if="confirmDelete" class="ai-finance-skill-delete-confirm" role="group">
              <span>{{ t('ai.finance_skill_delete_confirm', { title: selected.title }) }}</span>
              <button type="button" :disabled="pending" @click="confirmDelete = false">{{ t('ai.finance_memory_cancel') }}</button>
              <button type="button" class="is-danger" :disabled="pending" @click="removeSkill">{{ t('ai.finance_skill_delete') }}</button>
            </div>
            <template v-else>
              <button type="button" :disabled="pending" @click="confirmDelete = true">
                <NIcon :size="16" aria-hidden="true"><Trash /></NIcon>{{ t('ai.finance_skill_delete') }}
              </button>
              <button class="is-primary" type="button" :disabled="pending" @click="beginEdit">
                <NIcon :size="16" aria-hidden="true"><Edit /></NIcon>{{ t('ai.finance_skill_edit') }}
              </button>
            </template>
          </div>
        </template>

        <template v-else-if="view === 'list' && !loading">
          <p v-if="!skills.length && !error" class="ai-finance-skills-muted" role="status">{{ t('ai.finance_skills_empty') }}</p>
          <section v-if="builtinSkills.length" class="ai-finance-skills-group" :aria-label="t('ai.finance_skills_builtin')">
            <h3>{{ t('ai.finance_skills_builtin') }}</h3>
            <ul class="ai-finance-skills-list">
              <li v-for="skill in builtinSkills" :key="skill.name">
                <button type="button" @click="openSkill(skill.name)">
                  <span>{{ displayName(skill) }}</span>
                  <small>{{ displayDescription(skill) }}</small>
                </button>
              </li>
            </ul>
          </section>
          <section class="ai-finance-skills-group" :aria-label="t('ai.finance_skills_custom')">
            <h3>{{ t('ai.finance_skills_custom') }}</h3>
            <ul v-if="customSkills.length" class="ai-finance-skills-list">
              <li v-for="skill in customSkills" :key="skill.name">
                <button type="button" @click="openSkill(skill.name)">
                  <span>{{ displayName(skill) }}</span>
                  <small>{{ displayDescription(skill) }}</small>
                </button>
              </li>
            </ul>
            <p v-else class="ai-finance-skills-muted">{{ t('ai.finance_skills_custom_empty') }}</p>
          </section>
        </template>
      </div>
    </section>
  </NModal>
</template>

<style scoped>
.ai-finance-skills-dialog {
  width: min(520px, calc(100vw - 28px));
  max-height: min(78vh, 720px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--nuvyn-border);
  border-radius: 18px;
  background: var(--nuvyn-surface-1);
  color: var(--nuvyn-text-1);
  box-shadow: 0 24px 72px rgb(0 0 0 / 22%);
}
.ai-finance-skills-header { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding: 15px 18px 12px; border-bottom: 1px solid var(--nuvyn-border); }
.ai-finance-skills-header h2 { flex: 1; min-width: 0; margin: 0; font-size: 1.05rem; font-weight: 650; }
.ai-finance-skills-header button { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--nuvyn-text-2); cursor: pointer; }
.ai-finance-skills-header button:hover, .ai-finance-skill-actions button:hover { background: color-mix(in srgb, var(--nuvyn-accent) 10%, var(--nuvyn-surface-1)); color: var(--nuvyn-text-1); }
.ai-finance-skills-header button:focus-visible, .ai-finance-skill-actions button:focus-visible, .ai-finance-skills-list button:focus-visible { outline: 2px solid var(--nuvyn-accent); outline-offset: 2px; }
.ai-finance-skills-body { min-height: 0; flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; padding: 8px 14px 14px; scrollbar-width: none; }
.ai-finance-skills-body::-webkit-scrollbar { display: none; }
.ai-finance-skills-group + .ai-finance-skills-group { margin-top: 12px; }
.ai-finance-skills-group h3 { margin: 9px 10px 4px; color: var(--nuvyn-text-2); font-size: .78rem; font-weight: 650; }
.ai-finance-skills-list { list-style: none; margin: 0; padding: 0; }
.ai-finance-skills-list button { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 10px 10px; border: 0; border-radius: 9px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.ai-finance-skills-list button:hover { background: color-mix(in srgb, var(--nuvyn-accent) 8%, var(--nuvyn-surface-1)); }
.ai-finance-skills-list span { font-size: .91rem; font-weight: 580; }
.ai-finance-skills-list small, .ai-finance-skill-form small { color: var(--nuvyn-text-2); font-size: .78rem; line-height: 1.4; }
.ai-finance-skill-description { margin: 6px 2px 12px; color: var(--nuvyn-text-2); line-height: 1.5; }
.ai-finance-skill-content, .ai-finance-skill-latest pre { margin: 0; color: var(--nuvyn-text-1); white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: .86rem; line-height: 1.62; }
.ai-finance-skill-form { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px; }
.ai-finance-skill-form label { display: flex; flex-direction: column; gap: 5px; font-size: .88rem; font-weight: 580; }
.ai-finance-skill-form input, .ai-finance-skill-form textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--nuvyn-border); border-radius: 9px; padding: 9px 10px; background: var(--nuvyn-surface-1); color: var(--nuvyn-text-1); font: inherit; font-weight: 400; }
.ai-finance-skill-form textarea { min-height: 190px; resize: vertical; line-height: 1.55; }
.ai-finance-skill-form input:focus, .ai-finance-skill-form textarea:focus { outline: 2px solid color-mix(in srgb, var(--nuvyn-accent) 35%, transparent); border-color: var(--nuvyn-accent); }
.ai-finance-skill-latest { display: grid; gap: 6px; margin: 0; padding: 10px; border-radius: 9px; background: color-mix(in srgb, var(--nuvyn-accent) 6%, var(--nuvyn-surface-1)); color: var(--nuvyn-text-2); font-size: .82rem; }
.ai-finance-skill-latest pre { max-height: 180px; overflow: auto; }
.ai-finance-skill-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.ai-finance-skill-actions button { min-height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--nuvyn-text-2); cursor: pointer; }
.ai-finance-skill-actions button.is-primary { background: var(--nuvyn-accent); color: white; }
.ai-finance-skill-actions button.is-danger { color: var(--nuvyn-negative); }
.ai-finance-skill-delete-confirm { width: 100%; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; color: var(--nuvyn-text-2); font-size: .82rem; }
.ai-finance-skill-delete-confirm span { flex: 1 1 100%; }
.ai-finance-skills-muted, .ai-finance-skills-error { margin: 8px 2px; color: var(--nuvyn-text-2); }
.ai-finance-skills-error { color: var(--nuvyn-negative); }
@media (max-width: 640px) {
  .ai-finance-skills-dialog { width: calc(100vw - 24px); max-height: min(82vh, 720px); border-radius: 16px; }
  .ai-finance-skills-header { padding-left: 14px; padding-right: 14px; }
  .ai-finance-skill-form textarea { min-height: 150px; }
}
</style>
