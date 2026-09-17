import { nextTick } from 'vue'
import { NSelect } from 'naive-ui'
import type { VueWrapper } from '@vue/test-utils'

type TestWrapper = {
  findAllComponents: (selector: typeof NSelect) => VueWrapper<InstanceType<typeof NSelect>>[]
}

export function getNaiveSelect(wrapper: TestWrapper, label: string) {
  const select = wrapper.findAllComponents(NSelect).find((candidate) => candidate.attributes('aria-label') === label)
  if (!select) throw new Error(`Naive select not found: ${label}`)
  return select
}

export async function setNaiveSelect(wrapper: TestWrapper, label: string, value: string | null): Promise<void> {
  await getNaiveSelect(wrapper, label).vm.$emit('update:value', value)
  await nextTick()
}

export function naiveSelectValue(wrapper: TestWrapper, label: string): string | null {
  const value = getNaiveSelect(wrapper, label).props('value')
  return typeof value === 'string' ? value : null
}
