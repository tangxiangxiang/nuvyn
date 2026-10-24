import { computed, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { OpenPostOptions } from '../../../components/vault/tabs'

export function useRouteSync(options: {
  activePath: Ref<string | null>
  openPost: (path: string, options?: OpenPostOptions) => Promise<void>
  onRouteIntent?: (path: string | null, previousPath: string | null) => void
}) {
  const route = useRoute()
  const router = useRouter()
  // Search carries explicit, one-shot browsing intent. Consume it immediately
  // so a refresh of the same URL becomes a normal retained document open.
  function takeMode(): 'preview' | undefined {
    const history = router.options.history
    if (history.state.nuvynTabMode !== 'preview') return undefined
    history.replace(history.location, { ...history.state, nuvynTabMode: null })
    return 'preview'
  }
  const initialMode = takeMode()
  const routePath = computed<string | null>(() => {
    const pathMatch = (route.params.pathMatch as string[] | undefined) ?? []
    return pathMatch.length ? pathMatch.join('/') : null
  })

  watch(routePath, (path, previousPath) => {
    options.onRouteIntent?.(path, previousPath)
    if (path && path !== options.activePath.value) {
      if (takeMode() === 'preview') void options.openPost(path, { mode: 'preview' })
      else void options.openPost(path)
    }
  }, { flush: 'sync' })

  return { routePath, initialMode }
}
