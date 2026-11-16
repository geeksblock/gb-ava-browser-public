import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { provenRpc } from "../../shared/src/rpc-client.js";

/** port -> token, so a health check can fetch the authenticated detail (ADR 0005). */
const tokensByPort = new Map<number, string>();

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const extensionDir = join(repoRoot, "extension", "dist");

/**
 * Put another application in front of the browser, so a read is measured with
 * Chrome occluded rather than merely behind another tab. macOS only: on Linux CI
 * there is no window server to occlude, and the tab-not-active case is what the
 * rest of the suite proves.
 */
export async function occludeBrowser(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve) => {
    execFile("osascript", ["-e", 'tell application "Finder" to activate'], () => resolve());
  });
  // Give the window server a moment to actually change the frontmost app.
  await new Promise((resolve) => setTimeout(resolve, 700));
  return true;
}

export interface BridgeHandle {
  port: number;
  token: string;
  configDir: string;
  /** The only folder page.upload may attach from (ADR 0005); tests write files here. */
  uploadDir: string;
  /** Everything the bridge wrote to stderr (structured JSON logs). */
  logs(): string;
  stop(): Promise<void>;
}

/**
 * Start the real CLI, exactly as an operator would, on an ephemeral port with an
 * isolated config directory. The test never imports bridge internals for the
 * assertions it cares about — it talks HTTP, like Ava will.
 */
export async function startBridge(
  options: { keepToken?: string; port?: number; configDir?: string } = {},
): Promise<BridgeHandle> {
  // Reusing a config directory reuses its token, which is what a restart means:
  // the extension keeps the token it was paired with.
  const configDir = options.configDir ?? mkdtempSync(join(tmpdir(), "gb-ava-it-bridge-"));
  const requestedPort = options.port === undefined ? "0" : String(options.port);
  const uploadDir = mkdtempSync(join(tmpdir(), "gb-ava-it-uploads-"));
  const child: ChildProcess = spawn(process.execPath, ["bridge/dist/cli.js", "serve", "--port", requestedPort], {
    cwd: repoRoot,
    env: { ...process.env, AVA_BRIDGE_CONFIG_DIR: configDir, AVA_BRIDGE_UPLOAD_DIR: uploadDir, AVA_BRIDGE_LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not report a port in time:\n${stdout}\n${stderr}`)), 20_000);
    child.stdout?.on("data", () => {
      const match = /"event":"listening","host":"127\.0\.0\.1","port":(\d+)/.exec(stdout);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number.parseInt(match[1], 10));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited early (${code}):\n${stdout}\n${stderr}`));
    });
  });

  const token = options.keepToken ?? readFileSync(join(configDir, "token"), "utf8").trim();
  tokensByPort.set(port, readFileSync(join(configDir, "token"), "utf8").trim());

  return {
    port,
    token,
    configDir,
    uploadDir,
    logs: () => stderr,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export interface ExtensionHandle {
  context: BrowserContext;
  extensionId: string;
  optionsPage(): Promise<Page>;
  close(): Promise<void>;
}

export async function launchExtension(): Promise<ExtensionHandle> {
  const userDataDir = mkdtempSync(join(tmpdir(), "gb-ava-it-profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    // Save downloads the way Chrome would, instead of into a Playwright artifact
    // directory: `page.download` reports Chrome's own filename.
    acceptDownloads: false,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-update",
    ],
  });

  let worker = context.serviceWorkers()[0];
  if (worker === undefined) {
    worker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  }
  const extensionId = new URL(worker.url()).host;

  return {
    context,
    extensionId,
    optionsPage: async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      await page.waitForSelector("#settings-form");
      return page;
    },
    close: async () => {
      await context.close();
    },
  };
}

export interface FixtureSite {
  /** Base origin, e.g. http://127.0.0.1:54321 */
  origin: string;
  /** Absolute URL for a fixture path such as "/login". */
  url(path: string): string;
  close(): Promise<void>;
}

/**
 * A local site the extension can actually navigate to.
 *
 * `data:` URLs are convenient but Chrome refuses a background navigation to one
 * ("not allowed to navigate top frame to data URL"), and file:// needs different
 * permissions, so the suites drive a real origin on loopback. No network access
 * is involved and the pages are deterministic.
 */
