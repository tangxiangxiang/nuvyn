<script setup lang="ts">
import { computed, defineComponent, h, onMounted, ref } from 'vue'
import type { Component } from 'vue'
import {
  NButton,
  NCard,
  NCheckbox,
  NConfigProvider,
  NDatePicker,
  NDialogProvider,
  NEmpty,
  NIcon,
  NInput,
  NMessageProvider,
  NNotificationProvider,
  NSelect,
  NSwitch,
  darkTheme,
  dateEnUS,
  dateZhCN,
  enUS,
  useDialog,
  useMessage,
  useNotification,
  zhCN,
  type DialogReactive,
  type MessageReactive,
  type NotificationReactive,
} from 'naive-ui'
import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronDown,
  File,
  Folder,
  Plus,
  Search,
  Settings,
  Trash,
} from '@vicons/tabler'
import { createNuvynNaiveThemeOverrides } from '../../naiveTheme'

type ThemeMode = 'light' | 'dark'
type FixtureLocale = 'zh' | 'en'

const props = withDefaults(defineProps<{
  themeMode: ThemeMode
  locale: FixtureLocale
  initialDate?: string
}>(), {
  initialDate: '2026-09-07',
})

const theme = computed(() => props.themeMode === 'dark' ? darkTheme : null)
const locale = computed(() => props.locale === 'zh' ? zhCN : enUS)
const dateLocale = computed(() => props.locale === 'zh' ? dateZhCN : dateEnUS)

// This is the runtime experiment for the theme bridge. Naive's Input theme
// derives an alpha color from primaryColor with seemly, so only that base field
// needs a resolved mirror. Explicit primary hover/pressed values and raw
// surface fields stay CSS-variable-backed; the spike test records the parser
// boundary separately with a direct all-variable mount.
const themeOverrides = computed(() => createNuvynNaiveThemeOverrides(props.themeMode))

const iconExports = {
  Search,
  Settings,
  Plus,
  Calendar,
  Trash,
  Folder,
  File,
  ChevronDown,
  Check,
  AlertTriangle,
} as const

const selectOptions = [
  { label: 'Ledger', value: 'ledger' },
  { label: 'Diary', value: 'diary' },
]

const inputValue = ref('')
const selectedValue = ref('ledger')
const checked = ref(false)
const switched = ref(false)
const formattedDate = ref(props.initialDate)
const childMountCount = ref(0)
const dateLocaleProbeStartTime = Date.UTC(2026, 8, 7, 12)

