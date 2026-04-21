# Changelog

All notable changes to the **Asciinema** extension will be documented in this file.

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
