import { computed, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'

export function useRouteSync(options: {
  activePath: Ref<string | null>
  openPost: (path: string) => Promise<void>
  onRouteIntent?: (path: string | null, previousPath: string | null) => void
}) {
  const route = useRoute()
  const routePath = computed<string | null>(() => {
    const pathMatch = (route.params.pathMatch as string[] | undefined) ?? []
    return pathMatch.length ? pathMatch.join('/') : null
  })

  watch(routePath, (path, previousPath) => {
    options.onRouteIntent?.(path, previousPath)
    if (path && path !== options.activePath.value) {
      void options.openPost(path)
    }
  }, { flush: 'sync' })

  return { routePath }
}
