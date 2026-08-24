import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const width = 1440;
const height = 900;

const colors = {
  canvas: "#e5e9ed",
  shell: "#f8fafb",
  rail: "#f1f4f6",
  ink: "#17212b",
  text: "#25303b",
  muted: "#687784",
  faint: "#8d9aa5",
  line: "#d6dde3",
  white: "#ffffff",
  success: "#237c59",
  warning: "#a4681b",
  danger: "#b45652",
  info: "#3c6f96",
};

const plugins = [
  {
    package: "bb-plugin-agent-checklists",
    name: "Checklists",
    nav: "Checklists",
    accent: "#d26b31",
    soft: "#f8e8dc",
    kicker: "Thread inspector",
    title: "Keep work moving, one checked step at a time",
    subtitle: "A persisted checklist keeps the agent focused and makes the next continuation visible.",
    scene: "checklists",
  },
  {
    package: "bb-plugin-agent-plugins",
    name: "Agent Plugins",
    nav: "Agent Plugins",
    accent: "#7255a7",
    soft: "#eee9f7",
    kicker: "Plugin manager",
    title: "Install skills and MCP servers once",
    subtitle: "One quiet control surface for local paths, Git sources, npm packages, skills, and approvals.",
    scene: "agent-plugins",
  },
  {
    package: "bb-plugin-cobalt2",
    name: "Cobalt2",
    nav: "Cobalt2",
    accent: "#1784bc",
    soft: "#dff1f8",
    kicker: "Theme preview",
    title: "Bring a focused color system into BB",
    subtitle: "Cobalt2 contributes a complete palette that appears in Settings → Appearance and the theme picker.",
    scene: "cobalt2",
  },
  {
    package: "bb-plugin-comprehension",
    name: "Comprehension",
    nav: "Comprehension",
    accent: "#c85754",
    soft: "#f9e6e3",
    kicker: "Explainer studio",
    title: "Turn a thread into something you can follow",
    subtitle: "Choose an HTML explainer, audio briefing, or two-voice podcast walkthrough from the same source.",
    scene: "comprehension",
  },
  {
    package: "bb-plugin-copy-session-id",
    name: "Copy Session ID",
    nav: "Copy session ID",
    accent: "#5363a8",
    soft: "#e8ebf8",
    kicker: "Sidebar action",
    title: "Put one useful action exactly where it belongs",
    subtitle: "Copy a thread’s BB session identifier from the existing sidebar context menu.",
    scene: "copy-session-id",
  },
  {
    package: "bb-plugin-council",
    name: "Council",
    nav: "Council",
    accent: "#187b72",
    soft: "#dff1ee",
    kicker: "Deliberation room",
    title: "Give a proposal more than one point of view",
    subtitle: "Independent advisors review, discuss, register their votes, and return a verdict with dissent.",
    scene: "council",
  },
  {
    package: "bb-plugin-ds4",
    name: "DwarfStar",
    nav: "DwarfStar",
    accent: "#2b83a1",
    soft: "#def0f5",
    kicker: "Local inference",
    title: "Keep a local model ready when work needs it",
    subtitle: "Configure DwarfStar once, then let BB supervise startup, health, reuse, and shutdown.",
    scene: "ds4",
  },
  {
    package: "bb-plugin-emoji-react",
    name: "Emoji React",
    nav: "Emoji React",
    accent: "#c24f82",
    soft: "#f8e4ed",
    kicker: "Message actions",
    title: "React to the exact line you mean",
    subtitle: "Select text or use the message action bar to draft a clear, configurable reaction.",
    scene: "emoji-react",
  },
  {
    package: "bb-plugin-excalidraw",
    name: "Excalidraw",
    nav: "Excalidraw",
    accent: "#c77635",
    soft: "#f7e9dc",
    kicker: "Shared canvas",
    title: "Keep the diagram in the conversation",
    subtitle: "Draw, autosave, attach, mention, and edit a live Excalidraw scene with an agent.",
    scene: "excalidraw",
  },
  {
    package: "bb-plugin-plannotator",
    name: "Plannotator",
    nav: "Plannotator",
    accent: "#2c865b",
    soft: "#e1f1e7",
    kicker: "Plan review",
    title: "Review the plan before the work runs",
    subtitle: "The upstream Plannotator review stays in BB’s right panel and returns approval or feedback to the agent.",
    scene: "plannotator",
  },
  {
    package: "bb-plugin-prime-agent",
    name: "Prime Agent",
    nav: "Prime Agent",
    accent: "#9b711b",
    soft: "#f6edd4",
    kicker: "ACP provider",
    title: "Make Prime Agent a first-class BB provider",
    subtitle: "Setup writes the shim, logo, and provider entry, then reloads the running BB configuration.",
    scene: "prime-agent",
  },
  {
    package: "bb-plugin-traces",
    name: "Traces",
    nav: "Traces",
    accent: "#476a9b",
    soft: "#e5ebf5",
    kicker: "Trajectory explorer",
    title: "See the session behind the answer",
    subtitle: "Search local agent sessions, inspect timing, and open the exact tool payload when you need it.",
    scene: "traces",
  },
  {
    package: "bb-plugin-ua-fetch",
    name: "UA Fetch",
    nav: "UA Fetch",
    accent: "#66872d",
    soft: "#e9f0dc",
    kicker: "Adaptive web fetch",
    title: "Try the identity that can actually read the page",
    subtitle: "Probe user-agent presets, cache the winner, and return the attempt trail with the content.",
    scene: "ua-fetch",
  },
];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function attr(value) {
  return escapeXml(value);
}

function text(value, x, y, options = {}) {
  const size = options.size ?? 14;
  const fill = options.fill ?? colors.text;
  const weight = options.weight ?? 400;
  const family = options.family ?? "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const anchor = options.anchor ? ` text-anchor="${attr(options.anchor)}"` : "";
  const letterSpacing = options.letterSpacing === undefined ? "" : ` letter-spacing="${options.letterSpacing}"`;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}px" font-weight="${weight}"${anchor}${letterSpacing}>${escapeXml(value)}</text>`;
}

function multiline(lines, x, y, options = {}) {
  const lineHeight = options.lineHeight ?? (options.size ?? 14) * 1.35;
  return lines.map((line, index) => text(line, x, y + index * lineHeight, options)).join("");
}

function wrap(value, maxChars) {
  const words = String(value).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function paragraph(value, x, y, width, options = {}) {
  const size = options.size ?? 14;
  const maxChars = Math.max(12, Math.floor(width / (size * 0.54)));
  return multiline(wrap(value, maxChars), x, y, { ...options, size });
}

function rect(x, y, w, h, fill, options = {}) {
  const stroke = options.stroke ? ` stroke="${options.stroke}" stroke-width="${options.strokeWidth ?? 1}"` : "";
  const radius = options.radius ?? 0;
  const opacity = options.opacity === undefined ? "" : ` opacity="${options.opacity}"`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}"${stroke}${opacity}/>`;
}

function line(x1, y1, x2, y2, stroke = colors.line, width = 1, dash = "") {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function circle(cx, cy, r, fill, stroke = "", width = 1) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${width}"` : ""}/>`;
}

