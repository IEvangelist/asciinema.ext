# .casts — Asciinema Player for VS Code

[![Version](https://badgen.net/vs-marketplace/v/davidpine-dev.asciinema?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=davidpine-dev.asciinema)
[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](LICENSE)

> **Play terminal recordings without leaving your editor.** Open any `.cast` file in VS Code and it just plays — and if the recording lives in a GitHub PR's CI artifacts, grab it straight from there too.

<p align="center">
  <img src="media/demo.gif" alt="Playing an asciinema .cast recording inside a VS Code editor tab" />
</p>

> ℹ️ Independent, third-party extension. Built on top of [asciinema](https://asciinema.org) — see [Credits](#credits--acknowledgements).

## Install

```
code --install-extension davidpine-dev.asciinema
```

…or search **`.casts`** / **Asciinema** in the Extensions view (`Ctrl+Shift+X`).

## What you get

- 🎬 **Zero-setup playback.** Click any `.cast` file and it opens in the asciinema player, right inside an editor tab. No export, no external viewer, no browser trip.
- ☁️ **GitHub Artifacts Explorer.** Run **GitHub: Artifacts Explorer**, paste a PR URL, and the extension downloads its CI build artifacts and figures out how to open them: `.cast` recordings → asciinema player; **Astro builds** → `astro preview` + Simple Browser; any **static site** with an `index.html` → embedded HTTP server + Simple Browser; everything else → reveal in Explorer. Recents persist across restarts and resume mid-extraction if you raise a size cap.
- 🗂️ **Native file identity.** `.cast` files get a recognizable icon in the Explorer and can be toggled between the player and raw text with one click.

## Usage

### Local `.cast` files

Just open the file. That's it. The asciinema player takes over the tab. Use the **Open as Text** button in the editor title bar if you need to inspect the raw NDJSON.

### From a GitHub pull request

1. `Ctrl+Shift+P` → **GitHub: Artifacts Explorer**
2. Pick a recent artifact, or paste a PR URL to download a new one (e.g., `https://github.com/owner/repo/pull/123`).
3. Sign in with VS Code's built-in GitHub auth (one-time, `repo` scope).
4. Let the extension dispatch on content type — it'll auto-pick the best way to open the artifact (cast picker / Astro preview / static server / Explorer).

Works with public and private repos. Recent artifacts persist across VS Code restarts; their files are kept on disk for instant re-open and cleaned up when forgotten.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `asciinema.maxArtifactSizeMB` | `250` | Maximum compressed artifact size that downloads without prompting. Larger artifacts still work — you just get a confirmation dialog showing the actual vs. configured size. |
| `asciinema.maxArtifactExtractedMB` | `2048` | Maximum total uncompressed size of artifact contents written to disk during extraction. |
| `asciinema.maxArtifactEntryCount` | `250000` | Maximum number of files allowed inside an artifact zip. |
| `asciinema.maxArtifactEntrySizeMB` | `500` | Maximum uncompressed size of any single file inside an artifact zip. |

If extraction trips a cap, you'll get a notification with **Raise & Retry**, **Set custom value…**, or **Open Settings** — never a dead-end. Retries resume from where they left off.

## Supported formats

- **asciicast v2** — the current standard format produced by `asciinema rec`
- **asciicast v3** — the latest format revision

## Requirements

VS Code 1.109.0 or later.

## Credits & Acknowledgements

This extension is a playback shell around **[asciinema](https://asciinema.org)** — the excellent terminal session recorder created by **[Marcin Kulik](https://hachyderm.io/@ku1ik)** and the asciinema community. All of the heavy lifting (the `.cast` file format, the recording tools, and the playback engine) comes from their work; this extension just wires it into VS Code.

- 🌐 Website: <https://asciinema.org>
- 📚 Documentation: <https://docs.asciinema.org>
- 🎥 asciinema-player (bundled): <https://github.com/asciinema/asciinema-player> (Apache-2.0)
- 🎙️ CLI recorder: <https://github.com/asciinema/asciinema>
- 💚 Support the project: <https://docs.asciinema.org/donations/>

This extension is an independent, third-party project. It is **not** an official asciinema product and is **not** affiliated with or endorsed by the asciinema project or its maintainers. See [`NOTICE`](NOTICE) for full attribution.

## Release notes

See [CHANGELOG](CHANGELOG.md) for a detailed history.

## License

[MIT](LICENSE)
