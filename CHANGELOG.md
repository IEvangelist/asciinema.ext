# Changelog

All notable changes to the **Asciinema** extension will be documented in this file.

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
