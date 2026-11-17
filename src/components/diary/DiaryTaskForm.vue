<script setup lang="ts">
import { computed, ref } from 'vue'
import { NInput, type InputInst } from 'naive-ui'
import { MAX_DIARY_TASK_DESCRIPTION_LENGTH, MAX_DIARY_TASK_TITLE_LENGTH, type TaskFields } from '../../../shared/diaryTasks'

const props = defineProps<{ modelValue: TaskFields; inert?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: TaskFields] }>()
const titleInput = ref<InputInst | null>(null)
const title = computed({
  get: () => props.modelValue.title,
  set: (title: string) => emit('update:modelValue', { ...props.modelValue, title }),
})
const date = computed({
  get: () => props.modelValue.dueDate ?? '',
  set: (dueDate: string) => emit('update:modelValue', {
    ...props.modelValue,
    dueDate: dueDate || null,
    dueTime: dueDate ? props.modelValue.dueTime : null,
  }),
})
const time = computed({
  get: () => props.modelValue.dueTime ?? '',
  set: (dueTime: string) => emit('update:modelValue', { ...props.modelValue, dueTime: dueTime || null }),
})
const description = computed({
  get: () => props.modelValue.description,
  set: (description: string) => emit('update:modelValue', { ...props.modelValue, description }),
})

defineExpose({ focusTitle: () => titleInput.value?.focus() })
</script>

<template>
  <div class="diary-task-form">
    <label class="diary-task-form-field diary-task-form-title">
      <span>待办名称</span>
      <NInput
        ref="titleInput"
        v-model:value="title"
        :disabled="inert"
        :maxlength="MAX_DIARY_TASK_TITLE_LENGTH"
        placeholder="要完成的事情"
        :input-props="{ 'aria-label': '待办名称' }"
      />
    </label>
    <div class="diary-task-form-due">
      <label class="diary-task-form-field">
        <span>截止日期</span>
        <input v-model="date" type="date" aria-label="截止日期" :disabled="inert">
      </label>
      <label class="diary-task-form-field">
        <span>截止时间</span>
        <input v-model="time" type="time" aria-label="截止时间" :disabled="inert || !date">
      </label>
      <button v-if="date" type="button" class="diary-task-clear-date" :disabled="inert" @click="date = ''">清除日期</button>
    </div>
    <label class="diary-task-form-field diary-task-form-description">
      <span>备注 <small>可选</small></span>
      <NInput
        v-model:value="description"
        type="textarea"
        :disabled="inert"
        :maxlength="MAX_DIARY_TASK_DESCRIPTION_LENGTH"
        :autosize="{ minRows: 2, maxRows: 5 }"
        placeholder=""
        :input-props="{ 'aria-label': '待办备注' }"
      />
    </label>
  </div>
</template>

<style>
.diary-task-form { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.diary-task-form-field { display: flex; min-width: 0; flex-direction: column; gap: 7px; color: var(--text); font-size: 14px; }
.diary-task-form-field > span { color: var(--text-muted, #6b7280); }
.diary-task-form-field > span small { font-size: 12px; font-weight: 400; }
.diary-task-form-title input { font-size: 17px; }
.diary-task-form-due { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px; align-items: end; min-width: 0; }
.diary-task-form-due input {
  width: 100%;
  min-width: 0;
  height: 38px;
  box-sizing: border-box;
  padding: 0 9px;
  border: 1px solid var(--border, #d9dce5);
  border-radius: 7px;
  background: var(--input-color, var(--bg));
  color: inherit;
  font: inherit;
}
.diary-task-form-due input:disabled { opacity: .55; }
.diary-task-clear-date { height: 38px; padding: 0 4px; border: 0; background: transparent; color: var(--text-muted, #6b7280); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.diary-task-clear-date:disabled { cursor: default; opacity: .55; }
.diary-task-form-description textarea { resize: vertical; }
@media (max-width: 420px) {
  .diary-task-form-due { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .diary-task-clear-date { grid-column: 2; justify-self: end; height: 28px; }
}
</style>