function pill(label, x, y, options = {}) {
  const size = options.size ?? 11;
  const width = options.width ?? Math.max(58, label.length * (size * 0.62) + 22);
  const fill = options.fill ?? colors.rail;
  const stroke = options.stroke ?? colors.line;
  const color = options.color ?? colors.muted;
  return [
    rect(x, y, width, 25, fill, { stroke, radius: 13 }),
    text(label, x + width / 2, y + 17, { size, fill: color, weight: 600, anchor: "middle", letterSpacing: 0.2 }),
  ].join("");
}

function button(label, x, y, options = {}) {
  const width = options.width ?? Math.max(82, label.length * 7.1 + 28);
  const height = options.height ?? 34;
  const fill = options.fill ?? colors.white;
  const stroke = options.stroke ?? colors.line;
  const color = options.color ?? colors.text;
  return [
    rect(x, y, width, height, fill, { stroke, radius: 7 }),
    text(label, x + width / 2, y + height / 2 + 5, { size: options.size ?? 12, fill: color, weight: 600, anchor: "middle" }),
  ].join("");
}

function dotLabel(label, x, y, color, options = {}) {
  return [circle(x, y - 4, 4, color), text(label, x + 12, y, { size: options.size ?? 12, fill: options.fill ?? colors.text, weight: options.weight ?? 500 })].join("");
}

function checkbox(x, y, checked, accent) {
  const fill = checked ? accent : colors.white;
  const mark = checked ? `<path d="M ${x + 5} ${y + 10} l 4 4 l 8 -9" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : "";
  return `${rect(x, y, 20, 20, fill, { stroke: checked ? accent : colors.line, radius: 5 })}${mark}`;
}

function toggle(x, y, enabled, accent) {
  return `${rect(x, y, 42, 23, enabled ? accent : "#d8dee3", { radius: 12 })}${circle(x + (enabled ? 30 : 12), y + 11.5, 8, colors.white)}`;
}

function field(label, value, x, y, w, options = {}) {
  return [
    text(label, x, y, { size: 11, fill: colors.muted, weight: 700, letterSpacing: 0.3 }),
    rect(x, y + 10, w, 36, colors.white, { stroke: options.stroke ?? colors.line, radius: 6 }),
    text(value, x + 12, y + 33, { size: options.size ?? 12, fill: options.color ?? colors.text, family: options.mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined }),
  ].join("");
}

function panel(x, y, w, h, options = {}) {
  return rect(x, y, w, h, options.fill ?? colors.white, { stroke: options.stroke ?? colors.line, radius: options.radius ?? 10 });
}

function panelHeader(label, x, y, options = {}) {
  return [
    text(label, x, y, { size: options.size ?? 13, fill: options.fill ?? colors.text, weight: 700 }),
    options.meta ? text(options.meta, x + (options.metaOffset ?? 240), y, { size: 11, fill: colors.muted }) : "",
  ].join("");
}

function progressBar(x, y, w, pct, accent) {
  return `${rect(x, y, w, 8, "#e7ebee", { radius: 4 })}${rect(x, y, Math.round(w * pct), 8, accent, { radius: 4 })}`;
}

function codeLine(value, x, y, options = {}) {
  return text(value, x, y, { size: options.size ?? 12, fill: options.fill ?? colors.text, family: "ui-monospace, SFMono-Regular, Menlo, monospace", weight: options.weight ?? 500 });
}

function sidebar(plugin) {
  const x = 44;
  const y = 102;
  const items = ["Threads", "Files", "Settings"];
  let out = [text("WORKSPACE", x + 28, y + 36, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 1.2 })];
  items.forEach((item, index) => {
    const rowY = y + 56 + index * 36;
    if (item === "Settings") out.push(rect(x + 14, rowY - 19, 220, 32, colors.white, { radius: 6 }));
    out.push(text(item, x + 38, rowY + 2, { size: 13, fill: item === "Settings" ? colors.text : colors.muted, weight: item === "Settings" ? 650 : 500 }));
  });
  out.push(text("EXTENSIONS", x + 28, y + 202, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 1.2 }));
  out.push(rect(x + 14, y + 219, 220, 35, plugin.soft, { radius: 6 }));
  out.push(circle(x + 31, y + 237, 5, plugin.accent));
  out.push(text(plugin.nav, x + 46, y + 242, { size: 13, fill: colors.text, weight: 700 }));
  out.push(text("Installed", x + 46, y + 260, { size: 10, fill: colors.muted }));
  out.push(line(x + 28, y + 292, x + 220, y + 292));
  out.push(text("STAGED FOR DOCUMENTATION", x + 28, y + 324, { size: 9, fill: colors.faint, weight: 700, letterSpacing: 0.8 }));
  out.push(text("Illustrative data", x + 28, y + 348, { size: 11, fill: colors.muted }));
  out.push(text("No live session required", x + 28, y + 367, { size: 11, fill: colors.muted }));
  return out.join("");
}

function shell(plugin, sceneMarkup) {
  const titleId = `${plugin.package}-title`;
  const descId = `${plugin.package}-desc`;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${titleId} ${descId}">`,
    `<title id="${titleId}">Staged preview of ${escapeXml(plugin.name)} in BB</title>`,
    `<desc id="${descId}">${escapeXml(plugin.subtitle)}</desc>`,
    `<rect width="${width}" height="${height}" fill="${colors.canvas}"/>`,
    rect(44, 42, 1352, 816, colors.shell, { stroke: "#cbd3da", radius: 16 }),
    rect(44, 42, 1352, 60, colors.ink, { radius: 16 }),
    rect(44, 86, 1352, 16, colors.ink),
    circle(70, 72, 6, "#f07c72"),
    circle(90, 72, 6, "#f2c46e"),
    circle(110, 72, 6, "#66c58a"),
    text("bb", 140, 78, { size: 17, fill: colors.white, weight: 800, letterSpacing: -0.4 }),
    line(172, 60, 172, 84, "#50606e"),
    text(plugin.name, 194, 78, { size: 13, fill: "#d9e0e5", weight: 600 }),
    pill("STAGED PREVIEW", 1224, 59, { width: 142, fill: "#2a3641", stroke: "#53626e", color: "#e7eef2", size: 10 }),
    rect(44, 102, 248, 756, colors.rail),
    line(292, 102, 292, 858, colors.line),
    sidebar(plugin),
    text(plugin.kicker.toUpperCase(), 330, 150, { size: 10, fill: plugin.accent, weight: 800, letterSpacing: 1.2 }),
    text(plugin.title, 330, 184, { size: 25, fill: colors.ink, weight: 750, letterSpacing: -0.4 }),
    paragraph(plugin.subtitle, 330, 211, 680, { size: 13, fill: colors.muted, lineHeight: 18 }),
    pill("Illustrative UI", 1244, 153, { width: 104, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent, size: 10 }),
    line(330, 254, 1368, 254, colors.line),
    sceneMarkup,
    text("BB plugin documentation · staged preview", 330, 833, { size: 10, fill: colors.faint, weight: 600 }),
    text("Illustrative data", 1368, 833, { size: 10, fill: colors.faint, weight: 600, anchor: "end" }),
    "</svg>",
  ];
  return out.join("\n");
}

