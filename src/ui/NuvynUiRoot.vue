<script setup lang="ts">
import { computed } from 'vue'
import {
  darkTheme,
  dateEnUS,
  dateZhCN,
  enUS,
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
  zhCN,
} from 'naive-ui'
import App from '../App.vue'
import { useI18n } from '../composables/useI18n'
import { useTheme } from '../composables/useTheme'
import { createNuvynNaiveThemeOverrides } from './naiveTheme'

const { theme } = useTheme()
const { locale } = useI18n()

const naiveTheme = computed(() => theme.value === 'dark' ? darkTheme : null)
const naiveThemeOverrides = computed(() => createNuvynNaiveThemeOverrides(theme.value))
const naiveLocale = computed(() => locale.value === 'zh' ? zhCN : enUS)
const naiveDateLocale = computed(() => locale.value === 'zh' ? dateZhCN : dateEnUS)
</script>

<template>
  <NConfigProvider
    :theme="naiveTheme"
    :theme-overrides="naiveThemeOverrides"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
  >
    <NDialogProvider>
      <NMessageProvider>
        <NNotificationProvider>
          <App />
        </NNotificationProvider>
      </NMessageProvider>
    </NDialogProvider>
  </NConfigProvider>
</template>
