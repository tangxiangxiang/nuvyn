import { h, type VNodeChild } from 'vue'
import { NIcon, type SelectGroupOption, type SelectOption } from 'naive-ui'
import { Tag } from '@vicons/tabler'
import type { LedgerAccountDto, LedgerAccountNature, LedgerCategoryDto } from '../../../shared/ledgerProtocol'
import { DEFAULT_CATEGORY_ICON } from '../../features/ledger/categoryIconMigration'
import { formatLedgerMoney } from '../../features/ledger/money'
import LedgerAccountIcon from './LedgerAccountIcon.vue'
import { NUVYN_BROWSER_STORAGE_KEYS, readStorageKey } from '../../technicalNamespace'

export function ledgerAccountSelectOptions(
  accounts: readonly LedgerAccountDto[],
  options: { showBalance?: boolean; allowedNatures?: readonly LedgerAccountNature[] } = {},
): SelectGroupOption[] {
  const { showBalance = true, allowedNatures } = options
  return (['asset', 'liability'] as const).flatMap((nature) => {
    if (allowedNatures && !allowedNatures.includes(nature)) return []
    const children: SelectOption[] = accounts
      .filter((account) => account.nature === nature)
      .sort((left, right) => right.currentBalanceMinor - left.currentBalanceMinor
        || left.name.localeCompare(right.name, 'zh-CN'))
      .map((account) => {
        const accountName = `${account.name}${account.archivedAt !== null ? '（已归档）' : ''}`
        const balanceLabel = showBalance
          ? formatLedgerMoney(account.currentBalanceMinor, account.currency)
          : ''
        return {
          value: account.id,
          label: balanceLabel ? `${accountName} · ${balanceLabel}` : accountName,
          accountName,
          balanceLabel,
        }
      })
    return children.length
      ? [{ type: 'group' as const, key: nature, label: nature === 'asset' ? '资产账户' : '负债账户', children }]
      : []
  })
}

function customCategoryIconSource(icon: string | undefined): string | undefined {
  if (!icon?.startsWith('custom_category_')) return undefined
  try {
    const icons = JSON.parse(readStorageKey(NUVYN_BROWSER_STORAGE_KEYS.ledgerCategoryCustomIcons) ?? '{}') as Record<string, unknown>
    const source = icons[icon]
    return typeof source === 'string'
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
      : undefined
  } catch {
    return undefined
  }
}

export function renderLedgerAccountLabel(
  option: SelectOption | SelectGroupOption,
  accounts: readonly LedgerAccountDto[],
): VNodeChild {
  if (option.type === 'group') {
    return h('span', { class: 'ledger-account-select-group' }, String(option.label ?? ''))
  }

  const account = accounts.find((item) => item.id === option.value)
  const accountName = String(option.accountName ?? account?.name ?? option.label ?? '')
  const balanceLabel = String(option.balanceLabel ?? '')
  return h('span', { class: 'ledger-account-select-option' }, [
    h('span', { class: 'ledger-account-select-icon', 'aria-hidden': 'true' }, [
      h(LedgerAccountIcon, { icon: account?.icon, size: 18 }),
    ]),
    h('span', { class: 'ledger-account-select-label' }, accountName),
    balanceLabel ? h('span', { class: 'ledger-account-select-balance' }, balanceLabel) : null,
  ])
}

export function renderLedgerCategoryLabel(
  option: SelectOption,
  categories: readonly LedgerCategoryDto[],
): VNodeChild {
  const category = categories.find((item) => item.id === option.value)
  if (!category) {
    return h('span', { class: 'ledger-category-select-option' }, [
      h('span', { class: 'ledger-category-select-icon', 'aria-hidden': 'true' }, [
        h(NIcon, { size: 18 }, { default: () => h(Tag) }),
      ]),
      h('span', { class: 'ledger-category-select-label' }, String(option.label ?? '')),
    ])
  }

  const icon = category.icon ?? DEFAULT_CATEGORY_ICON
  const customSource = customCategoryIconSource(icon)
  return h('span', { class: 'ledger-category-select-option' }, [
    h('span', { class: 'ledger-category-select-icon', 'aria-hidden': 'true' }, [
      customSource
        ? h('img', { src: customSource, alt: '', width: 18, height: 18 })
        : h(LedgerAccountIcon, { icon, size: 18 }),
    ]),
    h('span', { class: 'ledger-category-select-label' }, String(option.label ?? category.name)),
  ])
}
