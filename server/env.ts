/** Read a Nuvyn environment variable. Empty values are treated as unset. */
export function readCanonicalEnv(
  env: NodeJS.ProcessEnv,
  canonicalName: string,
): string | undefined {
  const canonical = env[canonicalName]?.trim()
  return canonical || undefined
}