export async function startFixtureSite(): Promise<FixtureSite> {
  const signin = `<!doctype html><meta charset=utf-8><title>fixture-signin</title>
<h1>Sign in</h1>
<form id=stage1 onsubmit="event.preventDefault(); document.getElementById('stage1').hidden=true; document.getElementById('stage2').hidden=false; document.getElementById('code').focus();">
  <label for=email>Email</label><input id=email name=email autocomplete=off>
  <button id=next type=submit>Next</button>
</form>
<form id=stage2 hidden onsubmit="event.preventDefault(); location.href='/done';">
  <label for=code>Temporary access pass</label><input id=code name=code autocomplete=off>
  <button id=verify type=submit>Verify</button>
</form>`;
  const form = `<!doctype html><meta charset=utf-8><title>fixture-form</title>
<h1>Form</h1>
<select id=colour><option value=red>Red</option><option value=green>Green</option></select>
<input id=file type=file>
<input id=hiddenFile type=file style="display:none">
<button id=save type=button>Save</button>
<a id=dlink href="/download.txt" download>Download</a>
<button id=alertButton type=button onclick="alert('are you sure')">Delete</button>
<button id=late type=button onclick="setTimeout(() => { const p = document.createElement('p'); p.id = 'late-text'; p.textContent = 'arrived later'; document.body.appendChild(p); }, 600)">Later</button>`;
  // A page that embeds whatever child URL it is given, so a test can put content
  // in a same-origin or a cross-origin (out-of-process) iframe.
  const frameHost = `<!doctype html><meta charset=utf-8><title>fixture-frame-host</title>
<h1 id=heading>frame host</h1>
<iframe id=child title=child></iframe>
<iframe id=child2 title=child2></iframe>
<script>
  const params = new URLSearchParams(location.search);
  document.getElementById('child').src = params.get('src');
  const second = params.get('src2');
  if (second) document.getElementById('child2').src = second; else document.getElementById('child2').remove();
</script>`;
  const clicktest = `<!doctype html><meta charset=utf-8><title>fixture-clicktest</title>
<h1 id=heading>clicktest</h1>
<button id=hit type=button onclick="document.getElementById('result').textContent='clicked'">Hit</button>
<div id=result>idle</div>`;
  const scroller = `<!doctype html><meta charset=utf-8><title>fixture-scroller</title>
<h1 id=heading>scroller</h1>
<div id=inner style="height:120px;overflow:auto;border:1px solid #000"><div style="height:2000px">inner content</div></div>
<div id=tall style="height:4000px">below the fold</div>`;
  // A page with the two shapes the control tests need: a decoy control FIRST (so a bare
  // selector resolves to the wrong element), and real checkboxes so a tick can be
  // verified from the tree.
  const controls = `<!doctype html><meta charset=utf-8><title>fixture-controls</title>
<h1>Controls</h1>
<label>Theme
  <select id=theme><option value=trust-blue>TRUST BLUE</option><option value=aurora>AURORA</option></select>
</label>
<label>Contact
  <select name=contact><option value=a>Alpha</option><option value=b>Beta</option></select>
</label>
<label><input type=checkbox id=all> All tickets</label>
<label><input type=checkbox id=new checked> New tickets</label>
<label><input type=checkbox id=activity> Activity</label>
<label><input type=checkbox id=def> Default</label>
<div id=count></div>
<script>
  document.querySelectorAll('input[type=checkbox]').forEach((c) => {
    c.addEventListener('change', () => {
      document.getElementById('count').textContent =
        Array.from(document.querySelectorAll('input[type=checkbox]')).map((x) => x.checked ? 1 : 0).join('');
    });
  });
</script>`;

  const pages: Record<string, string> = {
    "/alpha": "<title>fixture-alpha</title><h1 id=heading>alpha</h1>",
    "/beta": "<title>fixture-beta</title><h1 id=heading>beta</h1>",
    "/login": "<title>fixture-login</title><input id=email><input id=password type=password><button id=submit>Sign in</button>",
    "/done": "<title>fixture-done</title><h1 id=heading>done</h1><p id=signed-in>signed in</p>",
    "/signin": signin,
    "/form": form,
    "/frame-host": frameHost,
    "/clicktest": clicktest,
    "/scroller": scroller,
    "/controls": controls,
    "/download.txt": "col1,col2\n1,2\n",
  };
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const body = pages[path];
    if (body === undefined) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    if (path.endsWith(".txt")) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(body);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><meta charset=utf-8>${body}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture site failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: (path: string) => `${origin}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Wait until the extension reports no open dialog for a tab. Dismissing a dialog
 * from the test side and asserting on the next command immediately is a race: the
 * worker learns the dialog closed from a CDP event that arrives a tick later.
 */
export async function waitForNoDialog(port: number, token: string, tabId: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = (await bridgeCall(port, token, "health", {}).catch(() => null)) as
      | { result?: { dialogs?: { open?: Array<{ tabId: number }> } } }
      | null;
    const open = reply?.result?.dialogs?.open ?? [];
    if (!open.some((entry) => entry.tabId === tabId)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface HealthBody {
  ok: boolean;
  /** Both sides' build identity; `mismatch` is the stale-extension signal. */
  build: {
    bridge: { id: string; builtAt: string };
    extension: { id: string; builtAt: string | null } | null;
    mismatch: boolean | null;
  };
  bridge: {
    port: number;
    protocolVersion: number;
    tokenFingerprint: string;
    socketsSeen: number;
    tokenConfigured: boolean;
  };
  extension:
    | { connected: false; lastError?: { code: string } }
    | {
        connected: true;
        sessionId: string;
        connectedForMs: number;
        client: { name: string; version: string; resumed?: boolean };
        health: Record<string, unknown> | null;
        healthError?: { code: string };
      };
}

/**
 * `GET /health` carries bridge state only; the extension's own health (audit,
 * dialogs) is behind the token (ADR 0005), so it is fetched with a proof and
 * folded in, giving the tests the same shape as before.
 */
export async function bridgeHealth(port: number): Promise<HealthBody> {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`health returned ${response.status}`);
  const body = (await response.json()) as HealthBody;
  const token = tokensByPort.get(port);
  if (body.extension.connected && token !== undefined) {
    const detail = await provenRpc({
      host: "127.0.0.1",
      port,
      token,
      body: JSON.stringify({ id: `it-health-${Date.now()}`, method: "health" }),
      timeoutMs: 10_000,
    });
    const reply = detail.body as { ok?: boolean; result?: Record<string, unknown>; error?: { code: string } } | null;
    if (reply?.ok === true && reply.result !== undefined) body.extension.health = reply.result;
    else if (reply?.error !== undefined) body.extension.healthError = reply.error;
  }
  return body;
}

export interface RpcReply {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}

export async function bridgeCall(
  port: number,
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<RpcReply> {
  const body: Record<string, unknown> = { id: `it-${Date.now()}-${Math.random().toString(16).slice(2)}`, method };
  if (params !== undefined) body["params"] = params;
  // /rpc needs a fresh proof of the per-install token (ADR 0005); a caller
  // without one gets a 401, never a command, and the token is never sent.
  const result = await provenRpc({ host: "127.0.0.1", port, token, body: JSON.stringify(body), timeoutMs: 20_000 });
  return result.body as RpcReply;
}

/**
 * Turn on the human-owned `page.evaluate` switch and wait for the worker to report
 * it. Clicking the checkbox and calling evaluate immediately races the storage
 * write — which passed on a fast machine and failed in CI.
 */
export async function enableEvaluate(page: Page, port: number, token: string): Promise<void> {
  await page.check("#evaluate-enabled");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const reply = (await bridgeCall(port, token, "settings.get", {}).catch(() => null)) as
      | { result?: { evaluateEnabled?: boolean } }
      | null;
    if (reply?.result?.evaluateEnabled === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("page.evaluate did not become enabled within 5 s");
}

export async function configureViaOptionsPage(page: Page, port: number, token: string): Promise<void> {
  await page.fill("#bridge-url", `ws://127.0.0.1:${port}`);
  await page.fill("#bridge-token", token);
  await page.click("button[type=submit]");
}

/**
 * The first browser launch on a cold CI runner takes far longer than a warm one
 * (profile creation under xvfb), and the extension's own connect happens after
 * that; 30 s was not enough there. This is a wait, not an assertion: nothing is
 * proved by giving up early.
 */
export async function waitForConnected(port: number, timeoutMs = 75_000): Promise<HealthBody> {
  const deadline = Date.now() + timeoutMs;
  let last: HealthBody | null = null;
  while (Date.now() < deadline) {
    try {
      last = await bridgeHealth(port);
      if (last.extension.connected) return last;
    } catch {
      // Bridge may still be binding; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`extension did not connect in ${timeoutMs}ms; last health: ${JSON.stringify(last)}`);
}

export function extensionHealth(health: HealthBody): Record<string, unknown> {
  if (!health.extension.connected) throw new Error("extension is not connected");
  if (health.extension.health === null) throw new Error("extension health was not forwarded");
  return health.extension.health;
}
