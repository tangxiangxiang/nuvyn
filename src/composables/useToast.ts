import { ref, readonly } from 'vue'

export interface Toast {
  id: number
  type: 'info' | 'success' | 'error'
  message: string
  ttl: number
}

const toasts = ref<Toast[]>([])
let nextId = 1

/**
 * 极简 toast:不引 UI 库。组件 <ToastHost /> 在 App.vue 渲染一次,这里
 * push 后 ttl 到期自动 remove。
 */
export function useToast() {
  function push(message: string, type: Toast['type'] = 'info', ttl = 2400): number {
    const id = nextId++
    toasts.value = [...toasts.value, { id, type, message, ttl }]
    if (ttl > 0) {
      window.setTimeout(() => dismiss(id), ttl)
    }
    return id
  }
  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }
  return {
    toasts: readonly(toasts),
    info: (m: string, ttl?: number) => push(m, 'info', ttl),
    success: (m: string, ttl?: number) => push(m, 'success', ttl),
    error: (m: string, ttl?: number) => push(m, 'error', ttl ?? 4000),
    dismiss,
  }
}
