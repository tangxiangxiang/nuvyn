import { ref } from 'vue'

/**
 * 极简 confirm:渲染一个原生 <dialog>-free 的居中模态,代替 window.confirm。
 * 用法:
 *   const { confirm } = useConfirm()
 *   if (await confirm('放弃修改?')) { ... }
 */
export interface ConfirmRequest {
  id: number
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  resolve: (ok: boolean) => void
}

export interface ConfirmOptions {
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export interface CancellableConfirm {
  promise: Promise<boolean>
  cancel: () => void
}

const queue = ref<ConfirmRequest[]>([])
let nextId = 1

export function useConfirm() {
  function confirmCancellable(
    message: string,
    detail?: string,
    options: ConfirmOptions = {},
  ): CancellableConfirm {
    let settled = false
    let resolveRequest!: (ok: boolean) => void
    const promise = new Promise<boolean>((resolve) => { resolveRequest = resolve })
    const id = nextId++
    const cancel = () => {
      if (settled) return
      settled = true
      queue.value = queue.value.filter((request) => request.id !== id)
      resolveRequest(false)
    }
    queue.value = [...queue.value, {
      id,
      message,
      detail,
      ...options,
      resolve: (ok: boolean) => {
        if (settled) return
        settled = true
        resolveRequest(ok)
      },
    }]
    return { promise, cancel }
  }

  function confirm(message: string, detail?: string, options: ConfirmOptions = {}): Promise<boolean> {
    return confirmCancellable(message, detail, options).promise
  }
  function answer(id: number, ok: boolean) {
    const req = queue.value.find((r) => r.id === id)
    if (!req) return
    queue.value = queue.value.filter((r) => r.id !== id)
    req.resolve(ok)
  }
  return { queue, confirm, confirmCancellable, answer }
}
