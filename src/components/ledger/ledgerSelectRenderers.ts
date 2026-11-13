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

export function ledgerCategorySelectOptions(
  categories: readonly LedgerCategoryDto[],
  recentIds: readonly string[],
): Array<SelectOption | SelectGroupOption> {
  const options = new Map<string, SelectOption>(categories.map((category) => [category.id, {
    value: category.id,
    label: category.name,
    categoryIcon: category.icon,
  }]))
  const recent: SelectOption[] = []
  for (const id of recentIds) {
    const option = options.get(id)
    if (option) {
      recent.push(option)
      options.delete(id)
    }
  }
  const other = [...options.values()]
  if (!recent.length) return other
  const groups: SelectGroupOption[] = [{ type: 'group', key: 'recent', label: '最近常用', children: recent }]
  if (other.length) groups.push({ type: 'group', key: 'other', label: '其他分类', children: other })
  return groups
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
    return renderLedgerSelectGroupLabel(option)
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

function renderLedgerSelectGroupLabel(option: SelectOption | SelectGroupOption): VNodeChild {
  return h('span', { class: 'ledger-select-group-label' }, String(option.label ?? ''))
}

export function renderLedgerCategoryLabel(
  option: SelectOption | SelectGroupOption,
  categories: readonly LedgerCategoryDto[],
): VNodeChild {
  if (option.type === 'group') return renderLedgerSelectGroupLabel(option)

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
