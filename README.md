# Asciinema — VS Code Extension

[![Version](https://img.shields.io/visual-studio-marketplace/v/davidpine-dev.asciinema?label=Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=davidpine-dev.asciinema)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/davidpine-dev.asciinema)](https://marketplace.visualstudio.com/items?itemName=davidpine-dev.asciinema)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/davidpine-dev.asciinema)](https://marketplace.visualstudio.com/items?itemName=davidpine-dev.asciinema&ssr=false#review-details)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Preview and play [asciinema](https://asciinema.org) `.cast` terminal recordings directly in Visual Studio Code.

## Install

- **VS Code:** search for **Asciinema** in the Extensions view (`Ctrl+Shift+X`), or install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=davidpine-dev.asciinema).
- **Command line:** `code --install-extension davidpine-dev.asciinema`

## Features

### 🎬 Inline Player

Click any `.cast` file in the Explorer and it opens in the **asciinema player** — right inside a VS Code editor tab. No external tools needed.

### 🎨 File Icon

`.cast` files display the recognizable asciinema logo in the Explorer and editor tabs, making them easy to spot in your project tree.

### 📝 Open as Text

Need to inspect the raw NDJSON? Use the **"Open as Text"** button in the editor title bar (or right-click → _Open With..._) to switch to the standard text editor.

## Supported Formats

- **asciicast v2** — the current standard format produced by `asciinema rec`
- **asciicast v3** — the latest format revision

## Requirements

- VS Code 1.109.0 or later

## Extension Settings

This extension does not contribute any custom settings.

## Known Issues

None at this time.

## Release Notes

See [CHANGELOG](CHANGELOG.md) for detailed release notes.

## License

[MIT](LICENSE)