function scene(plugin) {
  switch (plugin.scene) {
    case "checklists": return checklistsScene(plugin);
    case "agent-plugins": return agentPluginsScene(plugin);
    case "cobalt2": return cobalt2Scene(plugin);
    case "comprehension": return comprehensionScene(plugin);
    case "copy-session-id": return copySessionIdScene(plugin);
    case "council": return councilScene(plugin);
    case "ds4": return ds4Scene(plugin);
    case "emoji-react": return emojiReactScene(plugin);
    case "excalidraw": return excalidrawScene(plugin);
    case "plannotator": return plannotatorScene(plugin);
    case "prime-agent": return primeAgentScene(plugin);
    case "traces": return tracesScene(plugin);
    case "ua-fetch": return uaFetchScene(plugin);
    default: throw new Error(`Unknown scene: ${plugin.scene}`);
  }
}

function checklistsScene(plugin) {
  const out = [panel(330, 282, 408, 516), panel(762, 282, 606, 516, { fill: "#fbfcfd" })];
  out.push(panelHeader("Thread checklist", 358, 318));
  out.push(pill("ACTIVE", 624, 298, { width: 76, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent }));
  out.push(text("Migration notes", 358, 344, { size: 18, fill: colors.ink, weight: 750 }));
  out.push(text("3 of 5 steps complete", 358, 367, { size: 12, fill: colors.muted }));
  out.push(progressBar(358, 382, 350, 0.6, plugin.accent));
  const rows = [
    ["Confirm the current schema", true],
    ["Map the affected commands", true],
    ["Draft the migration note", true],
    ["Run the focused test suite", false],
    ["Record the rollout decision", false],
  ];
  rows.forEach(([label, checked], index) => {
    const y = 424 + index * 56;
    out.push(checkbox(358, y - 16, checked, plugin.accent));
    out.push(text(label, 392, y, { size: 13, fill: checked ? colors.muted : colors.text, weight: checked ? 500 : 650 }));
    if (checked) out.push(text("done", 676, y, { size: 10, fill: plugin.accent, weight: 700, anchor: "end" }));
    if (index < rows.length - 1) out.push(line(358, y + 20, 710, y + 20));
  });
  out.push(panelHeader("Next continuation", 792, 318));
  out.push(pill("AUTOMATIC", 1220, 298, { width: 110, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent }));
  out.push(text("Run the focused test suite", 792, 365, { size: 20, fill: colors.ink, weight: 750 }));
  out.push(paragraph("The agent will resume when it becomes idle with incomplete steps.", 792, 394, 490, { size: 13, fill: colors.muted, lineHeight: 18 }));
  out.push(rect(792, 442, 490, 112, plugin.soft, { radius: 8 }));
  out.push(text("Agent note", 816, 472, { size: 10, fill: plugin.accent, weight: 800, letterSpacing: 0.7 }));
  out.push(paragraph("The command map is complete. The next pass checks only the migration path.", 816, 499, 430, { size: 13, fill: colors.text, lineHeight: 19 }));
  out.push(text("Continuation limit", 792, 606, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(text("8 reminders", 1280, 606, { size: 12, fill: colors.text, weight: 700, anchor: "end" }));
  out.push(progressBar(792, 622, 490, 0.375, plugin.accent));
  out.push(button("View inspector", 792, 690, { width: 128, fill: plugin.accent, stroke: plugin.accent, color: colors.white }));
  out.push(button("Close lifecycle", 932, 690, { width: 128 }));
  return out.join("");
}

function agentPluginsScene(plugin) {
  const out = [panel(330, 282, 1038, 96), panel(330, 400, 1038, 398)];
  out.push(panelHeader("Install a plugin", 358, 313));
  out.push(rect(358, 328, 638, 36, colors.white, { stroke: colors.line, radius: 6 }));
  out.push(codeLine("https://github.com/acme/quality-tools", 372, 351, { size: 12, fill: colors.muted }));
  out.push(button("Browse…", 1008, 328, { width: 94 }));
  out.push(button("Install", 1110, 328, { width: 82, fill: plugin.accent, stroke: plugin.accent, color: colors.white }));
  out.push(text("Local path, Git, or npm — updates keep your data.", 358, 389, { size: 10, fill: colors.muted }));
  out.push(panelHeader("Installed plugins", 358, 437));
  out.push(pill("1 ACTIVE", 1266, 417, { width: 84, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent }));
  out.push(rect(358, 462, 982, 54, plugin.soft, { radius: 7 }));
  out.push(circle(380, 489, 5, colors.success));
  out.push(text("quality-tools", 396, 486, { size: 14, fill: colors.ink, weight: 750 }));
  out.push(text("1.4.0  ·  Git source", 396, 503, { size: 10, fill: colors.muted }));
  out.push(pill("Update available", 1130, 476, { width: 126, fill: colors.white, stroke: "#ddc58d", color: colors.warning, size: 10 }));
  out.push(button("Update", 1268, 473, { width: 72, height: 29, size: 11 }));
  out.push(text("SKILLS", 390, 548, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 1 }));
  out.push(text("MCP SERVERS", 830, 548, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 1 }));
  out.push(line(798, 536, 798, 754));
  out.push(dotLabel("review", 390, 582, colors.success, { size: 13, weight: 650 }));
  out.push(text("/skill command", 490, 582, { size: 11, fill: colors.muted }));
  out.push(toggle(690, 566, true, plugin.accent));
  out.push(line(390, 606, 758, 606));
  out.push(dotLabel("release-notes", 390, 636, colors.muted, { size: 13, weight: 650 }));
  out.push(text("disabled for next session", 490, 636, { size: 11, fill: colors.muted }));
  out.push(toggle(690, 620, false, plugin.accent));
  out.push(dotLabel("linear", 830, 582, colors.warning, { size: 13, weight: 650 }));
  out.push(text("Streamable HTTP", 918, 582, { size: 11, fill: colors.muted }));
  out.push(pill("Needs approval", 830, 602, { width: 116, fill: "#fbf2dc", stroke: "#e6ca91", color: colors.warning, size: 10 }));
  out.push(button("Approve & start", 1058, 598, { width: 124, height: 29, size: 11, fill: plugin.accent, stroke: plugin.accent, color: colors.white }));
  out.push(toggle(1266, 603, true, plugin.accent));
  out.push(line(830, 648, 1312, 648));
  out.push(dotLabel("github", 830, 679, colors.success, { size: 13, weight: 650 }));
  out.push(text("stdio", 918, 679, { size: 11, fill: colors.muted }));
  out.push(pill("Ready", 1240, 665, { width: 72, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent, size: 10 }));
  out.push(text("Disabled capabilities stay disabled until you turn them back on.", 830, 728, { size: 11, fill: colors.muted }));
  return out.join("");
}

