# Nuvyn Third-Party Notices

Third-party components and assets remain subject to their respective terms.
The reservation of rights over original Nuvyn materials does not restrict
rights granted by third-party licensors. This file records verified sources and
open audit items. It is a reference index, not a complete distribution notice
bundle or a compliance certification.

| Component | License or evidence |
| --- | --- |
| Microsoft Fluent Emoji Color SVGs | MIT, copyright Microsoft Corporation. The [original license text](public/emoji/FLUENT-EMOJI-LICENSE.txt) accompanies the bundled assets. See the [pinned source and per-asset mapping](docs/third-party/fluent-emoji.md). |
| Excalidraw `0.18.0-4e758db` | The locked package declares MIT for the library code. See the [upstream license](https://github.com/excalidraw/excalidraw/blob/master/LICENSE). Confirm the full notice at the shipped revision. Bundled fonts need their own notices. |
| Assistant font | SIL Open Font License 1.1. Assistant font files are present in the locally inspected browser build. See the [font license](https://github.com/google/fonts/blob/main/ofl/assistant/OFL.txt). |
| Monaco Editor and Codicons | Monaco Editor declares MIT and provides `LICENSE` and `ThirdPartyNotices.txt` in its installed package. The browser build contains the Codicon font. See the [Codicons upstream notices](https://github.com/microsoft/vscode-codicons/blob/main/LICENSE), including the separate Git-logo attribution. |
| KaTeX and KaTeX fonts | The installed KaTeX package includes its MIT license. KaTeX font files are present in the browser build. See the [KaTeX fonts license](https://github.com/KaTeX/katex-fonts/blob/master/LICENSE). |
| Tabler icons | The application uses `@vicons/tabler`, whose locked package declares MIT. See the [original Tabler Icons license](https://github.com/tabler/tabler-icons/blob/main/LICENSE). |
| Markdown emoji data | The [generator](scripts/generate-emoji-data.mjs) records the pinned `gemoji-json` revision and MIT designation. See the [upstream project](https://github.com/delthas/gemoji-json) and confirm the complete notice for the pinned revision before bundling the generated data's notices. |

## Audit scope and findings

The initial review used release commit
`5b105671b3e6017fa9e85fb67e5ee9dc9a70b1e7`, its
[`package-lock.json`](package-lock.json), matching local npm manifests, the
local `dist/` output, and the [Docker build recipe](Dockerfile).

- The lockfile has 731 non-root package records. Of those, 171 are marked
  development-only and 560 are not. Platform-optional records are included.
  There were 677 matching packages installed locally and 54 absent locally.
  These are lockfile and local-install counts, not counts of packages shipped
  in either Linux image or in the browser bundle.
- The two records without license metadata were checked against matching
  installed packages. `fuzzy@0.1.3` includes `LICENSE-MIT` (Matt York).
  `khroma@2.1.0` includes an MIT `license` file (Fabio Spampinato and
  Andrew Maney). `rgbcolor@1.0.1` has an unusual dual-license metadata
  string, but the installed package includes MIT terms in `LICENSE.md`
  (Stoyan Stefanov).
- No GPL or AGPL identifiers were found in the npm lockfile license fields.
  DOMPurify appears under an MPL-2.0/Apache-2.0 choice and Lightning CSS
  under MPL-2.0 on development-only lock entries. Record the license option
  used for each redistributed dual-licensed package. Check what the browser
  bundles actually contain, including code bundled from build-time packages.
- The local browser output preserves the Fluent Emoji license but has no
  consolidated third-party notice file. License text and notices in
  `node_modules` need to be checked separately from attribution delivered
  with browser assets.

## Open distribution items

- For each published Linux image, reconcile its SBOM and files with the npm
  lockfile, front-end bundles, embedded fonts, native SQLite binding, and
  Debian/Node packages. The image recipe installs Debian Git as a separate
  executable, invoked by Nuvyn as a subprocess. Verify the exact shipped
  Git package's notices and corresponding-source arrangements, along with
  the other base-image packages. See [Debian Git package and source information](https://packages.debian.org/bookworm/git).
- Confirm the source and permission status of the nine branded Ledger account
  graphics under `public/account-icons/`. Review trademark permissions
  separately from the copyright on the artwork.
- Collect the complete applicable license texts, attributions, and any
  corresponding-source materials for the components actually shipped. Verify
  they accompany the browser and GHCR artifacts as required. This repository
  index alone does not establish what the already published images contain.
