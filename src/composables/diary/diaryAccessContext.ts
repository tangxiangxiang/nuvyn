import type { InjectionKey } from 'vue'
import type { ScopeKey } from '../../../shared/scopeProtocol'
import type { DiaryAccessSession } from './useDiaryAccessSession'

export interface DiaryAccessContext {
  readonly session: DiaryAccessSession
  readonly requestAccess: () => Promise<boolean>
  readonly requestScopeChange: (scope: ScopeKey) => Promise<void>
  readonly lock: () => Promise<void>
}

export const DiaryAccessContextKey: InjectionKey<DiaryAccessContext> = Symbol('nuvyn.diary-access')
