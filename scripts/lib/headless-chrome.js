// Zero-dependency headless Chrome driver (Chrome DevTools Protocol over Node's built-in WebSocket).
// Used by scripts/render.js, scripts/inspect.js and the e2e tests so the studio's real
// browser pipeline (Canvas 2D + WebCodecs) can run unattended from the command line.
// No npm packages, no downloads: it drives a Chromium-family browser already on the machine.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

export function findBrowserPath() {
  const found = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      'No Chromium-family browser found. Install Google Chrome or set CHROME_PATH to a browser binary.'
    );
  }
  return found;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Race a promise against a timeout without leaving a live timer behind (which would keep Node alive). */
function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start the studio's own static/API server (server.js) on a free port.
 * Returns { url, port, stop }.
 */
export async function startStudioServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server.js')], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Studio server exited early (code ${child.exitCode}): ${stderr.trim()}`);
    }
    try {
      const res = await fetch(`${url}/api/media`);
      if (res.ok) break;
    } catch (_) {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('Studio server did not start within 10s');
    }
    await sleep(80);
  }

  return {
    url,
    port,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    })
  };
}

/** Minimal CDP client: request/response correlation + per-session event listeners. */
class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Browser connection closed'));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
}

/**
 * Launch a headless browser with a throwaway profile.
 * Returns { newPage(url), close() }. Always call close() (use try/finally).
 */
export async function launchBrowser({ headless = true, extraArgs = [] } = {}) {
  const browserPath = findBrowserPath();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-chrome-'));
  const args = [
    headless ? '--headless=new' : '',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--mute-audio',
    '--hide-scrollbars',
    // Timers and rendering must not be throttled while the tab is not focused.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,900',
    ...extraArgs,
    'about:blank'
  ].filter(Boolean);

  const child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });

  const cleanup = () => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  };

  // Chrome writes the chosen debugging port to DevToolsActivePort in the profile dir.
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  let wsUrl = null;
  while (!wsUrl) {
    if (child.exitCode !== null) {
      cleanup();
      throw new Error(`Browser exited early (code ${child.exitCode}): ${stderr.trim().slice(-600)}`);
    }
    if (fs.existsSync(portFile)) {
      const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && wsPath) wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
    }
    if (!wsUrl) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        cleanup();
        throw new Error('Browser did not expose a DevTools port within 20s');
      }
      await sleep(60);
    }
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Could not connect to browser DevTools')), { once: true });
  });
  const cdp = new CdpConnection(ws);

  async function newPage(url, { onConsole = null } = {}) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const pageErrors = [];

    const listener = (msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled' && onConsole) {
        const text = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
          .join(' ');
        onConsole(msg.params.type, text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageErrors.push(d?.exception?.description || d?.text || 'Unknown page exception');
      }
    };
    cdp.listeners.add(listener);

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const loaded = new Promise((resolve) => {
      const onLoad = (msg) => {
        if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') {
          cdp.listeners.delete(onLoad);
          resolve();
        }
      };
      cdp.listeners.add(onLoad);
    });
    await cdp.send('Page.navigate', { url }, sessionId);
    await withTimeout(loaded, 30_000, `Timed out loading ${url}`);

    /**
     * Evaluate an expression in the page; promises are awaited and the
     * JSON-serialisable result is returned by value.
     */
    async function evaluate(expression, { timeoutMs = 600_000 } = {}) {
      const run = cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      }, sessionId);
      const result = await withTimeout(run, timeoutMs, `Page evaluation timed out after ${timeoutMs}ms`);
      if (result.exceptionDetails) {
        const d = result.exceptionDetails;
        throw new Error(`Page error: ${d.exception?.description || d.text}`);
      }
      return result.result?.value;
    }

    return {
      evaluate,
      pageErrors,
      close: async () => {
        cdp.listeners.delete(listener);
        try { await cdp.send('Target.closeTarget', { targetId }); } catch (_) { /* already gone */ }
      }
    };
  }

  async function close() {
    try { await cdp.send('Browser.close'); } catch (_) { /* already closing */ }
    try { ws.close(); } catch (_) { /* ignore */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    cleanup();
  }

  return { newPage, close, browserPath };
}

/** Convenience: server + browser + one page, torn down together. */
export async function withStudioPage(pagePath, fn, { onConsole = null } = {}) {
  const server = await startStudioServer();
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage(`${server.url}${pagePath}`, { onConsole });
    return await fn(page, server);
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
}
