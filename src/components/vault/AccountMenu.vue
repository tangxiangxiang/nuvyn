<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { Lock, Logout, Settings, User } from '@vicons/tabler'
import { useI18n } from '../../composables/useI18n'

const props = withDefaults(defineProps<{
  username?: string | null
  logoutBusy?: boolean
  diaryUnlocked?: boolean
  diaryLockBusy?: boolean
}>(), {
  username: '',
  logoutBusy: false,
  diaryUnlocked: false,
  diaryLockBusy: false,
})

const emit = defineEmits<{
  'open-settings': []
  logout: []
  'lock-diary': []
}>()

const { t } = useI18n()
const rootRef = ref<HTMLElement | null>(null)
const buttonRef = ref<{ $el: HTMLButtonElement } | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const accountMenuOpen = ref(false)
const displayUsername = computed(() => props.username?.trim() || t('activity.owner'))

function focusTrigger(): void {
  buttonRef.value?.$el.focus()
}

function getEnabledMenuItems(): HTMLElement[] {
  if (!menuRef.value) return []
  return Array.from(
    menuRef.value.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
  )
}

function focusMenuItem(index: number): void {
  const menuItems = getEnabledMenuItems()
  if (!menuItems.length) return
  const wrappedIndex = (index + menuItems.length) % menuItems.length
  menuItems[wrappedIndex]?.focus()
}

function closeAccountMenu(restoreFocus = false): void {
  if (!accountMenuOpen.value) return
  accountMenuOpen.value = false
  if (restoreFocus) {
    void nextTick(focusTrigger)
  }
}

async function openAccountMenu(): Promise<void> {
  accountMenuOpen.value = true
  await nextTick()
  focusMenuItem(0)
}

function toggleAccountMenu(): void {
  if (props.logoutBusy) return
  if (accountMenuOpen.value) closeAccountMenu()
  else void openAccountMenu()
}

function handleLogout(): void {
  if (props.logoutBusy) return
  closeAccountMenu(true)
  emit('logout')
}

async function handleSettings(): Promise<void> {
  if (props.logoutBusy) return
  // Settings is rendered outside this menu. Close and unmount the popover
  // first, then restore focus to the stable account trigger before notifying
  // the shell. The SettingsModal focus trap can therefore capture the real
  // trigger and return focus here when it closes.
  closeAccountMenu()
  await nextTick()
  focusTrigger()
  emit('open-settings')
}

function handleLockDiary(): void {
  if (props.logoutBusy || props.diaryLockBusy || !props.diaryUnlocked) return
  closeAccountMenu(true)
  emit('lock-diary')
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!accountMenuOpen.value) return
  const target = event.target
  if (!(target instanceof Node) || !rootRef.value?.contains(target)) closeAccountMenu()
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (!accountMenuOpen.value) return

  const menuItems = getEnabledMenuItems()
  const currentIndex = menuItems.indexOf(document.activeElement as HTMLElement)

  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      closeAccountMenu(true)
      break
    case 'ArrowDown':
      event.preventDefault()
      focusMenuItem(currentIndex >= 0 ? currentIndex + 1 : 0)
      break
    case 'ArrowUp':
      event.preventDefault()
      focusMenuItem(currentIndex >= 0 ? currentIndex - 1 : menuItems.length - 1)
      break
    case 'Home':
      event.preventDefault()
      focusMenuItem(0)
      break
    case 'End':
      event.preventDefault()
      focusMenuItem(menuItems.length - 1)
      break
    case 'Tab':
      closeAccountMenu()
      break
    default:
      break
  }
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !accountMenuOpen.value) return
  event.preventDefault()
  closeAccountMenu(true)
}

watch(() => props.logoutBusy, (busy) => {
  if (busy) closeAccountMenu()
})

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<template>
  <div ref="rootRef" class="account-menu-root">
    <NButton
      ref="buttonRef"
      attr-type="button"
      size="small"
      quaternary
      :bordered="false"
      class="ab-btn ab-btn-account"
      :title="t('activity.account')"
      :aria-label="t('activity.account')"
      :aria-expanded="accountMenuOpen"
      aria-haspopup="menu"
      :aria-controls="accountMenuOpen ? 'account-menu' : undefined"
      :aria-busy="props.logoutBusy || undefined"
      :disabled="props.logoutBusy"
      data-testid="account-button"
      @click="toggleAccountMenu"
    >
      <NIcon class="ab-btn-icon" aria-hidden="true"><User /></NIcon>
    </NButton>

    <div
      v-if="accountMenuOpen"
      ref="menuRef"
      id="account-menu"
      class="account-popover"
      role="menu"
      :aria-label="t('activity.account_menu')"
      data-testid="account-menu"
      @keydown="onMenuKeydown"
    >
      <div class="account-menu-summary">
        <span class="account-menu-summary-label">{{ t('activity.account') }}</span>
        <span class="account-menu-username" :title="displayUsername">{{ displayUsername }}</span>
      </div>
      <div class="account-menu-divider" role="separator" />
      <NButton
        attr-type="button"
        size="small"
        text
        class="account-menu-item"
        role="menuitem"
        tabindex="-1"
        :disabled="props.logoutBusy"
        data-testid="account-settings"
        @click="handleSettings"
      >
        <NIcon class="account-menu-item-icon" aria-hidden="true"><Settings /></NIcon>
        <span>{{ t('activity.settings') }}</span>
      </NButton>
      <NButton
        v-if="props.diaryUnlocked"
        attr-type="button"
        size="small"
        text
        class="account-menu-item"
        role="menuitem"
        tabindex="-1"
        :disabled="props.logoutBusy || props.diaryLockBusy"
        :aria-busy="props.diaryLockBusy || undefined"
        data-testid="account-lock-diary"
        @click="handleLockDiary"
      >
        <NIcon class="account-menu-item-icon" aria-hidden="true"><Lock /></NIcon>
        <span>{{ props.diaryLockBusy ? t('diary_access.working') : t('diary_access.lock') }}</span>
      </NButton>
      <NButton
        attr-type="button"
        size="small"
        text
        class="account-menu-item"
        role="menuitem"
        tabindex="-1"
        :disabled="props.logoutBusy"
        :aria-busy="props.logoutBusy || undefined"
        data-testid="account-logout"
        @click="handleLogout"
      >
        <NIcon class="account-menu-item-icon" aria-hidden="true"><Logout /></NIcon>
        <span>{{ props.logoutBusy ? t('auth.logging_out') : t('nav.logout') }}</span>
      </NButton>
    </div>
  </div>
</template>