const CompatibilityChild = defineComponent({
  name: 'CompatibilityChild',
  emits: ['mounted'],
  setup(_, { emit }) {
    const message = useMessage()
    const dialog = useDialog()
    const notification = useNotification()
    const activeMessage = ref<MessageReactive | null>(null)
    const activeDialog = ref<DialogReactive | null>(null)
    const activeNotification = ref<NotificationReactive | null>(null)

    onMounted(() => emit('mounted'))

    function showMessage(): void {
      activeMessage.value?.destroy()
      activeMessage.value = message.success('Spike message', { duration: 0 })
    }

    function showDialog(): void {
      activeDialog.value?.destroy()
      activeDialog.value = dialog.info({
        title: 'Spike dialog',
        content: 'Provider dialog content',
        positiveText: 'Close',
      })
    }

    function showNotification(): void {
      activeNotification.value?.destroy()
      activeNotification.value = notification.success({
        title: 'Spike notification',
        content: 'Provider notification content',
        duration: 0,
      })
    }

    function destroyOverlays(): void {
      activeMessage.value?.destroy()
      activeDialog.value?.destroy()
      activeNotification.value?.destroy()
      activeMessage.value = null
      activeDialog.value = null
      activeNotification.value = null
      message.destroyAll()
      dialog.destroyAll()
      notification.destroyAll()
    }

    function iconSlot(Icon: Component, size = 16) {
      return () => h(NIcon, { size, 'aria-hidden': 'true' }, { default: () => h(Icon) })
    }

    return () => h('section', { 'data-testid': 'compatibility-child' }, [
      h(NButton, { 'data-testid': 'show-message', onClick: showMessage }, { default: () => 'Show message' }),
      h(NButton, { 'data-testid': 'show-dialog', onClick: showDialog }, { default: () => 'Show dialog' }),
      h(NButton, { 'data-testid': 'show-notification', onClick: showNotification }, { default: () => 'Show notification' }),
      h(NButton, { 'data-testid': 'destroy-overlays', onClick: destroyOverlays }, { default: () => 'Destroy overlays' }),
      h(NButton, {
        'data-testid': 'text-icon-button',
        onClick: () => undefined,
      }, {
        icon: iconSlot(Search),
        default: () => 'Search',
      }),
      h(NButton, {
        'data-testid': 'icon-only-button',
        circle: true,
        'aria-label': 'Search notes',
      }, { icon: iconSlot(Search) }),
      h(NIcon, {
        'data-testid': 'standalone-icon',
        size: 16,
        color: 'var(--nuvyn-accent)',
        'aria-hidden': 'true',
      }, { default: () => h(Settings) }),
      h(NButton, { size: 'small', 'data-testid': 'compact-button' }, {
        icon: () => h(NIcon, { 'data-testid': 'compact-icon', size: 14, 'aria-hidden': 'true' }, { default: () => h(Plus) }),
        default: () => 'Compact',
      }),
      h(NButton, { 'data-testid': 'default-button' }, {
        icon: () => h(NIcon, { 'data-testid': 'default-icon', size: 20, 'aria-hidden': 'true' }, { default: () => h(Check) }),
        default: () => 'Default',
      }),
      h(NButton, { size: 'small', disabled: true, 'data-testid': 'compact-disabled-button' }, { default: () => 'Compact disabled' }),
      h(NButton, { disabled: true, 'data-testid': 'default-disabled-button' }, { default: () => 'Default disabled' }),
      h(NButton, { size: 'small', loading: true, 'data-testid': 'compact-loading-button' }, { default: () => 'Compact loading' }),
      h(NButton, { loading: true, 'data-testid': 'default-loading-button' }, { default: () => 'Default loading' }),
    ])
  },
})
</script>

<template>
  <NConfigProvider
    data-testid="naive-provider-fixture"
    :theme="theme"
    :theme-overrides="themeOverrides"
    :locale="locale"
    :date-locale="dateLocale"
    :preflight-style-disabled="true"
  >
    <NDialogProvider>
      <NMessageProvider>
        <NNotificationProvider>
          <div class="naive-ui-foundation-spike">
            <output data-testid="theme-mode">{{ props.themeMode }}</output>
            <output data-testid="fixture-locale">{{ props.locale }}</output>
            <output data-testid="child-mount-count">{{ childMountCount }}</output>

            <CompatibilityChild @mounted="childMountCount += 1" />

            <NInput v-model:value="inputValue" data-testid="input" placeholder="Enter value" />
            <NSelect v-model:value="selectedValue" data-testid="select" :options="selectOptions" />
            <NCheckbox v-model:checked="checked" data-testid="checkbox">Check option</NCheckbox>
            <NSwitch v-model:value="switched" data-testid="switch" />
            <NDatePicker
              v-model:formatted-value="formattedDate"
              data-testid="date-picker"
              type="date"
              value-format="yyyy-MM-dd"
            />
            <output data-testid="formatted-date">{{ formattedDate }}</output>
            <div data-testid="date-locale-panel">
              <NDatePicker
                panel
                type="date"
                :default-calendar-start-time="dateLocaleProbeStartTime"
              />
            </div>
            <NCard data-testid="surface-color-probe">Surface color probe</NCard>
            <NEmpty data-testid="locale-surface" />

            <div data-testid="icon-export-probe">
              <NIcon
                v-for="(Icon, name) in iconExports"
                :key="name"
                :data-icon="name"
                size="16"
                aria-hidden="true"
              >
                <component :is="Icon" />
              </NIcon>
            </div>
          </div>
        </NNotificationProvider>
      </NMessageProvider>
    </NDialogProvider>
  </NConfigProvider>
</template>
