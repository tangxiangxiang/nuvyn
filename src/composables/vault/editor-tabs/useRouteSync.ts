import { computed, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'

export function useRouteSync(options: {
  activePath: Ref<string | null>
  openPost: (path: string) => Promise<void>
}) {
  const route = useRoute()
  const routePath = computed<string | null>(() => {
    const pathMatch = (route.params.pathMatch as string[] | undefined) ?? []
    return pathMatch.length ? pathMatch.join('/') : null
  })

  watch(routePath, (path) => {
    if (path && path !== options.activePath.value) {
      void options.openPost(path)
    }
  })

  return { routePath }
}
