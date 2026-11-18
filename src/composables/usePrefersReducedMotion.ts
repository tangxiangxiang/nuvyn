import { onBeforeUnmount, onMounted, ref } from 'vue'

export function usePrefersReducedMotion() {
  const mediaQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
  const prefersReducedMotion = ref(mediaQuery?.matches ?? false)
  const update = (event: MediaQueryListEvent) => { prefersReducedMotion.value = event.matches }

  onMounted(() => mediaQuery?.addEventListener('change', update))
  onBeforeUnmount(() => mediaQuery?.removeEventListener('change', update))

  return prefersReducedMotion
}
