# Asciinema — VS Code Extension

[![Version](https://badgen.net/vs-marketplace/v/davidpine-dev.asciinema?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=davidpine-dev.asciinema)
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

### ☁️ Open from GitHub Pull Request

Review `.cast` recordings attached as CI artifacts without leaving VS Code:

1. Open the Command Palette and run **Asciinema: Open from GitHub Pull Request...**
2. Paste a GitHub PR URL (e.g., `https://github.com/owner/repo/pull/123`).
3. Sign in with VS Code's built-in GitHub authentication (one-time, `repo` scope).
4. The extension finds the latest completed workflow run with artifacts on the PR's head commit, lets you pick an artifact and (if needed) a specific `.cast` file, then opens it in the player.

Works with both public and private repositories. Downloaded casts are written to the extension's private session-scoped temp directory and cleaned up automatically on later activations.

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
