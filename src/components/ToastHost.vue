<script setup lang="ts">
import { h, onBeforeUnmount, watch } from 'vue'
import { NButton, useMessage, type MessageReactive } from 'naive-ui'
import { useToast } from '../composables/useToast'

const { toasts, dismiss } = useToast()
const message = useMessage()
const handles = new Map<number, MessageReactive>()

function syncMessages(): void {
  const currentIds = new Set(toasts.value.map((toast) => toast.id))

  for (const toast of toasts.value) {
    if (handles.has(toast.id)) continue
    const create = message[toast.type]
    const handle = create(toast.message, {
      // Nuvyn owns TTL and queue removal. A zero Naive duration disables its
      // independent timer without changing the public useToast contract.
      duration: 0,
      closable: true,
      ...(toast.action ? {
        render: (props) => h('div', { class: 'toast-action-content' }, [
          h('span', { class: 'toast-action-message' }, props.content),
          h(NButton, {
            attrType: 'button',
            size: 'tiny',
            text: true,
            type: 'primary',
            onClick: () => {
              const action = toast.action
              dismiss(toast.id)
              if (action) void action.run()
            },
          }, () => toast.action?.label),
        ]),
      } : {}),
      onClose: () => dismiss(toast.id),
    })
    handles.set(toast.id, handle)
  }

  for (const [id, handle] of handles) {
    if (currentIds.has(id)) continue
    handle.destroy()
    handles.delete(id)
  }
}

watch(toasts, syncMessages, { immediate: true })

onBeforeUnmount(() => {
  for (const handle of handles.values()) handle.destroy()
  handles.clear()
})
</script>

<template />
