<script setup lang="ts">
import { h, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NModal } from 'naive-ui'
import { useConfirm, type ConfirmRequest } from '../composables/useConfirm'
import { useI18n } from '../composables/useI18n'

const { queue, answer } = useConfirm()
const { t } = useI18n()
const displayed = ref<ConfirmRequest | null>(null)
const show = ref(false)
const detailContent = ref<(() => ReturnType<typeof h>) | undefined>(undefined)
let closing = false

function closeDisplayed(id: number): void {
  if (displayed.value?.id !== id || !show.value) return
  closing = true
  show.value = false
}

function startNext(): void {
  if (show.value || closing || displayed.value || !queue.value[0]) return
  displayed.value = queue.value[0]
  detailContent.value = displayed.value.detail
    ? () => h('div', { style: { whiteSpace: 'pre-line' } }, displayed.value?.detail)
    : undefined
  show.value = true
}

function syncQueue(): void {
  const next = queue.value[0] ?? null
  if (displayed.value && (!next || next.id !== displayed.value.id)) {
    closeDisplayed(displayed.value.id)
    return
  }
  if (!displayed.value) startNext()
}

function settle(id: number, value: boolean): boolean {
  if (!queue.value.some((request) => request.id === id)) return false
  // Hide the current modal before advancing the queue. This keeps the
  // visible transition deterministic when the confirm is opened above
  // another modal (for example, the ledger transaction sheet).
  closeDisplayed(id)
  answer(id, value)
  return true
}

async function focusSafeCancel(requestId: number): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  await nextTick()
  const request = displayed.value
  if (!request || request.id !== requestId) return
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]'))
  const dialog = candidates.find((candidate) => candidate.textContent?.includes(request.message))
  if (!dialog) return
  const cancelLabel = request.cancelLabel ?? t('common.cancel')
  const cancel = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === cancelLabel)
  cancel?.focus()
}

function finishClose(id: number): void {
  if (displayed.value?.id !== id) return
  displayed.value = null
  detailContent.value = undefined
  show.value = false
  closing = false
  void nextTick(syncQueue)
}

function handleEsc(): void {
  if (displayed.value) settle(displayed.value.id, false)
}

function handleMaskClick(): void {
  if (displayed.value) settle(displayed.value.id, false)
}

function handleVisibilityChange(value: boolean): void {
  if (value || !displayed.value) return
  // Defensive boundary for any supported Naive close path that changes
  // visibility without first invoking a semantic action.
  settle(displayed.value.id, false)
}

function handlePositiveClick(): true {
  if (displayed.value) answer(displayed.value.id, true)
  return true
}

function handleNegativeClick(): true {
  if (displayed.value) answer(displayed.value.id, false)
  return true
}

function handleAfterEnter(): void {
  if (displayed.value) void focusSafeCancel(displayed.value.id)
}

function handleAfterLeave(): void {
  if (displayed.value) finishClose(displayed.value.id)
}

watch(queue, syncQueue, { immediate: true })

watch(show, (visible) => {
  if (visible && displayed.value) void focusSafeCancel(displayed.value.id)
})

onBeforeUnmount(() => {
  // A Host teardown must not leave callers waiting forever. The provider
  // owns the visual transition; the semantic queue owns settlement.
  for (const request of [...queue.value]) answer(request.id, false)
  displayed.value = null
  show.value = false
})
</script>

<template>
  <NModal
    v-if="displayed"
    :show="show"
    :z-index="10001"
    preset="dialog"
    role="alertdialog"
    :aria-label="displayed.message"
    :title="displayed.message"
    :content="detailContent"
    :negative-text="displayed.cancelLabel ?? t('common.cancel')"
    :positive-text="displayed.confirmLabel ?? t('common.confirm')"
    :type="displayed.destructive ? 'error' : 'default'"
    :show-icon="displayed.destructive"
    :negative-button-props="{ size: 'medium' }"
    :positive-button-props="{ size: 'medium' }"
    :closable="false"
    :mask-closable="true"
    :close-on-esc="false"
    :auto-focus="false"
    :on-esc="handleEsc"
    :on-mask-click="handleMaskClick"
    :on-update-show="handleVisibilityChange"
    :on-positive-click="handlePositiveClick"
    :on-negative-click="handleNegativeClick"
    :on-after-enter="handleAfterEnter"
    :on-after-leave="handleAfterLeave"
  />
</template>
