import { isManagedDiaryPath } from '../../shared/diaryProtocol'
import { authFetch, diaryAuthFetch } from './auth-session'

type RequestInput = string | URL | Request

/**
 * History/resource routes sometimes spell the same logical Diary document
 * with a trailing `.md`. Normalize only that wire spelling before applying
 * the shared managed-Diary path contract.
 */
function logicalPath(path: string): string {
  return path.endsWith('.md') ? path.slice(0, -3) : path
}

export function isManagedDiaryRequestPath(path: string): boolean {
  return isManagedDiaryPath(logicalPath(path))
}

/**
 * Select the capability-bearing seam from the canonical document path. This
 * keeps ordinary Note requests on authFetch even while Diary is unlocked.
 */
export function authFetchForPath(
  path: string,
  input: RequestInput,
  init?: RequestInit,
): Promise<Response> {
  return isManagedDiaryRequestPath(path)
    ? diaryAuthFetch(input, init)
    : authFetch(input, init)
}

export function authFetchForPaths(
  paths: readonly string[],
  input: RequestInput,
  init?: RequestInit,
): Promise<Response> {
  return paths.some(isManagedDiaryRequestPath)
    ? diaryAuthFetch(input, init)
    : authFetch(input, init)
}
