#!/usr/bin/env node

/**
 * Capture the plugin README screenshots from a running BB application.
 *
 * This intentionally uses Chrome's DevTools Protocol against the real BB web
 * client. It is not a mockup generator: each capture is gated on live text
 * from the rendered panel so an empty, broken, or missing surface fails.
 *
 * Usage:
 *   BB_CAPTURE_CDP_PORT=9222 \
 *   BB_CAPTURE_PROJECT_ID=proj_... \
 *   BB_CAPTURE_THREAD_ID=thr_... \
 *   node scripts/capture-plugin-screenshots.mjs
 *
 * If no DevTools endpoint is already available, the script starts a temporary
 * headless Chrome profile. BB itself must already be running at BB_SERVER_URL
 * (the CLI exports this automatically inside a BB environment).
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverUrl = (process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886").replace(/\/$/, "");
const cdpPort = Number(process.env.BB_CAPTURE_CDP_PORT ?? "9222");
const projectId = process.env.BB_CAPTURE_PROJECT_ID ?? process.env.BB_PROJECT_ID;
const threadId = process.env.BB_CAPTURE_THREAD_ID;

if (!projectId || !threadId) {
  throw new Error(
    "Set BB_CAPTURE_PROJECT_ID and BB_CAPTURE_THREAD_ID to a seeded BB thread before capturing.\n" +
      "The thread is used for the message-action and context-menu screenshots.",
  );
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  command(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
    }
    if (result.result?.subtype === "error") {
      throw new Error(result.result.description ?? "Runtime evaluation failed");
    }
    return result.result?.value;
  }

  async navigate(path) {
    await this.command("Page.navigate", { url: `${serverUrl}${path}` });
    await sleep(900);
  }

  async waitForText(text, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const bodyText = await this.evaluate("document.body?.innerText ?? \"\"");
      if (bodyText.includes(text)) return;
      await sleep(250);
    }
    const bodyText = await this.evaluate("document.body?.innerText ?? \"\"");
    throw new Error(`Timed out waiting for ${JSON.stringify(text)}.\n${bodyText.slice(-1200)}`);
  }

  async waitForAriaButton(label, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const present = await this.evaluate(`Array.from(document.querySelectorAll("button"))
        .some((candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(label)})`);
      if (present) return;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for button ${JSON.stringify(label)}`);
  }

  async hasText(text, timeoutMs = 2500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const bodyText = await this.evaluate("document.body?.innerText ?? \"\"");
      if (bodyText.includes(text)) return true;
      await sleep(250);
    }
    return false;
  }

  async clickButtonText(label) {
    const clicked = await this.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.innerText.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error("Button not found: ${label}");
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Unable to click ${label}`);
    await sleep(900);
  }

  async drawRectangle() {
    await this.evaluate(`(() => {
      const tool = Array.from(document.querySelectorAll("[aria-label]"))
        .find((candidate) => candidate.getAttribute("aria-label") === "Rectangle");
      if (!tool) throw new Error("Excalidraw Rectangle tool not found");
      tool.click();
      return true;
    })()`);
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 560,
      y: 300,
      buttons: 0,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 560,
      y: 300,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 960,
      y: 550,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 960,
      y: 550,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(1200);
  }

  async clickSidebarButton(label) {
    const clicked = await this.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.innerText.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error("Sidebar button not found: ${label}");
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Unable to click sidebar button ${label}`);
    await sleep(900);
  }

  async clickFirstButtonWithAria(label) {
    const clicked = await this.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(label)});
      if (!button) throw new Error("Button not found: ${label}");
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Unable to click ${label}`);
    await sleep(900);
  }

  async openThreadContextMenu() {
    const point = await this.evaluate(`(() => {
      const anchor = document.querySelector('a[href*="/threads/${threadId}"]');
      if (!anchor) throw new Error("Seed thread row not found in the sidebar");
      const rect = anchor.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await this.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "right",
      clickCount: 1,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "right",
      clickCount: 1,
    });
    await sleep(700);
  }

  async capture(outputPath) {
    const screenshot = await this.command("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  }
}

async function findPageTarget() {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const target = targets.find((candidate) => candidate.type === "page" && !candidate.url.startsWith("chrome://"));
  if (!target?.webSocketDebuggerUrl) throw new Error("No controllable Chrome page target found");
  return target.webSocketDebuggerUrl;
}

async function pluginRpc(pluginId, method, input) {
  const response = await fetch(`${serverUrl}/api/v1/plugins/${pluginId}/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message ?? `Plugin RPC failed: ${pluginId}/${method}`);
  }
  return payload.result;
}

async function ensureChrome() {
  try {
    return { webSocketUrl: await findPageTarget(), process: null };
  } catch {
    const chromePath = process.env.BB_CAPTURE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const profileDir = await mkdtemp(join(tmpdir(), "bb-plugin-capture-"));
    const chromeProcess = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-address=127.0.0.1`,
        `--remote-debugging-port=${cdpPort}`,
        "--window-size=1440,1000",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const started = Date.now();
    while (Date.now() - started < 20000) {
      try {
        return { webSocketUrl: await findPageTarget(), process: chromeProcess };
      } catch {
        await sleep(250);
      }
    }
    chromeProcess.kill();
    throw new Error(`Timed out waiting for Chrome DevTools on port ${cdpPort}`);
  }
}

const threadUrl = `/projects/${projectId}/threads/${threadId}`;

const captures = [
  {
    id: "agent-checklists",
    packageDir: "bb-plugin-agent-checklists",
    setup: async (client) => {
      await client.navigate("/");
      await client.clickSidebarButton("Checklists");
      await client.waitForText("Your Checklists");
      await client.waitForText("Software Development Lifecycle");
    },
  },
  {
    id: "agent-plugins",
    packageDir: "bb-plugin-agent-plugins",
    setup: async (client) => {
      await client.navigate("/");
      await client.clickSidebarButton("Agent Plugins");
      await client.waitForText("Installed");
      await client.waitForText("13 skills");
    },
  },
  {
    id: "cobalt2",
    packageDir: "bb-plugin-cobalt2",
    setup: async (client) => {
      await client.navigate("/settings/appearance");
      await client.waitForText("cobalt2");
      await client.waitForText("Theme");
    },
  },
  {
    id: "comprehension",
    packageDir: "bb-plugin-comprehension",
    setup: async (client) => {
      await client.navigate(threadUrl);
      await client.waitForAriaButton("Explain this");
      await client.clickFirstButtonWithAria("Explain this");
      await client.waitForText("What do you want to make?");
      await client.waitForText("What should it cover?");
    },
  },
  {
    id: "copy-session-id",
    packageDir: "bb-plugin-copy-session-id",
    setup: async (client) => {
      await client.navigate("/");
      await client.openThreadContextMenu();
      await client.waitForText("Copy session ID");
    },
  },
  {
    id: "council",
    packageDir: "bb-plugin-council",
    setup: async (client) => {
      await client.navigate("/plugins/council/council");
      await client.waitForText("Sessions");
      await client.waitForText("Proposal:");
      await client.waitForText("completed");
    },
  },
  {
    id: "ds4",
    packageDir: "bb-plugin-ds4",
    setup: async (client) => {
      await client.navigate("/settings/plugins/ds4");
      await client.waitForText("Automatic startup");
      await client.waitForText("ds4flash.gguf");
      await client.waitForText("MODEL SELECTOR");
      await client.waitForText("ds4/");
    },
  },
  {
    id: "emoji-react",
    packageDir: "bb-plugin-emoji-react",
    setup: async (client) => {
      await client.navigate("/settings/plugins/emoji-react");
      await client.waitForText("Emoji reactions");
      await client.waitForText("👍 Agree");
      await client.waitForText("Quote the highlighted text");
    },
  },
  {
    id: "excalidraw",
    packageDir: "bb-plugin-excalidraw",
    setup: async (client) => {
      await client.navigate("/plugins/excalidraw/drawings");
      await client.waitForText("Drawings");
      if (await client.hasText("Plugin screenshot staging map")) return;

      // Some BB versions keep the Excalidraw gallery unavailable when a
      // persisted preview cannot be rendered. Use the real editor as the
      // fallback surface: create a temporary drawing through the UI, draw a
      // rectangle through Excalidraw's own canvas, capture it, then remove the
      // temporary fixture in cleanup.
      const before = await pluginRpc("excalidraw", "listDrawings", null);
      await client.clickButtonText("New drawing");
      await client.waitForText("Canvas actions");
      await client.drawRectangle();
      const after = await pluginRpc("excalidraw", "listDrawings", null);
      const beforeIds = new Set(before.drawings.map((drawing) => drawing.id));
      const created = after.drawings.find((drawing) => !beforeIds.has(drawing.id));
      return async () => {
        if (created) await pluginRpc("excalidraw", "deleteDrawing", { id: created.id });
      };
    },
  },
  {
    id: "plannotator",
    packageDir: "bb-plugin-plannotator",
    setup: async (client) => {
      await client.navigate("/settings/plugins/plannotator");
      await client.waitForText("Plannotator binary");
      await client.waitForText("bundled");
    },
  },
  {
    id: "prime-agent",
    packageDir: "bb-plugin-prime-agent",
    setup: async (client) => {
      await client.navigate("/settings/providers");
      await client.waitForText("Prime Agent");
      await client.waitForText("Make default");
    },
  },
  {
    id: "traces",
    packageDir: "bb-plugin-traces",
    setup: async (client) => {
      await client.navigate("/plugins/traces/traces");
      await client.waitForText("Index ready");
      await client.waitForText("matching sessions");
    },
  },
  {
    id: "ua-fetch",
    packageDir: "bb-plugin-ua-fetch",
    setup: async (client) => {
      await client.navigate("/settings/plugins/ua-fetch");
      await client.waitForText("Default user agent");
      await client.waitForText("Probe on block");
      await client.waitForText("chrome");
    },
  },
];

const { webSocketUrl, process: chromeProcess } = await ensureChrome();
const client = new CdpClient(webSocketUrl);
await client.connect();
await client.command("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

try {
  for (const capture of captures) {
    process.stdout.write(`Capturing ${capture.id}...\n`);
    const cleanup = await capture.setup(client);
    try {
      const outputPath = join(repoRoot, "packages", capture.packageDir, "assets", "staged-preview.png");
      await client.capture(outputPath);
      process.stdout.write(`  ${outputPath}\n`);
    } finally {
      if (cleanup) await cleanup();
    }
  }
} finally {
  client.socket?.close();
  if (chromeProcess) chromeProcess.kill();
}
