<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NInput, NModal, type InputInst } from 'naive-ui'
import { usePrompt, type PromptRequest } from '../composables/usePrompt'
import { useI18n } from '../composables/useI18n'

const { queue, answer } = usePrompt()
const active = computed(() => queue.value[0] ?? null)
const displayed = ref<PromptRequest | null>(null)
const show = ref(false)
const input = ref('')
const busy = ref(false)
const inputRef = ref<InputInst | null>(null)
const { t } = useI18n()
let closing = false
let focusReturnTarget: HTMLElement | null = null

function closeDisplayed(id: number): void {
  if (displayed.value?.id !== id || !show.value) return
  closing = true
  show.value = false
}

function startNext(): void {
  if (show.value || closing || displayed.value || !active.value) return
  if (!focusReturnTarget && typeof document !== 'undefined') {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== document.body) {
      focusReturnTarget = activeElement
    }
  }
  displayed.value = active.value
  input.value = displayed.value.initial ?? ''
  busy.value = false
  show.value = true
}

function syncQueue(): void {
  const next = active.value
  if (displayed.value && (!next || next.id !== displayed.value.id)) {
    closeDisplayed(displayed.value.id)
    return
  }
  if (!displayed.value) startNext()
}

function settle(id: number, value: string | null): boolean {
  if (!queue.value.some((request) => request.id === id)) return false
  answer(id, value)
  closeDisplayed(id)
  return true
}

function submit(): void {
  if (!displayed.value || busy.value) return
  settle(displayed.value.id, input.value.trim() || null)
}

function cancel(): void {
  if (!displayed.value) return
  settle(displayed.value.id, null)
}

async function focusInput(select = true): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  await nextTick()
  inputRef.value?.focus()
  if (select) inputRef.value?.select()
}

function requestIsStillVisible(id: number): boolean {
  return displayed.value?.id === id && queue.value.some((request) => request.id === id)
}

async function runAction(): Promise<void> {
  const req = displayed.value
  if (!req?.transform || busy.value || !requestIsStillVisible(req.id)) return
  busy.value = true
  try {
    const next = await req.transform(input.value)
    if (!requestIsStillVisible(req.id)) return
    input.value = next
    await focusInput()
  } catch {
    // Transform rejection is recoverable: keep the prompt open, consume the
    // rejection, and let the caller edit or retry.
  } finally {
    if (requestIsStillVisible(req.id)) busy.value = false
  }
}

function finishClose(id: number): void {
  if (displayed.value?.id !== id) return
  const returnTarget = focusReturnTarget
  displayed.value = null
  show.value = false
  busy.value = false
  closing = false
  void nextTick(async () => {
    syncQueue()
    if (displayed.value || queue.value.length > 0 || !returnTarget) return
    // Naive's focus trap restores the element it captured when the trap was
    // mounted. Keep Nuvyn' trigger-focus contract authoritative after the
    // modal has fully left, including the close→next-request race.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    await nextTick()
    if (displayed.value || queue.value.length > 0) return
    focusReturnTarget = null
    returnTarget.focus({ preventScroll: true })
  })
}

function onVisibilityChange(value: boolean): void {
  if (value || !displayed.value) return
  settle(displayed.value.id, null)
}

function onEsc(): void {
  cancel()
}

function onMaskClick(): void {
  cancel()
}

function onAfterLeave(): void {
  if (displayed.value) finishClose(displayed.value.id)
}

watch(active, (request) => {
  if (request && !displayed.value && !closing) startNext()
}, { immediate: true })

watch(displayed, (request) => {
  if (!request) return
  input.value = request.initial ?? ''
  busy.value = false
}, { immediate: true })

watch(show, (visible) => {
  if (visible) void focusInput()
})

onBeforeUnmount(() => {
  // Resolve all requests safely during HMR/root teardown. Naive's modal is
  // owned by this Host and disappears with it; no orphan overlay remains.
  for (const request of [...queue.value]) answer(request.id, null)
  displayed.value = null
  show.value = false
  busy.value = false
  focusReturnTarget = null
})
</script>

<template>
  <NModal
    v-if="displayed"
    :show="show"
    :z-index="10001"
    preset="dialog"
    role="dialog"
    :aria-label="displayed.title"
    :title="displayed.title"
    :show-icon="false"
    :closable="false"
    :mask-closable="true"
    :close-on-esc="false"
    :auto-focus="false"
    :on-esc="onEsc"
    :on-mask-click="onMaskClick"
    :on-update-show="onVisibilityChange"
    :on-after-enter="() => focusInput()"
    :on-after-leave="onAfterLeave"
  >
    <template #default>
      <NInput
        ref="inputRef"
        v-model:value="input"
        :placeholder="displayed.placeholder"
        autofocus
        :input-props="{ 'aria-label': displayed.title }"
        @keydown.enter.prevent="submit"
      >
        <template v-if="displayed.transform" #suffix>
          <NButton
            size="small"
            quaternary
            :loading="busy"
            :disabled="busy"
            :title="displayed.actionTitle ?? '生成英文路径名'"
            :aria-label="displayed.actionTitle ?? '生成英文路径名'"
            @click="runAction"
          >
            {{ displayed.actionLabel ?? '✧' }}
          </NButton>
        </template>
      </NInput>
    </template>

    <template #action>
      <NButton size="medium" @click="cancel">{{ t('common.cancel') }}</NButton>
      <NButton type="primary" size="medium" :disabled="busy" @click="submit">{{ t('common.confirm') }}</NButton>
    </template>
  </NModal>
</template>

<style scoped>
.n-input { width: 100%; }
</style>
