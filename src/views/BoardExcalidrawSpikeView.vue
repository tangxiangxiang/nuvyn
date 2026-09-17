<script setup lang="ts">
import { computed, ref } from 'vue'
import ExcalidrawHost from '../components/board/ExcalidrawHost.vue'

type SpikeTheme = 'light' | 'dark'

const theme = ref<SpikeTheme>('light')
const mounted = ref(true)
const ready = ref(false)
const changeCount = ref(0)
const errorMessage = ref('')

const themeLabel = computed(() => theme.value === 'light' ? 'Light' : 'Dark')

function toggleTheme(): void {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
}

function toggleMount(): void {
  mounted.value = !mounted.value
  ready.value = false
}

function onChange(): void {
  changeCount.value += 1
}

function onError(error: unknown): void {
  errorMessage.value = error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <main class="board-excalidraw-spike">
    <header class="spike-header">
      <div>
        <p class="spike-eyebrow">Temporary development route</p>
        <h1>Board Excalidraw Compatibility Spike</h1>
      </div>
      <div class="spike-controls" aria-label="Compatibility spike controls">
        <button type="button" data-testid="theme-toggle" @click="toggleTheme">
          Theme: {{ themeLabel }}
        </button>
        <button type="button" data-testid="mount-toggle" @click="toggleMount">
          {{ mounted ? 'Unmount' : 'Remount' }}
        </button>
      </div>
    </header>

    <p class="spike-status" data-testid="spike-status">
      {{ ready ? 'Ready' : 'Loading' }} · Scene changes: {{ changeCount }}
    </p>
    <p v-if="errorMessage" class="spike-error" role="alert">{{ errorMessage }}</p>

    <section class="spike-surface" aria-label="Excalidraw compatibility surface">
      <ExcalidrawHost
        v-if="mounted"
        :initial-scene="{ elements: [], appState: {}, files: {} }"
        :theme="theme"
        @change="onChange"
        @ready="ready = true"
        @error="onError"
      />
    </section>
  </main>
</template>

<style scoped>
.board-excalidraw-spike {
  min-height: calc(100vh - var(--navbar-h));
  padding: 1.5rem;
  background: var(--vs-bg-1);
}

.spike-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.spike-eyebrow {
  margin: 0 0 0.25rem;
  color: var(--nuvyn-text-3, #6b7280);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-size: 1.35rem;
}

.spike-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

button {
  border: 1px solid var(--nuvyn-border, #d1d5db);
  border-radius: 0.4rem;
  padding: 0.45rem 0.7rem;
  background: var(--nuvyn-surface-1, #fff);
  color: inherit;
  cursor: pointer;
}

.spike-status,
.spike-error {
  margin: 0 0 0.75rem;
}

.spike-error {
  color: #b91c1c;
}

.spike-surface {
  min-height: 32rem;
  height: calc(100vh - 11rem);
  overflow: hidden;
  border: 1px solid var(--nuvyn-border, #d1d5db);
  border-radius: 0.5rem;
  background: #fff;
}
</style>
