import type { SelectNodeProps } from 'naive-ui'

/**
 * Add stable, public accessibility semantics to Ledger's select options.
 * Naive UI exposes nodeProps for this purpose; callers must not depend on its
 * implementation classes or pending-option marker.
 */
export const ledgerSelectNodeProps: SelectNodeProps = (option) => {
  if ('value' in option && option.value !== undefined) {
    return {
      role: 'option',
      'data-ledger-option': String(option.value),
    }
  }
  return { role: 'presentation' }
}