function cobalt2Scene(plugin) {
  const out = [panel(330, 282, 286, 516, { fill: "#f3f5f7" }), panel(640, 282, 728, 516, { fill: "#ffffff" })];
  out.push(text("Appearance", 358, 319, { size: 17, fill: colors.ink, weight: 750 }));
  out.push(text("Theme", 358, 365, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(rect(350, 382, 246, 42, plugin.soft, { radius: 7 }));
  out.push(circle(370, 403, 5, plugin.accent));
  out.push(text("Cobalt2", 386, 407, { size: 13, fill: colors.text, weight: 700 }));
  out.push(text("Installed by plugin", 386, 423, { size: 10, fill: colors.muted }));
  out.push(text("Light", 358, 472, { size: 13, fill: colors.muted }));
  out.push(text("Dark", 358, 510, { size: 13, fill: colors.muted }));
  out.push(text("System", 358, 548, { size: 13, fill: colors.muted }));
  out.push(line(358, 584, 570, 584));
  out.push(text("CLI", 358, 618, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 0.9 }));
  out.push(codeLine("bb theme set plugin:cobalt2:cobalt2", 358, 646, { size: 10, fill: colors.text }));
  out.push(text("Cobalt2 palette", 674, 320, { size: 17, fill: colors.ink, weight: 750 }));
  out.push(pill("ACTIVE THEME", 1236, 298, { width: 104, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent }));
  out.push(text("A compact preview of the color roles contributed by the plugin.", 674, 346, { size: 12, fill: colors.muted }));
  out.push(rect(674, 378, 672, 160, "#193549", { radius: 8 }));
  out.push(text("bb", 700, 414, { size: 16, fill: "#ffffff", weight: 800 }));
  out.push(text("Local workspace", 700, 454, { size: 20, fill: "#ffffff", weight: 750 }));
  out.push(text("Cobalt2 keeps code, status, and action colors distinct.", 700, 482, { size: 12, fill: "#a9bfd0" }));
  out.push(button("Run command", 700, 497, { width: 110, height: 28, size: 11, fill: "#ffc600", stroke: "#ffc600", color: "#193549" }));
  const swatches = [
    ["Canvas", "#193549"], ["Action", "#ffc600"], ["Link", "#0088ff"], ["Success", "#3ad900"], ["Signal", "#ff628c"], ["Code", "#ff9d00"],
  ];
  swatches.forEach(([label, color], index) => {
    const x = 674 + (index % 3) * 218;
    const y = 586 + Math.floor(index / 3) * 74;
    out.push(rect(x, y, 196, 52, "#f7f9fa", { stroke: colors.line, radius: 7 }));
    out.push(rect(x + 12, y + 12, 28, 28, color, { radius: 6 }));
    out.push(text(label, x + 54, y + 28, { size: 12, fill: colors.text, weight: 700 }));
    out.push(text(color, x + 54, y + 43, { size: 10, fill: colors.muted, family: "ui-monospace, SFMono-Regular, Menlo, monospace" }));
  });
  return out.join("");
}

function comprehensionScene(plugin) {
  const out = [panel(330, 282, 420, 516), panel(774, 282, 594, 516, { fill: "#fbfcfd" })];
  out.push(panelHeader("Explain this thread", 358, 318));
  out.push(pill("4 messages", 626, 298, { width: 94, fill: colors.rail, stroke: colors.line, color: colors.muted }));
  out.push(text("Source", 358, 365, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(rect(358, 382, 364, 90, "#f4f6f8", { stroke: colors.line, radius: 7 }));
  out.push(text("Assistant · 10:42", 378, 410, { size: 11, fill: plugin.accent, weight: 700 }));
  out.push(paragraph("The rollout has three independent risks, but only one blocks release.", 378, 437, 318, { size: 13, fill: colors.text, lineHeight: 18 }));
  out.push(text("Format", 358, 520, { size: 11, fill: colors.muted, weight: 700 }));
  const formats = [["HTML explainer", "Skimmable report"], ["Audio briefing", "One narrator"], ["Podcast walkthrough", "Two voices + chapters"]];
  formats.forEach(([label, detail], index) => {
    const y = 538 + index * 62;
    const selected = index === 2;
    out.push(rect(358, y, 364, 49, selected ? plugin.soft : colors.white, { stroke: selected ? plugin.accent : colors.line, radius: 7 }));
    out.push(circle(380, y + 24, 7, selected ? plugin.accent : colors.white, selected ? plugin.accent : colors.line, 2));
    if (selected) out.push(circle(380, y + 24, 3, colors.white));
    out.push(text(label, 400, y + 22, { size: 12, fill: colors.text, weight: 700 }));
    out.push(text(detail, 400, y + 38, { size: 10, fill: colors.muted }));
  });
  out.push(panelHeader("Podcast walkthrough", 802, 318));
  out.push(pill("READY TO GENERATE", 1188, 298, { width: 150, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent, size: 10 }));
  out.push(rect(802, 350, 538, 142, "#202c35", { radius: 9 }));
  out.push(text("THE QUIET NEWSROOM", 828, 381, { size: 10, fill: "#9ecac1", weight: 800, letterSpacing: 1.2 }));
  out.push(text("Three risks, one release", 828, 421, { size: 23, fill: colors.white, weight: 750 }));
  out.push(text("Host  ·  Explainer  ·  Chapter 01", 828, 452, { size: 11, fill: "#b7c4ca" }));
  out.push(line(828, 470, 1314, 470, "#53656d"));
  out.push(circle(842, 482, 9, plugin.accent));
  out.push(rect(862, 478, 388, 8, "#52626a", { radius: 4 }));
  out.push(rect(862, 478, 146, 8, plugin.accent, { radius: 4 }));
  out.push(text("00:34", 1270, 487, { size: 10, fill: "#dce4e7", family: "ui-monospace, SFMono-Regular, Menlo, monospace" }));
  out.push(text("Chapters", 802, 536, { size: 11, fill: colors.muted, weight: 700 }));
  [["01", "What changed", true], ["02", "What can wait", false], ["03", "Release decision", false]].forEach(([num, label, active], index) => {
    const y = 562 + index * 48;
    out.push(circle(818, y - 4, 13, active ? plugin.accent : colors.white, active ? plugin.accent : colors.line, 1));
    out.push(text(num, 818, y, { size: 10, fill: active ? colors.white : colors.muted, weight: 800, anchor: "middle" }));
    out.push(text(label, 846, y, { size: 12, fill: active ? colors.text : colors.muted, weight: active ? 700 : 500 }));
    if (index < 2) out.push(line(818, y + 12, 818, y + 32, colors.line));
  });
  out.push(button("Generate podcast", 802, 718, { width: 150, fill: plugin.accent, stroke: plugin.accent, color: colors.white }));
  out.push(text("Saved explainers can be reopened without regenerating.", 968, 740, { size: 11, fill: colors.muted }));
  return out.join("");
}

function copySessionIdScene(plugin) {
  const out = [panel(330, 282, 402, 516, { fill: "#f4f6f8" }), panel(760, 282, 608, 516, { fill: "#fbfcfd" })];
  out.push(text("Threads", 358, 320, { size: 17, fill: colors.ink, weight: 750 }));
  out.push(text("Recent", 358, 348, { size: 11, fill: colors.muted, weight: 700 }));
  const threads = [
    ["Release notes", "just now"], ["Migration review", "12m"], ["Investigate timeout", "1h"], ["Design sync", "yesterday"],
  ];
  threads.forEach(([label, time], index) => {
    const y = 382 + index * 66;
    const selected = index === 1;
    if (selected) out.push(rect(350, y - 24, 362, 54, plugin.soft, { radius: 7 }));
    out.push(circle(370, y - 2, 5, selected ? plugin.accent : "#aab5bd"));
    out.push(text(label, 388, y - 1, { size: 13, fill: colors.text, weight: selected ? 700 : 550 }));
    out.push(text(time, 686, y - 1, { size: 10, fill: colors.muted, anchor: "end" }));
    out.push(text(selected ? "right-click to act" : "", 388, y + 17, { size: 10, fill: plugin.accent }));
    if (index < threads.length - 1) out.push(line(358, y + 30, 704, y + 30));
  });
  out.push(text("Selected thread", 788, 320, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(text("Migration review", 788, 348, { size: 20, fill: colors.ink, weight: 750 }));
  out.push(text("The host sidebar remains unchanged. The plugin adds one menu item.", 788, 376, { size: 12, fill: colors.muted }));
  out.push(rect(788, 418, 222, 188, colors.white, { stroke: colors.line, radius: 8 }));
  out.push(text("Thread actions", 812, 452, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(text("Open", 812, 486, { size: 13, fill: colors.text, weight: 550 }));
  out.push(text("Rename", 812, 524, { size: 13, fill: colors.text, weight: 550 }));
  out.push(rect(800, 542, 198, 38, plugin.soft, { radius: 5 }));
  out.push(text("Copy session ID", 816, 566, { size: 13, fill: plugin.accent, weight: 750 }));
  out.push(text("⌘  C", 968, 566, { size: 11, fill: colors.muted, anchor: "end" }));
  out.push(rect(788, 646, 544, 68, "#e5f3eb", { stroke: "#b9dec8", radius: 8 }));
  out.push(circle(814, 680, 11, colors.success));
  out.push(text("✓", 814, 685, { size: 13, fill: colors.white, weight: 800, anchor: "middle" }));
  out.push(text("Session ID copied to clipboard", 840, 678, { size: 13, fill: colors.success, weight: 700 }));
  out.push(codeLine("thr_8c2f4e9b1a7d", 840, 698, { size: 11, fill: colors.text }));
  return out.join("");
}

function councilScene(plugin) {
  const out = [panel(330, 282, 1038, 516)];
  out.push(panelHeader("Council session", 358, 318));
  out.push(pill("DISCUSSION · ROUND 2", 1182, 298, { width: 158, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent, size: 10 }));
  out.push(text("Should the migration ship this week?", 358, 360, { size: 18, fill: colors.ink, weight: 750 }));
  out.push(text("3 members · research enabled · chief justice: Grug", 358, 386, { size: 11, fill: colors.muted }));
  out.push(line(358, 408, 1340, 408));
  out.push(text("MEMBERS", 358, 435, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 1 }));
  out.push(text("DISCUSSION", 650, 435, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 1 }));
  out.push(text("TALLY", 1208, 435, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 1 }));
  out.push(line(610, 424, 610, 754));
  out.push(line(1174, 424, 1174, 754));
  const members = [["Grug", "chief justice", colors.success, "voted"], ["Architect", "systems thinking", plugin.accent, "reviewing"], ["Designer", "user experience", "#b68a3b", "voted"]];
  members.forEach(([name, role, color, status], index) => {
    const y = 474 + index * 76;
    out.push(circle(380, y - 5, 16, plugin.soft));
    out.push(text(name.slice(0, 1), 380, y + 1, { size: 12, fill: plugin.accent, weight: 800, anchor: "middle" }));
    out.push(text(name, 410, y - 5, { size: 13, fill: colors.text, weight: 700 }));
    out.push(text(role, 410, y + 15, { size: 10, fill: colors.muted }));
    out.push(pill(status, 410, y + 25, { width: status === "reviewing" ? 78 : 56, height: 21, fill: color === plugin.accent ? plugin.soft : "#edf4ef", stroke: "transparent", color, size: 9 }));
  });
  out.push(text("Architect", 650, 474, { size: 11, fill: plugin.accent, weight: 800 }));
  out.push(paragraph("The migration is bounded, but the rollback path needs one explicit owner.", 650, 499, 470, { size: 13, fill: colors.text, lineHeight: 19 }));
  out.push(text("Designer", 650, 568, { size: 11, fill: "#b68a3b", weight: 800 }));
  out.push(paragraph("Add a user-facing note before release. The behavior change is easy to miss.", 650, 593, 470, { size: 13, fill: colors.text, lineHeight: 19 }));
  out.push(rect(650, 674, 470, 54, plugin.soft, { radius: 7 }));
  out.push(text("Next: chief justice closes the round after the last vote.", 670, 707, { size: 11, fill: plugin.accent, weight: 650 }));
  out.push(text("2", 1210, 492, { size: 30, fill: colors.ink, weight: 800 }));
  out.push(text("support", 1252, 491, { size: 12, fill: colors.muted }));
  out.push(text("1", 1210, 540, { size: 30, fill: colors.ink, weight: 800 }));
  out.push(text("abstain", 1252, 539, { size: 12, fill: colors.muted }));
  out.push(text("0", 1210, 588, { size: 30, fill: colors.ink, weight: 800 }));
  out.push(text("oppose", 1252, 587, { size: 12, fill: colors.muted }));
  out.push(line(1208, 622, 1328, 622));
  out.push(text("Registered votes", 1208, 652, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(text("2 / 3", 1328, 652, { size: 13, fill: plugin.accent, weight: 800, anchor: "end" }));
  out.push(button("Open materials", 1208, 700, { width: 120, height: 30, size: 11 }));
  return out.join("");
}

function ds4Scene(plugin) {
  const out = [panel(330, 282, 694, 516), panel(1050, 282, 318, 516, { fill: "#fbfcfd" })];
  out.push(panelHeader("DwarfStar setup", 358, 318));
  out.push(pill("READY", 924, 298, { width: 72, fill: "#e4f3ea", stroke: "#c1dfcc", color: colors.success }));
  out.push(field("DS4 CHECKOUT", "~/workingdir/ds4", 358, 354, 300, { mono: true }));
  out.push(field("MODEL FILE", "ds4flash.gguf", 674, 354, 300, { mono: true }));
  out.push(field("MODEL SELECTOR", "ds4/deepseek-v4-flash", 358, 432, 300, { mono: true }));
  out.push(field("BACKEND", "auto", 674, 432, 300));
  out.push(field("PORT", "8000", 358, 510, 140, { mono: true }));
  out.push(field("IDLE GRACE", "300 seconds", 516, 510, 180));
  out.push(field("CONTEXT", "100000 tokens", 712, 510, 262));
  out.push(text("Agent connections", 358, 604, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(dotLabel("Pi / BB", 358, 635, colors.success));
  out.push(dotLabel("opencode", 500, 635, colors.muted));
  out.push(dotLabel("Codex CLI", 650, 635, colors.muted));
  out.push(button("Apply connections", 358, 677, { width: 146, fill: plugin.accent, stroke: plugin.accent, color: colors.white }));
  out.push(codeLine("bb ds4 status", 358, 748, { size: 11, fill: colors.muted }));
  out.push(text("Supervised locally", 1050 + 28, 320, { size: 17, fill: colors.ink, weight: 750 }));
  out.push(text("Demand-driven lifecycle", 1078, 347, { size: 11, fill: colors.muted }));
  out.push(rect(1078, 380, 262, 112, plugin.soft, { radius: 8 }));
  out.push(circle(1106, 412, 8, colors.success));
  out.push(text("DwarfStar ready", 1124, 416, { size: 14, fill: colors.success, weight: 750 }));
  out.push(text("PID 18442  ·  warm", 1106, 443, { size: 11, fill: colors.muted, family: "ui-monospace, SFMono-Regular, Menlo, monospace" }));
  out.push(text("127.0.0.1:8000", 1106, 463, { size: 11, fill: colors.muted, family: "ui-monospace, SFMono-Regular, Menlo, monospace" }));
  out.push(text("Lifecycle", 1078, 538, { size: 11, fill: colors.muted, weight: 700 }));
  [["Matched turn", true], ["Health check", true], ["Idle shutdown", false]].forEach(([label, complete], index) => {
    const y = 570 + index * 48;
    out.push(circle(1090, y - 4, 6, complete ? colors.success : colors.white, complete ? colors.success : colors.line, 2));
    if (complete) out.push(text("✓", 1090, y, { size: 9, fill: colors.white, weight: 800, anchor: "middle" }));
    out.push(text(label, 1110, y, { size: 12, fill: complete ? colors.text : colors.muted, weight: complete ? 650 : 500 }));
    if (index < 2) out.push(line(1090, y + 10, 1090, y + 26, colors.line));
  });
  out.push(rect(1078, 706, 262, 54, "#e8f3f8", { radius: 7 }));
  out.push(text("Composer banner", 1096, 729, { size: 10, fill: plugin.accent, weight: 800 }));
  out.push(text("Local model is warm for this turn.", 1096, 747, { size: 11, fill: colors.text }));
  return out.join("");
}

function emojiReactScene(plugin) {
  const out = [panel(330, 282, 640, 516), panel(1000, 282, 368, 516, { fill: "#fbfcfd" })];
  out.push(panelHeader("Conversation", 358, 318));
  out.push(pill("ASSISTANT MESSAGE", 808, 298, { width: 132, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent }));
  out.push(text("Assistant", 358, 367, { size: 11, fill: plugin.accent, weight: 800 }));
  out.push(paragraph("The migration is ready for review. The highlighted line is the part that needs a decision.", 358, 397, 560, { size: 15, fill: colors.text, lineHeight: 22 }));
  out.push(rect(358, 452, 532, 48, "#fff3bb", { radius: 4 }));
  out.push(text("The rollback path must have one named owner before release.", 374, 482, { size: 14, fill: colors.ink, weight: 650 }));
  out.push(rect(372, 520, 332, 132, colors.white, { stroke: colors.line, radius: 8 }));
  out.push(text("React to selection", 394, 548, { size: 11, fill: colors.muted, weight: 700 }));
  [["👍", "Agree"], ["👎", "Disagree"], ["✅", "Do it"], ["❓", "Clarify"]].forEach(([emoji, label], index) => {
    const x = 394 + index * 72;
    out.push(rect(x, 568, 58, 58, index === 0 ? plugin.soft : colors.white, { stroke: index === 0 ? plugin.accent : colors.line, radius: 7 }));
    out.push(text(emoji, x + 29, 595, { size: 21, anchor: "middle" }));
    out.push(text(label, x + 29, 616, { size: 8, fill: colors.muted, weight: 700, anchor: "middle" }));
  });
  out.push(text("Selection menu", 394, 674, { size: 10, fill: plugin.accent, weight: 800, letterSpacing: 0.7 }));
  out.push(text("The composer receives a quoted draft.", 394, 694, { size: 11, fill: colors.muted }));
  out.push(panelHeader("Emoji reactions", 1028, 318));
  out.push(text("Where reactions appear", 1028, 354, { size: 11, fill: colors.muted, weight: 700 }));
  [["Text selection menu", true], ["Assistant message bar", true], ["User message bar", false]].forEach(([label, enabled], index) => {
    const y = 382 + index * 38;
    out.push(text(label, 1028, y, { size: 12, fill: colors.text }));
    out.push(toggle(1290, y - 17, enabled, plugin.accent));
  });
  out.push(line(1028, 502, 1340, 502));
  out.push(text("Reaction list", 1028, 534, { size: 11, fill: colors.muted, weight: 700 }));
  [["👍", "Agree"], ["👎", "Disagree"], ["✅", "Do it"], ["❓", "Clarify"]].forEach(([emoji, label], index) => {
    const y = 566 + index * 42;
    out.push(text(emoji, 1028, y, { size: 16 }));
    out.push(text(label, 1060, y, { size: 12, fill: colors.text, weight: 650 }));
    out.push(line(1028, y + 16, 1340, y + 16));
  });
  out.push(button("Save & apply", 1028, 734, { width: 112, fill: plugin.accent, stroke: plugin.accent, color: colors.white }));
  return out.join("");
}

function excalidrawScene(plugin) {
  const out = [panel(330, 282, 240, 516, { fill: "#f3f5f7" }), panel(594, 282, 774, 516, { fill: "#ffffff" })];
  out.push(panelHeader("Drawings", 358, 318));
  out.push(button("+ New drawing", 358, 338, { width: 128, height: 30, size: 11, fill: plugin.accent, stroke: plugin.accent, color: colors.white }));
  const thumbs = [
    ["Release flow", true], ["System map", false], ["Open questions", false],
  ];
  thumbs.forEach(([label, selected], index) => {
    const y = 394 + index * 116;
    out.push(rect(358, y, 184, 88, selected ? plugin.soft : colors.white, { stroke: selected ? plugin.accent : colors.line, radius: 7 }));
    out.push(rect(374, y + 14, 152, 46, "#fffdf8", { stroke: "#e5ddd0", radius: 3 }));
    out.push(line(392, y + 38, 418, y + 38, plugin.accent, 2));
    out.push(line(418, y + 38, 443, y + 26, plugin.accent, 2));
    out.push(line(443, y + 26, 470, y + 49, plugin.accent, 2));
    out.push(text(label, 374, y + 78, { size: 10, fill: colors.text, weight: selected ? 700 : 550 }));
  });
  out.push(text("Autosaved", 358, 758, { size: 10, fill: colors.success, weight: 700 }));
  out.push(text("3 drawings", 542, 758, { size: 10, fill: colors.muted, anchor: "end" }));
  out.push(text("Release flow", 620, 320, { size: 17, fill: colors.ink, weight: 750 }));
  out.push(text("Live scene · shared with the agent", 620, 345, { size: 11, fill: colors.muted }));
  out.push(pill("SYNCED", 1260, 298, { width: 78, fill: "#e4f3ea", stroke: "#c1dfcc", color: colors.success }));
  out.push(rect(620, 374, 690, 282, "#fffdf8", { stroke: "#e2dcd0", radius: 5 }));
  out.push(text("Release flow", 654, 410, { size: 16, fill: colors.ink, weight: 750 }));
  out.push(rect(666, 454, 142, 54, "#e7f2f6", { stroke: plugin.accent, radius: 5 }));
  out.push(text("Draft", 737, 486, { size: 14, fill: plugin.accent, weight: 750, anchor: "middle" }));
  out.push(rect(884, 454, 142, 54, plugin.soft, { stroke: plugin.accent, radius: 5 }));
  out.push(text("Review", 955, 486, { size: 14, fill: plugin.accent, weight: 750, anchor: "middle" }));
  out.push(rect(1102, 454, 142, 54, "#e7f2f6", { stroke: plugin.accent, radius: 5 }));
  out.push(text("Ship", 1173, 486, { size: 14, fill: plugin.accent, weight: 750, anchor: "middle" }));
  out.push(line(808, 481, 884, 481, plugin.accent, 2));
  out.push(line(1026, 481, 1102, 481, plugin.accent, 2));
  out.push(text("agent reads the current scene", 862, 554, { size: 11, fill: colors.muted }));
  out.push(rect(620, 684, 690, 64, "#f3f6f7", { stroke: colors.line, radius: 7 }));
  out.push(text("@drawing  Release flow", 642, 712, { size: 13, fill: plugin.accent, weight: 700 }));
  out.push(text("Attach as image", 1168, 712, { size: 11, fill: colors.muted, weight: 650 }));
  return out.join("");
}

function plannotatorScene(plugin) {
  const out = [panel(330, 282, 594, 516, { fill: "#f4f6f8" }), panel(948, 282, 420, 516, { fill: "#ffffff" })];
  out.push(text("Agent thread", 358, 319, { size: 17, fill: colors.ink, weight: 750 }));
  out.push(text("The agent is waiting for a plan decision.", 358, 348, { size: 12, fill: colors.muted }));
  out.push(rect(358, 386, 538, 142, colors.white, { stroke: colors.line, radius: 8 }));
  out.push(text("I will update the migration in three steps:", 382, 420, { size: 13, fill: colors.text, weight: 650 }));
  ["Keep the schema change backward compatible", "Add focused tests for the rollback path", "Document the release owner"].forEach((label, index) => {
    const y = 450 + index * 24;
    out.push(text(`${index + 1}.`, 382, y, { size: 12, fill: plugin.accent, weight: 800 }));
    out.push(text(label, 404, y, { size: 12, fill: colors.text }));
  });
  out.push(rect(358, 562, 538, 78, "#e7f3eb", { stroke: "#c2dfcb", radius: 8 }));
  out.push(text("Waiting for Plannotator", 382, 592, { size: 12, fill: colors.success, weight: 750 }));
  out.push(text("The review can stay open until you decide.", 382, 614, { size: 11, fill: colors.muted }));
  out.push(text("Right panel", 358, 704, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 0.8 }));
  out.push(text("Persistent review tab · same-origin relay", 358, 728, { size: 12, fill: colors.muted }));
  out.push(text("Plan review", 976, 320, { size: 17, fill: colors.ink, weight: 750 }));
  out.push(pill("OPEN", 1292, 298, { width: 52, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent }));
  out.push(text("Migration plan", 976, 363, { size: 15, fill: colors.text, weight: 700 }));
  out.push(text("3 steps · 1 note", 976, 387, { size: 11, fill: colors.muted }));
  const planRows = [["Schema compatibility", "reviewed", true], ["Rollback tests", "needs note", false], ["Release owner", "reviewed", true]];
  planRows.forEach(([label, status, done], index) => {
    const y = 428 + index * 68;
    out.push(rect(976, y - 20, 356, 50, done ? "#fbfcfd" : "#fff9ed", { stroke: done ? colors.line : "#ead39d", radius: 7 }));
    out.push(checkbox(994, y - 6, done, plugin.accent));
    out.push(text(label, 1026, y + 1, { size: 12, fill: colors.text, weight: 650 }));
    out.push(text(status, 1026, y + 18, { size: 10, fill: done ? colors.success : colors.warning }));
  });
  out.push(line(976, 650, 1332, 650));
  out.push(button("Approve plan", 976, 684, { width: 122, fill: plugin.accent, stroke: plugin.accent, color: colors.white }));
  out.push(button("Send feedback", 1110, 684, { width: 122 }));
  out.push(text("Open externally", 1248, 706, { size: 10, fill: colors.muted, anchor: "end" }));
  return out.join("");
}

function primeAgentScene(plugin) {
  const out = [panel(330, 282, 506, 516, { fill: "#202831" }), panel(864, 282, 504, 516, { fill: "#ffffff" })];
  out.push(text("Setup log", 358, 320, { size: 17, fill: "#ffffff", weight: 750 }));
  out.push(pill("CONFIG RELOADED", 666, 298, { width: 142, fill: "#2f473c", stroke: "#456a55", color: "#bde1c7", size: 10 }));
  out.push(codeLine("$ bb prime-agent setup", 358, 370, { size: 13, fill: "#f1c95b" }));
  const logs = [
    ["✓", "shim written", "#9fddb2"],
    ["✓", "logo written", "#9fddb2"],
    ["✓", "customAcpAgents merged", "#9fddb2"],
    ["↻", "BB config reload requested", "#b9c8d0"],
    ["→", "acp-prime-agent is ready", "#f1c95b"],
  ];
  logs.forEach(([mark, label, color], index) => {
    const y = 420 + index * 45;
    out.push(codeLine(mark, 358, y, { size: 13, fill: color, weight: 700 }));
    out.push(codeLine(label, 384, y, { size: 12, fill: "#d6e0e4" }));
  });
  out.push(line(358, 662, 808, 662, "#42505a"));
  out.push(codeLine("$ bb provider list", 358, 700, { size: 12, fill: "#b9c8d0" }));
  out.push(codeLine("acp-prime-agent   Prime Agent", 358, 728, { size: 12, fill: "#ffffff", weight: 700 }));
  out.push(text("Provider registration", 892, 320, { size: 17, fill: colors.ink, weight: 750 }));
  out.push(pill("AVAILABLE", 1266, 298, { width: 82, fill: "#e4f3ea", stroke: "#c1dfcc", color: colors.success }));
  out.push(field("PROVIDER ID", "acp-prime-agent", 892, 360, 430, { mono: true }));
  out.push(field("MODEL PICKER", "opencode-go/deepseek-v4-flash", 892, 438, 430, { mono: true }));
  out.push(text("Authenticated providers", 892, 544, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(dotLabel("opencode-go", 892, 576, colors.success));
  out.push(dotLabel("anthropic", 1024, 576, colors.muted));
  out.push(dotLabel("openai", 1142, 576, colors.muted));
  out.push(line(892, 604, 1322, 604));
  out.push(codeLine("bb thread spawn --provider acp-prime-agent", 892, 640, { size: 10, fill: colors.muted }));
  out.push(codeLine("--model opencode-go/deepseek-v4-flash", 892, 660, { size: 10, fill: colors.text }));
  out.push(button("Open provider settings", 892, 710, { width: 164, fill: plugin.accent, stroke: plugin.accent, color: colors.white }));
  return out.join("");
}

function tracesScene(plugin) {
  const out = [panel(330, 282, 520, 516, { fill: "#f4f6f8" }), panel(878, 282, 490, 516, { fill: "#ffffff" })];
  out.push(panelHeader("Session explorer", 358, 318));
  out.push(pill("INDEXED", 754, 298, { width: 76, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent }));
  out.push(rect(358, 342, 464, 36, colors.white, { stroke: colors.line, radius: 6 }));
  out.push(text("⌕", 374, 366, { size: 17, fill: colors.muted }));
  out.push(text("Search sessions, models, and tools", 400, 365, { size: 12, fill: colors.muted }));
  out.push(text("SOURCE", 358, 414, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 0.9 }));
  out.push(pill("All sources", 428, 397, { width: 98, fill: colors.white, stroke: colors.line, color: colors.text }));
  out.push(line(358, 442, 822, 442));
  const sessions = [
    ["Codex", "Migration review", "12m", "34 events"],
    ["Claude", "Investigate timeout", "1h", "18 events"],
    ["DSH", "Local model test", "3h", "9 events"],
    ["Pi", "Design sync", "yesterday", "42 events"],
  ];
  sessions.forEach(([source, label, time, events], index) => {
    const y = 480 + index * 66;
    const selected = index === 0;
    if (selected) out.push(rect(350, y - 25, 480, 54, plugin.soft, { radius: 7 }));
    out.push(circle(374, y - 5, 5, selected ? plugin.accent : colors.faint));
    out.push(text(source, 390, y - 8, { size: 10, fill: plugin.accent, weight: 800 }));
    out.push(text(label, 442, y - 8, { size: 13, fill: colors.text, weight: selected ? 700 : 550 }));
    out.push(text(events, 442, y + 12, { size: 10, fill: colors.muted }));
    out.push(text(time, 802, y - 8, { size: 10, fill: colors.muted, anchor: "end" }));
    if (index < sessions.length - 1) out.push(line(358, y + 28, 822, y + 28));
  });
  out.push(text("Trajectory", 906, 320, { size: 17, fill: colors.ink, weight: 750 }));
  out.push(pill("CODEX · 12M", 1258, 298, { width: 84, fill: plugin.soft, stroke: plugin.soft, color: plugin.accent, size: 10 }));
  out.push(text("Migration review", 906, 354, { size: 14, fill: colors.text, weight: 700 }));
  out.push(text("34 events · 2m 18s · model: gpt-5", 906, 376, { size: 11, fill: colors.muted }));
  out.push(line(906, 398, 1338, 398));
  const events = [["10:42:08", "message", "Plan the migration", colors.info], ["10:42:12", "tool", "rg --files packages", plugin.accent], ["10:42:17", "tool", "read README.md", plugin.accent], ["10:43:09", "message", "The rollback owner is the last open point.", colors.success]];
  events.forEach(([time, kind, label, color], index) => {
    const y = 438 + index * 64;
    out.push(circle(922, y - 5, 6, color));
    out.push(text(time, 944, y - 2, { size: 10, fill: colors.muted, family: "ui-monospace, SFMono-Regular, Menlo, monospace" }));
    out.push(pill(kind.toUpperCase(), 1044, y - 20, { width: kind === "message" ? 76 : 52, height: 21, fill: color === plugin.accent ? plugin.soft : "#eef2f5", stroke: "transparent", color, size: 9 }));
    out.push(text(label, 1132, y - 2, { size: 11, fill: colors.text, weight: kind === "message" ? 650 : 500 }));
    if (index < events.length - 1) out.push(line(922, y + 7, 922, y + 43, colors.line));
  });
  out.push(rect(906, 706, 432, 56, "#f4f6f8", { stroke: colors.line, radius: 7 }));
  out.push(text("Select an event to inspect its source payload.", 926, 739, { size: 11, fill: colors.muted }));
  return out.join("");
}

function uaFetchScene(plugin) {
  const out = [panel(330, 282, 1038, 516)];
  out.push(panelHeader("web_fetch", 358, 318));
  out.push(pill("200 OK", 1248, 298, { width: 72, fill: "#e4f3ea", stroke: "#c1dfcc", color: colors.success }));
  out.push(rect(358, 342, 760, 36, colors.white, { stroke: colors.line, radius: 6 }));
  out.push(codeLine("https://example.com/release-notes", 374, 365, { size: 12, fill: colors.text }));
  out.push(button("Fetch", 1132, 342, { width: 78, height: 36, fill: plugin.accent, stroke: plugin.accent, color: colors.white }));
  out.push(text("RESULT", 358, 416, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 0.9 }));
  out.push(text("served-as", 358, 452, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(text("GPTBot", 500, 452, { size: 14, fill: plugin.accent, weight: 800 }));
  out.push(text("strategy", 358, 488, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(text("learned", 500, 488, { size: 13, fill: colors.text, weight: 700 }));
  out.push(text("cache", 358, 524, { size: 11, fill: colors.muted, weight: 700 }));
  out.push(text("domain winner · fresh", 500, 524, { size: 13, fill: colors.text, weight: 650 }));
  out.push(line(358, 556, 744, 556));
  out.push(text("ATTEMPTS", 358, 586, { size: 10, fill: colors.faint, weight: 800, letterSpacing: 0.9 }));
  [["chrome", "challenge page", colors.danger], ["GPTBot", "real content", colors.success], ["xAI", "not needed", colors.muted]].forEach(([ua, status, color], index) => {
    const y = 620 + index * 38;
    out.push(dotLabel(ua, 358, y, color, { size: 12, weight: 650 }));
    out.push(text(status, 512, y, { size: 11, fill: color }));
  });
  out.push(line(790, 408, 790, 762));
  out.push(text("Response body", 824, 416, { size: 14, fill: colors.ink, weight: 750 }));
  out.push(text("truncated to 100 KB", 1336, 416, { size: 10, fill: colors.muted, anchor: "end" }));
  out.push(rect(824, 444, 484, 266, "#f7f9fa", { stroke: colors.line, radius: 7 }));
  out.push(text("Release notes", 850, 484, { size: 20, fill: colors.ink, weight: 750 }));
  out.push(text("What changed in the latest build", 850, 514, { size: 12, fill: colors.muted }));
  out.push(line(850, 534, 1282, 534));
  out.push(paragraph("This page was served as real content after the cached identity bypassed the browser challenge. The attempt trail stays attached to the result.", 850, 570, 416, { size: 13, fill: colors.text, lineHeight: 20 }));
  out.push(text("status", 850, 668, { size: 10, fill: colors.muted, weight: 700 }));
  out.push(codeLine("content returned", 904, 668, { size: 11, fill: colors.success }));
  out.push(button("Open raw body", 824, 732, { width: 112, height: 30, size: 11 }));
  out.push(text("Failure cache: 3 days", 956, 752, { size: 11, fill: colors.muted }));
  return out.join("");
}

for (const plugin of plugins) {
  const output = resolve(root, `packages/${plugin.package}/assets/staged-preview.svg`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${shell(plugin, scene(plugin))}\n`, "utf8");
}

console.log(`Generated ${plugins.length} staged plugin previews.`);
