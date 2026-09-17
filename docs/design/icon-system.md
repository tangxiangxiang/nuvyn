# Icon System

This page documents the approved target contract and the completed Phase 8 cleanup for
functional icons. The product and implementation plans are the record of the Icon
Foundation Design Amendment.

## Approved target architecture

New functional icons use one approved family:

```text
NIcon
  ↓
@vicons/tabler
```

The product architecture names `@vicons/tabler` as the canonical functional icon
family. Phase 0 uses `@vicons/tabler@0.13.0` as an exact-pinned implementation candidate;
the version can be upgraded through dependency and regression review without changing
the product-level family authority.

With visible text, the text provides the accessible name and the glyph is decorative:

```vue
<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui'
import { Search } from '@vicons/tabler'
</script>

<template>
  <NButton>
    <template #icon>
      <NIcon aria-hidden="true">
        <Search />
      </NIcon>
    </template>
    Search
  </NButton>
</template>
```

An icon-only control must provide its accessible name on the control itself:

```vue
<NButton
  circle
  aria-label="Search notes"
>
  <template #icon>
    <NIcon aria-hidden="true">
      <Search />
    </NIcon>
  </template>
</NButton>
```

Use each icon component by meaning, not by copying its SVG path. `aria-label` belongs on
an icon-only control; a tooltip is not its only accessible name. Icon size is selected by
the consuming control or surface, so these examples do not establish a global 18px rule.

Rules for new code:

- import functional glyphs only from `@vicons/tabler`;
- render them through `NIcon` (`<NIcon><TablerIcon /></NIcon>`); Naive UI controls use
  their documented icon slot or integration;
- let the consumer provide size, state color, and accessible name;
- mark decorative icons `aria-hidden="true"`;
- do not add hand-written functional `<svg>` or paste SVG paths into a component;
- do not add a second `@vicons/*` family or mix Material, Lucide, Heroicons, or
  Ionicons for functional controls.

Tabler's SVG canvas and stroke details belong to the approved upstream family. Nuvyn
does not re-enforce the legacy 16×16 geometry contract on these components.

### Target contract

| Concern | Authority |
| --- | --- |
| Product semantic choice | Nuvyn |
| Functional icon presentation | Naive UI `NIcon` |
| Functional glyph family | `@vicons/tabler` |
| Phase 0 candidate version | `0.13.0` exact pin |
| Glyph geometry and drawing | Tabler |
| Theme color | `currentColor` / consuming component theme |
| Size and density | `NIcon` and consuming control / surface |
| Accessible name | Consuming control |

`NButton` 等 Naive UI controls 使用正式的 icon slot；不要为了包一层 `NIcon` 建立
机械 `DIcon.vue` wrapper。Icon-only control 必须由 control 提供 `aria-label` 或等价
accessible name；带可见文字的 control 通常由该文字命名，decorative icon 则标记
`aria-hidden="true"`。具体 Tabler export 名称必须在迁移时以安装版本的真实
TypeScript exports 为准。

Functional family 规则禁止混入 Ionicons、Material、Fluent、Font Awesome、Ant
Design、Carbon、Lucide、Heroicons、`@tabler/icons-vue` 或其他 `@vicons/*` family。

## Ownership exceptions

The functional-family rule does not apply to:

- Nuvyn logo, brand constellation, brand decoration, product illustrations, and
  marketing artwork;
- Mermaid / Markmap output, ECharts output, chart SVG / canvas, and other
  renderer-owned graphics;
- Markdown / user-authored / generated content SVG;
- historical references to the former legacy icon source in archived design records;
  these records do not authorize new production consumers.

Each exception must have an identifiable owner and must not silently become a new
functional icon vocabulary.

## Phase 8 migration closure

The Vault/Note migration reached zero production consumers of the former
`src/components/vault/icons.ts` module. Phase 8 therefore removed that module, its
contract test, and the old `src/views/IconPreviewView.vue` route. Functional icons in
current production surfaces now use `NIcon` with the approved `@vicons/tabler` family.

`npm run lint:icons` and its strict variant remain active governance checks. They scan
current production SVG ownership and reject new hand-written functional SVGs or an
unapproved icon family; brand artwork, renderer output, and generated/user content
remain explicitly owned exceptions.

The lint implementation classifies brand, generated, user-content, and third-party
renderer SVG explicitly, and does not inspect Tabler's dependency-owned viewBox, path,
or stroke geometry.

The lint job is governance-oriented:

```text
new functional SVG in business code  → violation
unapproved icon-family import         → violation
approved @vicons/tabler import       → allowed
brand/generated/user SVG             → documented exception
```

## Source references

- [Repository lint](../../scripts/icon-lint.ts)
