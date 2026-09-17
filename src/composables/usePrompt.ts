import { ref } from 'vue'

/**
 * 极简 prompt:渲染一个居中模态,捕获单行文本输入,代替 window.prompt。
 * 用法:
 *   const { prompt } = usePrompt()
 *   const value = await prompt({ title: 'New post', placeholder: 'filename' })
 *   if (value) { ... }
 */
export interface PromptRequest {
  id: number
  title: string
  placeholder?: string
  initial?: string
  actionLabel?: string
  actionTitle?: string
  transform?: (value: string) => Promise<string> | string
  resolve: (value: string | null) => void
}

const queue = ref<PromptRequest[]>([])
let nextId = 1

export function usePrompt() {
  function prompt(input: {
    title: string
    placeholder?: string
    initial?: string
    actionLabel?: string
    actionTitle?: string
    transform?: (value: string) => Promise<string> | string
  }): Promise<string | null> {
    return new Promise((resolve) => {
      const id = nextId++
      queue.value = [...queue.value, { id, ...input, resolve }]
    })
  }
  function answer(id: number, value: string | null) {
    const req = queue.value.find((r) => r.id === id)
    if (!req) return
    queue.value = queue.value.filter((r) => r.id !== id)
    req.resolve(value)
  }
  return { queue, prompt, answer }
}
