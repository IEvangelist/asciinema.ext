# GitHub Artifacts Explorer & Asciinema Player

[![Version](https://badgen.net/vs-marketplace/v/davidpine-dev.asciinema?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=davidpine-dev.asciinema)
[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](LICENSE)

> **Browse GitHub PR and CI run artifacts straight from VS Code.** Point at any pull request *or* workflow run, grab its CI artifacts, and the extension figures out the right way to open them — `.cast` recordings get the asciinema player, HTML sites get served from an embedded HTTP server and opened in your choice of VS Code's Simple Browser or your default browser, and everything else opens in a folder browser.

<p align="center">
  <img src="media/demo.gif" alt="Playing an asciinema .cast recording inside a VS Code editor tab" />
</p>

> ℹ️ Independent, third-party extension. Built on top of [asciinema](https://asciinema.org) — see [Credits](#credits--acknowledgements).

## Install

```
code --install-extension davidpine-dev.asciinema
```

…or search **Artifacts Explorer** / **Asciinema** in the Extensions view (`Ctrl+Shift+X`).

## What's inside

### 🚀 GitHub Artifacts Explorer

Run **`GitHub: Artifacts Explorer`** from the command palette, paste a PR URL *or* an Actions run URL, and the extension downloads its workflow artifacts and dispatches each one to the right viewer based on content. Got a repo that doesn't use PRs? Run **`GitHub: Open Artifacts from CI Run`** and paste a `https://github.com/owner/repo/actions/runs/{id}` URL instead — same dispatch pipeline, no PR required.

| Artifact contains… | Opens with |
|---|---|
| `.cast` files | Asciinema player picker (with cast duration parsed from the header) |
| Any shallowest `index.html` | Embedded Node HTTP server (port 0, traversal-guarded, mime-mapped) — pick **VS Code Simple Browser** or **default browser** |
| Anything else | "Browse extracted files…" sub-picker (open in new window / add to workspace / show in OS file manager) |

**Recents that actually work.** Successful opens are saved to `globalState`, capped at 25, with codicons, relative timestamps, run conclusion icons, and per-item buttons (open PR · open run · forget). Survives restarts; orphan dirs are cleaned at activation time.

**Live download & extract progress.** Real percentages (`12.4 MB of 87.0 MB (14%)`, `12,403 / 27,718 files · 184.2 MB (44%)`), ~10 updates/sec.

**Cheeky quips** while you wait for big downloads. 40+ rotating dev-humor messages tied to elapsed time.

**Recoverable cap-breaches.** Hit `maxArtifactEntryCount` / `maxArtifactExtractedMB` / etc. and you get a notification with **Raise & Retry / Custom value / Open Settings**. Retries resume mid-extraction (stat-based skip — no re-decompression).

### 🎬 Asciinema player

Open any `.cast` file and it plays — right inside an editor tab, no browser, no export. Includes:

- **Settings cog (⚙)** in the player info bar exposing every [asciinema player option](https://docs.asciinema.org/manual/player/options/) — `autoPlay`, `speed`, `idleTimeLimit`, `theme`, `fit`, `loop`, `controls`, `terminalFontFamily`, etc.
- **Three-tier resolution.** Per-cast overrides → global VS Code settings → baked-in defaults. Each control shows which layer it's resolving from with a quick "↺" reset.
- **Live reload.** Change a global default in `settings.json` and every open `.cast` viewer updates without reloading the file.
- **One-click promote.** Edit settings for *this* cast, then "Save current overrides as global defaults" pushes them into `asciinema.player.*`.
- **Smart row sizing.** Sparse recordings (terminal never fills) auto-fit to actual height — until you explicitly choose a `fit` mode in the cog.
- Toggle to raw NDJSON via **Open as Text** in the editor title bar.

## Usage

### Local `.cast` files

Just open them. The asciinema player takes over the tab. Click the ⚙ Settings button in the bottom-right info bar to tweak playback for this cast or change global defaults.

### From a GitHub pull request

1. `Ctrl+Shift+P` → **`GitHub: Artifacts Explorer`**
2. Pick a recent artifact, or paste a PR URL to download a new one (e.g., `https://github.com/owner/repo/pull/123`).
3. Sign in with VS Code's built-in GitHub auth (one-time, `repo` scope).
4. Let the extension dispatch on content type — it'll auto-pick the best way to open the artifact.

You can also paste an Actions run URL into the same prompt — it works the same way.

### From a GitHub Actions CI run

For repos that don't use pull requests (or when you want to inspect a specific run regardless of PR):

1. `Ctrl+Shift+P` → **`GitHub: Open Artifacts from CI Run`**
2. Paste a workflow-run URL (e.g., `https://github.com/owner/repo/actions/runs/12345678`).
3. Same artifact picker, same dispatch. Recents are unified across both commands.

Works with public and private repos. Recents persist across VS Code restarts; their files are kept on disk for instant re-open and cleaned up when forgotten.

## Configuration

### Artifact download / extraction caps

| Setting | Default | Description |
|---|---|---|
| `asciinema.maxArtifactSizeMB` | `250` | Maximum compressed artifact size that downloads without prompting. Larger artifacts still work — you just get a confirmation dialog. |
| `asciinema.maxArtifactExtractedMB` | `2048` | Maximum total uncompressed size of artifact contents written to disk during extraction. |
| `asciinema.maxArtifactEntryCount` | `250000` | Maximum number of files allowed inside an artifact zip. |
| `asciinema.maxArtifactEntrySizeMB` | `500` | Maximum uncompressed size of any single file inside an artifact zip. |

If extraction trips a cap, you'll get a notification with **Raise & Retry / Custom value / Open Settings** — never a dead-end. Retries resume from where they left off.

### Asciinema player options (global defaults)

All of these can also be edited per-cast from the ⚙ Settings cog in the player.

| Setting | Default | Description |
|---|---|---|
| `asciinema.player.autoPlay` | `true` | Start playback automatically when a `.cast` file opens. |
| `asciinema.player.preload` | `false` | Preload the recording at player init. |
| `asciinema.player.loop` | `false` | `true` for infinite loop, a number for N times, `false` for none. |
| `asciinema.player.startAt` | `0` | Number of seconds, or `"mm:ss"` / `"hh:mm:ss"`. |
| `asciinema.player.speed` | `1` | Playback speed (`2` means 2x). |
| `asciinema.player.idleTimeLimit` | `null` | Compress idle time longer than N seconds. `null` uses the value baked into the cast file. |
| `asciinema.player.pauseOnMarkers` | `false` | Pause at every marker. |
| `asciinema.player.theme` | `"auto"` | `auto` / `asciinema` / `dracula` / `monokai` / `nord` / `solarized-dark` / `solarized-light` / `tango`. |
| `asciinema.player.fit` | `"width"` | `width` / `height` / `both` / `none`. |
| `asciinema.player.controls` | `"auto"` | `auto` / `always` / `never`. |
| `asciinema.player.terminalFontSize` | `"small"` | `small` / `medium` / `big`, or any CSS font-size like `15px`. Only effective with `fit: "none"`. |
| `asciinema.player.terminalFontFamily` | _Cascadia Code stack_ | Any CSS `font-family` value. |
| `asciinema.player.terminalLineHeight` | `1.33333333` | Relative to font size. |
| `asciinema.player.poster` | `""` | `npt:1:23` for a frame at 1m23s, or `data:text/plain,...` for arbitrary text. |

See the [asciinema player options docs](https://docs.asciinema.org/manual/player/options/) for full semantics.

## Supported formats

- **asciicast v2** — the current standard format produced by `asciinema rec`
- **asciicast v3** — the latest format revision

## Requirements

VS Code 1.109.0 or later.

## Credits & Acknowledgements

This extension is a playback shell around **[asciinema](https://asciinema.org)** — the excellent terminal session recorder created by **[Marcin Kulik](https://hachyderm.io/@ku1ik)** and the asciinema community. All of the heavy lifting on the `.cast` file format, recording tools, and playback engine comes from their work; this extension just wires it into VS Code and adds a GitHub artifacts pipeline on top.

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
