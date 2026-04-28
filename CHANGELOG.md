# Changelog

All notable changes to the **asciinema.casts** extension will be documented in this file.

## [0.2.1] - 2026-04-27

### Fixed

- **`Reveal extracted files in Explorer` actually works now.** The old fallback called VS Code's `revealInExplorer`, which silently no-ops for paths outside the workspace — and extracted artifacts live in `globalStorageUri`, so it never did anything. Replaced with a **Browse extracted files…** sub-picker offering three guaranteed-to-work options:
  - **Open folder in new VS Code window** (`vscode.openFolder` + `forceNewWindow`)
  - **Add folder to current workspace** (`updateWorkspaceFolders`)
  - **Show in File Explorer / Finder / file manager** (`vscode.env.openExternal`, OS-aware label)
- **Astro preview falls back to the built-in static server on failure.** If `astro` isn't installed and you decline (or `npm install -g astro` fails), or if `astro preview` exits before serving a URL (crash, unsupported config, missing `dist/`, port conflict, etc.), the artifact is now served by the embedded Node HTTP server instead of leaving you with a dead terminal. The fallback terminal includes a yellow header explaining why.

## [0.2.0] - 2026-04-27

### Added — GitHub Artifacts Explorer 🚀

The **Open from Pull Request** command has been rebuilt as the **GitHub: Artifacts Explorer**, a content-aware artifact browser.

- **Smart artifact dispatch.** Detects what's inside a downloaded artifact and offers the right way to open it:
  - `.cast` files → Asciinema player picker (with duration parsed from the cast header).
  - **Astro builds** (`package.json` astro dep / `_astro/` dir / generator meta) → detect `astro` CLI, offer to `npm install -g astro` if missing, run `astro preview` in a managed Pseudoterminal, open Simple Browser at the served URL automatically.
  - **Generic static sites** (any shallowest `index.html`) → spin up an embedded Node HTTP server (port 0, traversal-guarded, mime-mapped) and open Simple Browser.
  - Falls back to **Reveal in Explorer** when nothing matches.
- **Persistent recents.** Successful opens are saved to `globalState` (capped at 25, oldest evicted). The picker lists them with codicons, relative timestamps, run conclusion icons, and per-item buttons (open PR · open run · forget). Picker-level buttons add **Refresh** and **Forget All**. Recents survive VS Code restarts; their files do too — orphan dirs are cleaned on activation.
- **Live progress indicators.** Both download and extraction now stream real percentages (`12.4 MB of 87.0 MB (14%)` / `12,403 / 27,718 files · 184.2 MB (44%)`), throttled to ~10 updates/sec.
- **Cheeky download/extract quips.** After 5s of waiting, you get a rotating cast of dev-humor tied to elapsed time (40+ jokes, 7s rotation, smooth tier transitions) — `🛰️ Pretty sure these bits went via satellite. Twice.`, `🥖 You could've baked bread by now.`, etc. Extraction has its own zip-themed extras.
- **Recoverable cap-breach UX.** Hit a `maxArtifactEntryCount` / `maxArtifactEntrySizeMB` / `maxArtifactExtractedMB` cap and you get a notification with **Raise to N & Retry**, **Set custom value…**, **Open Settings**, or **Cancel** — instead of a dead-end error.
- **True extraction resume.** When you raise a cap and retry, the extraction skips files already on disk (stat-based check, no re-decompression) and picks up where it left off. Restarting at 24k/27k is now near-instant.

### Configuration — new

- `asciinema.maxArtifactExtractedMB` *(new, default 2048, max 16384)* — total uncompressed size cap.
- `asciinema.maxArtifactEntryCount` *(new, default 250000, max 2000000)* — file-count cap.
- `asciinema.maxArtifactEntrySizeMB` *(new, default 500, max 8192)* — single-file size cap.

### Changed

- Command rebranded **Asciinema: Open Artifact from GitHub Pull Request** → **GitHub: Artifacts Explorer**.
- `asciinema.maxArtifactSizeMB` default raised 100 → **250 MB**, max 2048 → 4096.
- Hard download safety ceiling raised 2 GB → 4 GB.

## [0.1.4] - 2026-04-20

### Changed

- Marketplace display name is now **asciinema.casts** (was "Asciinema") to better match our branding and the in-product mark.

## [0.1.3] - 2026-04-20

### Added

- New setting `asciinema.maxArtifactSizeMB` (default **100 MB**, bumped from 50 MB) for the workflow-artifact compressed-size cap on **Asciinema: Open from GitHub Pull Request**.
- When a selected artifact exceeds the configured cap, the extension now shows a modal warning with the actual vs. configured size and a **Download Anyway** confirmation, instead of silently refusing.
- Animated demo GIF embedded in the README (rendered from `samples/demo.cast` via `agg`).

### Changed

- Rewrote the README around a stronger hook, a visible demo, and a tighter feature narrative.
- Refined the Marketplace icon: added a blinking terminal cursor after `.casts`, bumped the PNG to 256×256 for crisper rendering at every size.

## [0.1.2] - 2026-04-20

### Changed

- Reworked the Marketplace icon so the `.casts` bubble now sits as a drop-shadowed overlay badge on top of the full asciinema mark (v0.1.1 had split the composition instead of overlaying).

## [0.1.1] - 2026-04-20

### Changed

- Redesigned the Marketplace icon to add a beveled `.casts` bubble that clearly differentiates this extension's mark from the upstream asciinema logo.
- Added a prominent **Credits & Acknowledgements** section to the README linking to [asciinema.org](https://asciinema.org) and the upstream maintainers.
- Added a top-level `NOTICE` file providing full attribution for the bundled `asciinema-player` (Apache-2.0) and the asciinema play-triangle mark used to identify the `.cast` file format.

## [0.1.0] - 2026-04-20

### Added

- **Open from GitHub Pull Request** command — paste a GitHub PR URL and the extension signs in with VS Code's built-in GitHub auth, finds the latest completed CI run on the PR head commit, and downloads any `.cast` files bundled in its workflow artifacts. Works with public and private repos.
- Quick picks for choosing between multiple artifacts on a run or multiple `.cast` files inside a single artifact.
- Session-scoped temp storage under the extension's global storage with automatic cleanup of older sessions on activation.
- Pure-logic tests for PR URL parsing, filename sanitization, and zip extraction guards (`npm test`).

## [0.0.3] - 2026-04-20

### Changed

- Removed installs badge from README (`badgen.net` returns "500" text for newly published extensions until Marketplace stats propagate)

## [0.0.2] - 2026-04-20

### Changed

- Switched Marketplace badges to `badgen.net` (shields.io Marketplace badges were retired; `vsmarketplacebadges.dev` returns HTTP 500 for newly published extensions)
- Removed rating badge until real ratings exist
- Added `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` opt-in to GitHub Actions workflows

### Fixed

- Removed broken `preview.png` reference from README

## [0.0.1] - 2026-02-18

### Added

- Initial release
- Custom readonly editor for `.cast` files with embedded asciinema player
- Automatic playback of asciicast v2/v3 terminal recordings
- Custom file icon for `.cast` files in the Explorer
- "Open as Text" command to view raw `.cast` file content
