<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NIcon, NModal } from 'naive-ui'
import { ChevronLeft, X } from '@vicons/tabler'
import { getFinanceSkill, getFinanceSkills, type FinanceSkill, type FinanceSkillMetadata, type FinanceSkillName } from '../../lib/ai-api'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const skills = ref<FinanceSkillMetadata[]>([])
const selected = ref<FinanceSkill | null>(null)
const loading = ref(false)
const error = ref('')
const selectedName = computed(() => selected.value ? displayName(selected.value.name) : '')

const skillKeys: Record<FinanceSkillName, string> = {
  'monthly-review': 'monthly_review',
  'spending-analysis': 'spending_analysis',
  'debt-analysis': 'debt_analysis',
  'cashflow-analysis': 'cashflow_analysis',
  'financial-planning': 'financial_planning',
}

function displayName(name: FinanceSkillName): string {
  return t(`ai.finance_skill.${skillKeys[name]}.name`)
}

function displayDescription(name: FinanceSkillName): string {
  return t(`ai.finance_skill.${skillKeys[name]}.description`)
}

async function loadList(): Promise<void> {
  loading.value = true
  error.value = ''
  selected.value = null
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
    error.value = ''
  }
}, { immediate: true })

async function openSkill(name: FinanceSkillName): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    selected.value = await getFinanceSkill(name)
  } catch {
    error.value = t('ai.finance_skill_load_failed')
  } finally {
    loading.value = false
  }
}

function backToList(): void {
  selected.value = null
  error.value = ''
}
</script>

<template>
  <NModal :show="open" :mask-closable="true" :close-on-esc="true" @update:show="value => !value && emit('close')">
    <section class="ai-finance-skills-dialog" role="dialog" aria-modal="true" :aria-label="t('ai.finance_skills_title')" :aria-busy="loading">
      <header class="ai-finance-skills-header">
        <button v-if="selected" type="button" :aria-label="t('ai.finance_skills_back')" @click="backToList">
          <NIcon :size="18" aria-hidden="true"><ChevronLeft /></NIcon>
        </button>
        <h2>{{ selected ? selectedName : t('ai.finance_skills_title') }}</h2>
        <button type="button" :aria-label="t('ai.close')" @click="emit('close')">
          <NIcon :size="18" aria-hidden="true"><X /></NIcon>
        </button>
      </header>

      <div class="ai-finance-skills-body">
        <p v-if="error" class="ai-finance-skills-error" role="alert">{{ error }}</p>
        <p v-if="loading" class="ai-finance-skills-muted" role="status">{{ t('ai.loading') }}</p>
        <pre v-else-if="selected" class="ai-finance-skill-content">{{ selected.content }}</pre>
        <ul v-else-if="skills.length" class="ai-finance-skills-list">
          <li v-for="skill in skills" :key="skill.name">
            <button type="button" @click="openSkill(skill.name)">
              <span>{{ displayName(skill.name) }}</span>
              <small>{{ displayDescription(skill.name) }}</small>
            </button>
          </li>
        </ul>
        <p v-else-if="!error" class="ai-finance-skills-muted" role="status">{{ t('ai.finance_skills_empty') }}</p>
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
.ai-finance-skills-header button:hover { background: color-mix(in srgb, var(--nuvyn-accent) 10%, var(--nuvyn-surface-1)); color: var(--nuvyn-text-1); }
.ai-finance-skills-body { min-height: 0; flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; padding: 8px 14px 14px; scrollbar-width: none; }
.ai-finance-skills-body::-webkit-scrollbar { display: none; }
.ai-finance-skills-list { list-style: none; margin: 0; padding: 0; }
.ai-finance-skills-list button { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 10px 10px; border: 0; border-radius: 9px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.ai-finance-skills-list button:hover, .ai-finance-skills-list button:focus-visible { background: color-mix(in srgb, var(--nuvyn-accent) 8%, var(--nuvyn-surface-1)); outline: none; }
.ai-finance-skills-list span { font-size: .91rem; font-weight: 580; }
.ai-finance-skills-list small { color: var(--nuvyn-text-2); font-size: .78rem; line-height: 1.4; }
.ai-finance-skill-content { margin: 0; color: var(--nuvyn-text-1); white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: .86rem; line-height: 1.62; }
.ai-finance-skills-muted, .ai-finance-skills-error { margin: 8px 2px; color: var(--nuvyn-text-2); }
.ai-finance-skills-error { color: var(--nuvyn-negative); }
@media (max-width: 640px) {
  .ai-finance-skills-dialog { width: calc(100vw - 24px); max-height: min(82vh, 720px); border-radius: 16px; }
  .ai-finance-skills-header { padding-left: 14px; padding-right: 14px; }
}
</style>
