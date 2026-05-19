// scripts/demo/record-video.mjs
//
// Drives scripts/demo/mockup.html through the full GitHub Artifacts: Explorer
// workflow and records it as media/demo-explorer.webm via Playwright's built-in
// context.recordVideo.
//
// Usage:
//   npm run record:demo
//
// Requirements:
//   - playwright (devDependency)
//   - Chromium browser via `npx playwright install chromium` (one-time)

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, rm, rename, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const MEDIA_DIR = join(REPO_ROOT, 'media');
const TMP_DIR = join(__dirname, '.recording-tmp');
const OUTPUT = join(MEDIA_DIR, 'demo-explorer.webm');

const VIEWPORT = { width: 1280, height: 800 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function startStaticServer(root) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let path = decodeURIComponent((req.url || '/').split('?')[0]);
      if (path === '/') path = '/mockup.html';
      const full = join(root, path);
      if (!full.startsWith(root)) { res.writeHead(403).end(); return; }
      try {
        const body = await readFile(full);
        res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/mockup.html`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Inject helpers into the page once, so we can drive overlays and state transitions
// from short page.evaluate() calls without re-uploading code each time.
async function installHelpers(page) {
  await page.addStyleTag({
    content: `
      .__demo-chapter {
        position: fixed; inset: 0; z-index: 9999;
        display: flex; align-items: center; justify-content: center;
        background: rgba(15, 15, 18, 0.62);
        backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
        animation: __demo-chapter-fade 240ms ease-out;
        font-family: "Segoe UI", system-ui, sans-serif; color: #fff;
        pointer-events: none;
      }
      .__demo-chapter .card {
        max-width: 720px; padding: 24px 32px; text-align: center;
        background: linear-gradient(180deg, rgba(40,40,46,0.96) 0%, rgba(28,28,32,0.96) 100%);
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 16px 60px rgba(0,0,0,0.55);
      }
      .__demo-chapter .eyebrow {
        font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase;
        color: #6cb6ff; font-weight: 600; margin-bottom: 6px;
      }
      .__demo-chapter h2 {
        margin: 0 0 8px; font-size: 26px; font-weight: 600;
        letter-spacing: -0.2px;
      }
      .__demo-chapter p {
        margin: 0; color: #c7c7cc; font-size: 14px; line-height: 1.5;
      }
      @keyframes __demo-chapter-fade {
        from { opacity: 0; transform: scale(0.98); }
        to   { opacity: 1; transform: scale(1); }
      }
      .__demo-overlay {
        position: fixed; z-index: 9998; pointer-events: none;
        font-family: "Segoe UI", system-ui, sans-serif;
      }
      .__demo-kbd-hint {
        top: 60px; right: 24px;
        background: rgba(20,20,24,0.92); color: #fff;
        padding: 10px 14px; border-radius: 8px; font-size: 13px;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 8px 22px rgba(0,0,0,0.45);
      }
      .__demo-kbd-hint kbd {
        background: #3c3c3c; color: #fff;
        padding: 2px 7px; border-radius: 4px;
        margin: 0 3px;
        font-family: "Cascadia Code", Consolas, monospace; font-size: 12px;
        border-bottom: 2px solid #2a2a2a;
      }
      .__demo-callout {
        background: rgba(28,28,32,0.96); color: #fff;
        padding: 12px 14px; border-radius: 8px;
        font-size: 13px; line-height: 1.45; max-width: 320px;
        border: 1px solid rgba(255,255,255,0.1);
        box-shadow: 0 12px 36px rgba(0,0,0,0.6);
      }
      .__demo-callout .title { font-weight: 600; color: #9cdcfe; margin-bottom: 4px; }
      .__demo-callout .body { color: #d0d0d6; }
      .__demo-callout kbd {
        background: #3c3c3c; padding: 1px 5px; border-radius: 3px;
        font-family: "Cascadia Code", Consolas, monospace; font-size: 11px;
      }
    `
  });

  await page.evaluate(() => {
    window.__demo = {
      setState(state) { document.body.dataset.state = state; },
      showChapter({ eyebrow = 'Demo', title, body }) {
        const card = document.createElement('div');
        card.className = '__demo-chapter';
        card.innerHTML = `
          <div class="card">
            <div class="eyebrow">${eyebrow}</div>
            <h2>${title}</h2>
            ${body ? `<p>${body}</p>` : ''}
          </div>`;
        document.body.appendChild(card);
        return card;
      },
      hideChapter(card) {
        if (!card) return;
        card.style.transition = 'opacity 200ms ease-out';
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 220);
      },
      showOverlay(className, html) {
        const el = document.createElement('div');
        el.className = `__demo-overlay ${className}`;
        el.innerHTML = html;
        document.body.appendChild(el);
        return el;
      },
      hideOverlay(el) {
        if (!el) return;
        el.style.transition = 'opacity 180ms ease-out';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 200);
      },
      switchToSimpleBrowser() {
        document.querySelector('.welcome-tab')?.classList.remove('active');
        const sbTab = document.querySelector('.simple-browser-tab');
        if (sbTab) { sbTab.style.display = ''; sbTab.classList.add('active'); }
        document.querySelector('.welcome-pane')?.classList.remove('active');
        document.querySelector('.simple-browser-pane')?.classList.add('active');
      },
      setDlMessage(msg, barPct) {
        const m = document.getElementById('dl-message');
        if (m) m.textContent = msg;
        const b = document.getElementById('dl-bar');
        if (b) b.style.width = `${barPct}%`;
      }
    };
  });
}

async function chapter(page, { eyebrow, title, body, hold = 1800 }) {
  const handle = await page.evaluateHandle(({ e, t, b }) => window.__demo.showChapter({ eyebrow: e, title: t, body: b }), { e: eyebrow, t: title, b: body });
  await page.waitForTimeout(hold);
  await page.evaluate((h) => window.__demo.hideChapter(h), handle);
  await page.waitForTimeout(220);
}

async function typeInto(page, selector, text, { delay = 55 } = {}) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = '';
  }, selector);
  for (const ch of text) {
    await page.evaluate(([sel, c]) => {
      const el = document.querySelector(sel);
      if (el) el.textContent = (el.textContent || '') + c;
    }, [selector, ch]);
    await page.waitForTimeout(delay);
  }
}

async function showOverlay(page, className, html) {
  return page.evaluateHandle(({ c, h }) => window.__demo.showOverlay(c, h), { c: className, h: html });
}

async function hideOverlay(page, handle) {
  await page.evaluate((h) => window.__demo.hideOverlay(h), handle);
}

async function findRecordedFile(dir) {
  // Playwright writes to <dir>/<uuid>.webm; pick the newest .webm
  const entries = await readdir(dir);
  const webms = entries.filter((e) => e.endsWith('.webm'));
  if (!webms.length) return null;
  const stats = await Promise.all(webms.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })));
  stats.sort((a, b) => b.t - a.t);
  return join(dir, stats[0].n);
}

(async () => {
  await mkdir(MEDIA_DIR, { recursive: true });
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });

  const server = await startStaticServer(__dirname);
  console.log(`[record] static server: ${server.url}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: TMP_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.waitForLoadState('networkidle');
  await installHelpers(page);

  // ---- Scene 1: Title card ----
  await chapter(page, {
    eyebrow: 'GitHub Artifacts Explorer & Asciinema Player',
    title: 'From PR or CI run → cached artifact → preview',
    body: 'A 30-second tour of the <b>GitHub Artifacts: Explorer</b> command.',
    hold: 2400,
  });

  // ---- Scene 2: Ctrl+Shift+P hint ----
  const kbHint = await showOverlay(page, '__demo-kbd-hint', `
    <span style="opacity:0.75">Press</span>
    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>
    <span style="opacity:0.65">to open the command palette</span>
  `);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__demo.setState('palette-open'));
  await page.waitForTimeout(500);
  await typeInto(page, '#palette-input', 'GitHub Artifacts: Explorer');
  await page.waitForTimeout(900);
  await hideOverlay(page, kbHint);

  // ---- Scene 3: Paste a URL ----
  await chapter(page, {
    eyebrow: 'Step 1 of 3',
    title: 'Paste a PR or Actions run URL',
    body: 'Same picker handles both pull-request URLs and workflow-run URLs.',
    hold: 1900,
  });
  await page.evaluate(() => window.__demo.setState('qp-url'));
  await page.waitForTimeout(500);
  await typeInto(page, '#qp-url-input', 'https://github.com/owner/repo/pull/123', { delay: 32 });
  await page.waitForTimeout(750);

  // ---- Scene 4: Pick an artifact ----
  await chapter(page, {
    eyebrow: 'Step 2 of 3',
    title: 'Pick an artifact — the dispatcher chooses the viewer',
    body: 'HTML sites stream from the cached zip · .cast files open in the player · everything else lands in the file browser.',
    hold: 2200,
  });
  await page.evaluate(() => window.__demo.setState('qp-artifacts'));
  await page.waitForTimeout(1500);

  // ---- Scene 5: Download progress ----
  await page.evaluate(() => window.__demo.setState('downloading'));
  await page.waitForTimeout(300);
  const totalMb = 87.0;
  const steps = 36;
  const stepMs = 130;
  const quips = [
    '☕ Time for a coffee.',
    '🥖 You could\'ve baked bread by now.',
    '🐢 Almost there — patience.',
    '🚀 Streaming fast.',
  ];
  for (let i = 1; i <= steps; i++) {
    const pct = Math.round((i / steps) * 100);
    const done = (i / steps) * totalMb;
    const elapsed = Math.round((i / steps) * 6);
    const eta = Math.max(0, 6 - elapsed);
    const speed = 11 + Math.sin(i / 3) * 1.6;
    const quip = i > steps * 0.55 ? quips[Math.min(quips.length - 1, Math.floor(i / 10))] : '';
    const msg = `📥 ${done.toFixed(1)} MB of ${totalMb.toFixed(1)} MB · 📊 ${pct}% · ⚡ ${speed.toFixed(1)} MB/s · ⏱ ${elapsed}s · ⏳ ~${eta}s${quip ? ' · ' + quip : ''}`;
    await page.evaluate(({ msg, pct }) => window.__demo.setDlMessage(msg, pct), { msg, pct });
    await page.waitForTimeout(stepMs);
  }

  // ---- Scene 6: Extract + Open with ----
  await page.evaluate(() => window.__demo.setState('extracting'));
  await page.waitForTimeout(800);
  await chapter(page, {
    eyebrow: 'Step 3 of 3',
    title: 'Choose how to open the HTML preview',
    body: 'VS Code Simple Browser embeds it · default browser opens the same URL externally.',
    hold: 1900,
  });
  await page.evaluate(() => window.__demo.setState('qp-openwith'));
  await page.waitForTimeout(1200);

  // ---- Scene 7: Simple Browser opens with the Playwright report ----
  await page.evaluate(() => window.__demo.switchToSimpleBrowser());
  await page.evaluate(() => window.__demo.setState('simple-browser'));
  await page.waitForTimeout(1700);

  const callout = await showOverlay(page, '', `
    <div class="__demo-callout" style="position:fixed;left:760px;bottom:38px;">
      <div class="title">⏹ Stop the HTML preview</div>
      <div class="body">Click the <b style="color:#fff">HTML preview</b> item in the status bar, or press <kbd>Ctrl</kbd>+<kbd>C</kbd> inside the preview's terminal.</div>
    </div>
  `);
  await page.waitForTimeout(2600);
  await hideOverlay(page, callout);

  // ---- Outro ----
  await chapter(page, {
    eyebrow: 'Try it yourself',
    title: 'code --install-extension davidpine-dev.asciinema',
    body: 'Then run <b>GitHub Artifacts: Explorer</b> from the command palette.',
    hold: 2800,
  });

  await page.waitForTimeout(400);
  await context.close();   // <-- this finalizes the video
  await browser.close();
  await server.close();

  // Rename the autogenerated <uuid>.webm to media/demo-explorer.webm
  const recorded = await findRecordedFile(TMP_DIR);
  if (!recorded) throw new Error(`No .webm produced under ${TMP_DIR}`);
  await rm(OUTPUT, { force: true });
  await rename(recorded, OUTPUT);
  await rm(TMP_DIR, { recursive: true, force: true });

  const size = (await stat(OUTPUT)).size;
  console.log(`[record] ✅ ${OUTPUT}  (${(size / 1024).toFixed(1)} KB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
