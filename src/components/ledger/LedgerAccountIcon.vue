<script setup lang="ts">
import { NIcon } from 'naive-ui'
import { Book, Briefcase, BuildingBank, Car, Cash, CashBanknote, ChartLine, CirclePlus, CreditCard, DeviceGamepad, DeviceMobile, Dots, FirstAidKit, Gift, Home, Luggage, Receipt, ReceiptRefund, ShieldCheck, ShoppingCart, ToiletPaper, ToolsKitchen2, Trophy, Wallet } from '@vicons/tabler'
import type { LedgerAccountIcon as AccountIcon } from '../../../shared/ledgerProtocol'
import { LEDGER_BUILTIN_ACCOUNT_ICONS } from '../../../shared/ledgerProtocol'
import { useLedgerAccountIconPreferences } from '../../composables/useLedgerAccountIconPreferences'

const props = withDefaults(defineProps<{ icon?: AccountIcon; size?: number }>(), { icon: 'wallet', size: 17 })
const preferences = useLedgerAccountIconPreferences()
const builtinSources: Readonly<Record<string, string>> = Object.fromEntries(LEDGER_BUILTIN_ACCOUNT_ICONS.map(({ id, src }) => [id, src]))
const builtinCategoryIcons: Readonly<Record<string, typeof Wallet>> = {
  custom_builtin_category_expense_food: ToolsKitchen2,
  custom_builtin_category_expense_transport: Car,
  custom_builtin_category_expense_shopping: ShoppingCart,
  custom_builtin_category_expense_home: Home,
  custom_builtin_category_expense_daily: ToiletPaper,
  custom_builtin_category_expense_communication: DeviceMobile,
  custom_builtin_category_expense_subscription: Receipt,
  custom_builtin_category_expense_entertainment: DeviceGamepad,
  custom_builtin_category_expense_medical: FirstAidKit,
  custom_builtin_category_expense_education: Book,
  custom_builtin_category_expense_travel: Luggage,
  custom_builtin_category_expense_gift: Gift,
  custom_builtin_category_expense_insurance: ShieldCheck,
  custom_builtin_category_expense_other: Dots,
  custom_builtin_category_income_salary: CashBanknote,
  custom_builtin_category_income_bonus: Trophy,
  custom_builtin_category_income_investment: ChartLine,
  custom_builtin_category_income_part_time: Briefcase,
  custom_builtin_category_income_refund: ReceiptRefund,
  custom_builtin_category_income_red_packet: Gift,
  custom_builtin_category_income_other: CirclePlus,
}
</script>

<template>
  <img v-if="builtinSources[props.icon]" class="ledger-custom-account-icon" :src="builtinSources[props.icon]" :width="size" :height="size" alt="" aria-hidden="true">
  <img v-else-if="props.icon?.startsWith('custom_') && preferences.getCustomIcon(props.icon)" class="ledger-custom-account-icon" :src="`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preferences.getCustomIcon(props.icon)!)}`" :width="size" :height="size" alt="" aria-hidden="true">
  <NIcon v-else :size="size" aria-hidden="true">
    <component :is="builtinCategoryIcons[props.icon ?? '']" v-if="builtinCategoryIcons[props.icon ?? '']" />
    <Wallet v-else-if="icon === 'wallet'" />
    <CreditCard v-else-if="icon === 'credit_card'" />
    <Cash v-else-if="icon === 'cash'" />
    <BuildingBank v-else-if="icon === 'building_bank'" />
    <Briefcase v-else />
  </NIcon>
</template>

<style scoped>
.ledger-custom-account-icon { display: block; object-fit: contain; }
</style>
