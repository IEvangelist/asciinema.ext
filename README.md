# GitHub Artifacts Explorer & Asciinema Player

[![Version](https://badgen.net/vs-marketplace/v/davidpine-dev.asciinema?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=davidpine-dev.asciinema)
[![Installs](https://badgen.net/vs-marketplace/i/davidpine-dev.asciinema)](https://marketplace.visualstudio.com/items?itemName=davidpine-dev.asciinema)
[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](LICENSE)

> **View your CI artifacts and asciinema recordings without leaving VS Code.** Paste a PR or workflow-run URL → pick an artifact → the right viewer opens. HTML test reports stream from the cached zip into the Simple Browser. `.cast` recordings play inline. Everything else lands in a file browser.

<p align="center">
  <img src="media/demo-explorer.gif" alt="GitHub Artifacts: Explorer — paste a URL, pick an artifact, open the HTML preview in the Simple Browser." width="900" />
  <br />
  <sub><sup><em>Demo: <code>GitHub Artifacts: Explorer</code> → paste a PR URL → pick an artifact → preview the Playwright HTML report in VS Code.</em></sup></sub>
  <br />
  <sub><sup><em>Higher-quality clips: <a href="media/demo-explorer.mp4">MP4 (1.3 MB)</a> · <a href="media/demo-explorer.webm">WebM (2.8 MB)</a> (download to play).</em></sup></sub>
</p>

<!--
  GitHub README markdown and the VS Code Marketplace both strip <video> tags, so
  the GIF above is the canonical inline preview. To get inline video playback on
  github.com/IEvangelist/asciinema.ext, drag-and-drop media/demo-explorer.mp4
  into the README editor on github.com — GitHub will rewrite it to a
  user-attachments CDN URL that DOES render inline. Then replace the GIF block
  with the resulting <video> tag.
-->

> ℹ️ Independent, third-party extension. Built on top of [asciinema](https://asciinema.org) — see [Credits](#credits--acknowledgements).

---

## 🚀 Install

**Pick whichever way is fastest for you.** Reload required after install.

| | |
| --- | --- |
| **Command line** | `code --install-extension davidpine-dev.asciinema` |
| **Inside VS Code** | `Ctrl+Shift+X` → search **"GitHub Artifacts"** → click **Install** |
| **Direct link** | [Open on the VS Code Marketplace ↗](https://marketplace.visualstudio.com/items?itemName=davidpine-dev.asciinema) |
| **From a .vsix** | `code --install-extension ./asciinema-<version>.vsix` |

That's it — no other dependencies. VS Code **1.109.0 or later**. Works on Windows, macOS, Linux.

---

## ✨ Quick start

Three things you can do, in increasing scope. Pick the one that matches what you're here for.

### 1️⃣ Play an asciinema `.cast` file → just open it

Double-click any `*.cast` file. The asciinema player takes over the editor tab — no browser, no export. Click the ⚙ in the bottom-right info bar to tweak playback for this cast or change global defaults.

```
src/recordings/onboarding.cast       ← just open it. Done.
```

> Need a sample? `samples/demo.cast` ships with the extension.

### 2️⃣ Open artifacts from a GitHub PR

1. `Ctrl+Shift+P` → run **`GitHub Artifacts: Explorer`**
2. Paste a PR URL: `https://github.com/owner/repo/pull/123`
3. Sign in with GitHub the first time (one-time, `repo` scope — VS Code's built-in auth)
4. Pick an artifact from the list. The extension dispatches based on content:

| Artifact contents | Opens as |
| --- | --- |
| Shallowest `index.html` | **HTML preview** — streamed from the cached zip into VS Code's Simple Browser or your default browser |
| `.cast` files | **Asciinema player** picker (with cast duration parsed from the header) |
| Anything else | **File browser** sub-picker (open in new window / add to workspace / show in OS file manager) |

### 3️⃣ Open artifacts from a workflow run (no PR required)

Same dispatcher, different entry point — for repos that don't use pull requests or when you want to inspect a specific run.

1. `Ctrl+Shift+P` → **`GitHub Artifacts: Open from CI Run`**
2. Paste a workflow-run URL: `https://github.com/owner/repo/actions/runs/123456`
3. Same picker, same flow. Recents are unified across both commands.

> 💡 **Recents survive restarts.** Successful opens are saved with codicons, relative timestamps, and per-item buttons (open PR · open run · forget). Capped at 25. Orphan zips/dirs cleaned at activation.

---

## 🧭 What's happening under the hood

Two related capabilities under one roof — pick the section that matches what you're doing.

### 🎬 Asciinema player (local files)

Open any `.cast` file and it plays — right inside an editor tab.

- **Settings cog (⚙)** in the player info bar exposes every [asciinema player option](https://docs.asciinema.org/manual/player/options/): `autoPlay`, `speed`, `idleTimeLimit`, `theme`, `fit`, `loop`, `controls`, `terminalFontFamily`, etc.
- **Three-tier resolution.** Per-cast overrides → global VS Code settings → baked-in defaults. Each control shows which layer it's resolving from, with a quick "↺" reset.
- **Live reload.** Change a global default in `settings.json` and every open `.cast` viewer updates without reloading the file.
- **One-click promote.** Edit settings for *this* cast, then **"Save current overrides as global defaults"** pushes them into `asciinema.player.*`.
- **Smart row sizing.** Sparse recordings (terminal never fills) auto-fit to actual height — until you explicitly choose a `fit` mode in the cog.
- **Toggle to raw NDJSON** via **Open as Text** in the editor title bar.

### 🚀 GitHub Artifacts Explorer (remote)

| Behavior | How it works |
| --- | --- |
| **HTML previews stream straight from the zip** | Downloaded artifacts park as `globalStorageUri/remote-artifacts/{id}.zip`. Cast / browse picks extract on demand; HTML previews skip extraction entirely and serve each request by inflating one entry through JSZip. Result: O(1) once the download finishes — no waiting on every entry to land on disk. |
| **Cancellable downloads & extractions** | Both progress notifications expose a cancel control. Cancelling a download aborts the HTTP body read; cancelling an extraction leaves partial state behind so a future retry resumes where you stopped (no re-decompression). |
| **Stop previews from anywhere** | While a preview server is running you get a right-side **`$(debug-stop) HTML preview`** status bar item — click it, run **`GitHub Artifacts: Stop HTML preview`**, or press `Ctrl+C` inside the preview's terminal. Multiple concurrent previews land in a "Stop all / pick one" picker. |
| **Recents that actually work** | Successful opens are saved to `globalState`, capped at 25, with codicons, relative timestamps, run conclusion icons, and per-item buttons (open PR · open run · forget). Survives restarts; orphan zips and dirs cleaned at activation. |
| **Live download & extract progress** | Real percentages (`12.4 MB of 87.0 MB · 14%`, `12,403 / 27,718 files · 184.2 MB · 44%`), ~10 updates/sec, with rotating dev-humor quips on long downloads. |
| **Recoverable cap-breaches** | Hit `maxArtifactEntryCount` / `maxArtifactExtractedMB` / etc. and you get a notification with **Raise & Retry / Custom value / Open Settings**. Retries resume mid-extraction (stat-based skip — no re-decompression). |

---

## 🛠 Troubleshooting

<details>
<summary><b>"I ran the command but nothing happened / I can't find it"</b></summary>

The command is **`GitHub Artifacts: Explorer`** — not "Asciinema" or "Open from PR". All five commands live under the `GitHub Artifacts:` category in the Command Palette (Ctrl+Shift+P). If you don't see them, the extension probably isn't installed yet — run `code --install-extension davidpine-dev.asciinema` and reload.

</details>

<details>
<summary><b>"It's asking me to sign in"</b></summary>

The very first time you point at a private (or even public) GitHub PR/run, VS Code's built-in GitHub auth will prompt for `repo` scope. This is **VS Code's authentication, not ours** — we just call `vscode.authentication.getSession('github', ['repo'])`. It's one-time, browser-based, and survives restarts.

</details>

<details>
<summary><b>"My PR has no artifacts to pick"</b></summary>

The dropdown only shows artifacts produced by the PR's most recent successful workflow run. If your CI didn't upload anything (no `actions/upload-artifact` step, or the run is still in progress), there's nothing to download. Pasting an Actions run URL directly lets you target a specific run.

</details>

<details>
<summary><b>"The download is enormous — can I limit it?"</b></summary>

Yes. See [Configuration → Artifact caps](#artifact-download--extraction-caps). When a cap is exceeded, you'll get a notification with **Raise & Retry / Custom value / Open Settings**.

</details>

<details>
<summary><b>"The HTML preview still uses a port even after I'm done with it"</b></summary>

Three ways to stop it:
1. Click the right-side **`⏹ HTML preview`** status bar item.
2. Run **`GitHub Artifacts: Stop HTML preview`** from the palette.
3. Press `Ctrl+C` inside the preview's terminal (the one that opens with the server banner).

If you've spawned multiple previews, you get a "Stop all / pick one" picker.

</details>

<details>
<summary><b>"My cache is huge"</b></summary>

Run **`GitHub Artifacts: Clear extension cache`** for a QuickPick with live sizes: **Clear all** · **Clear recent (last 7 days)** · **Clear casts only** · **Clear artifacts only** · **Open cache folder**. Each destructive action prompts for confirmation. Orphans are also cleaned automatically at extension activation.

</details>

<details>
<summary><b>"Open as Text"</b> on a <code>.cast</code> file</summary>

Click the `$(file-code)` icon in the editor title bar of a `.cast` viewer (or run **`GitHub Artifacts: Open as Text`**) to see the raw NDJSON. Useful for debugging cast files or copying frame data.

</details>

---

## ⚙️ Reference

### Commands

| Command | Description |
|---|---|
| `GitHub Artifacts: Explorer` | Browse recents or paste a PR / Actions run URL to download a new artifact. |
| `GitHub Artifacts: Open from CI Run` | Skip the PR step entirely; paste a workflow-run URL. |
| `GitHub Artifacts: Stop HTML preview` | Stop one or all running HTML preview servers (also reachable via the status bar item, or `Ctrl+C` inside the preview's terminal). |
| `GitHub Artifacts: Clear extension cache` | QuickPick with live sizes: **Clear all** · **Clear recent (last 7 days)** · **Clear casts only** · **Clear artifacts only** · **Open cache folder**. Each destructive action prompts for confirmation. |
| `GitHub Artifacts: Open as Text` | Open the active `.cast` recording as raw NDJSON in a text editor (also exposed as a button in the editor title bar of the player). |

### Deep links

External pages can open the installed extension by linking to the extension URI handler. Put the GitHub PR or Actions run URL in a percent-encoded `url` query parameter:

```text
vscode://davidpine-dev.asciinema/open?url=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fpull%2F123
vscode://davidpine-dev.asciinema/open?url=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Factions%2Fruns%2F123456
```

Use `vscode-insiders://` for VS Code Insiders. Links generated from inside VS Code should use `vscode.env.asExternalUri(...)` so VS Code can route them back to the current window.

For trusted VS Code surfaces only (for example a webview with command URIs enabled), the commands also accept a prefilled URL argument:

```text
command:asciinema.openFromPullRequest?%5B%7B%22prefilledUrl%22%3A%22https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fpull%2F123%22%7D%5D
```

### Artifact download / extraction caps

| Setting | Default | Description |
|---|---|---|
| `asciinema.maxArtifactSizeMB` | `250` | Maximum compressed artifact size that downloads without prompting. Larger artifacts still work — you just get a confirmation dialog. |
| `asciinema.maxArtifactExtractedMB` | `2048` | Maximum total uncompressed size when **extracting** an artifact to disk (cast / browse). Doesn't apply to the HTML preview path — that streams from the cached zip and never extracts. |
| `asciinema.maxArtifactEntryCount` | `250000` | Maximum number of files allowed inside an artifact zip. Checked at download time against the zip's central directory. |
| `asciinema.maxArtifactEntrySizeMB` | `500` | Maximum uncompressed size of any single file inside an artifact zip. Applied both at extraction time and per request on the HTML preview path. |

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

### Supported formats

- **asciicast v2** — the current standard format produced by `asciinema rec`
- **asciicast v3** — the latest format revision

### Requirements

- VS Code **1.109.0** or later
- No native dependencies — pure TypeScript / Node, bundled via esbuild

---

## 🎥 About the demo recordings

The demo in this README is generated reproducibly from an HTML mockup —
not a real VS Code capture. Three artifacts ship under `media/`:

| File | Size | Best for |
| --- | --- | --- |
| `media/demo-explorer.gif` | ~4.8 MB | Inline rendering on GitHub.com README and the VS Code Marketplace |
| `media/demo-explorer.mp4` | ~1.3 MB | Drag-drop into a GitHub issue/PR/release to get an inline-playable user-attachments URL |
| `media/demo-explorer.webm` | ~2.8 MB | Source-of-truth recording from Playwright; download to play |

> 💡 **Want inline video playback on github.com?** Drag `media/demo-explorer.mp4` into the GitHub web README editor — GitHub rewrites it to a `user-attachments` CDN URL that renders as a real `<video>` element. The GIF in this README is the always-works fallback (marketplace + mirrors strip `<video>` tags).

The full pipeline lives under [`scripts/`](scripts/README.md):

- `scripts/demo/record-video.mjs` — Playwright-driven recorder. Run with `npm run record:demo` to regenerate `media/demo-explorer.webm`. Then transcode to GIF + MP4 with `ffmpeg` (see [scripts/README.md](scripts/README.md#regenerating-the-gif--mp4)).
- `scripts/record-demo.ps1` — alternative Windows-only script that drives a real VS Code instance via `ffmpeg gdigrab` + SendKeys. Useful for marketing captures or verifying the mockup matches reality.

See [scripts/README.md](scripts/README.md) for the full setup.

---

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
