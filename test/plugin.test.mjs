import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";

import { TerminalNotify } from "../src/index.js";

const ESC = "\x1b";
const BEL = "\x07";

// Every variable the plugin reads, saved and cleared around each test so the
// machine that runs the tests cannot change their result.
const KEYS = [
  "AGENT_TERMINAL_SESSION_ID",
  "ConEmuPID",
  "GHOSTTY_RESOURCES_DIR",
  "KITTY_WINDOW_ID",
  "TERM",
  "TERM_PROGRAM",
  "WT_SESSION",
  "TERMINAL_NOTIFY_FORMAT",
  "TERMINAL_NOTIFY_DETAILS",
  "TERMINAL_NOTIFY_IDLE_REMINDER",
  "CLAUDE_PLUGIN_OPTION_FORMAT",
  "CLAUDE_PLUGIN_OPTION_DETAILS",
  "CLAUDE_PLUGIN_OPTION_IDLE_REMINDER",
  "ATN_OUT",
  "ATN_DEBUG",
];

let dir;
let out;
let saved;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  dir = mkdtempSync(path.join(tmpdir(), "terminal-notify-"));
  out = path.join(dir, "out.txt");
  process.env.ATN_OUT = out;
  process.env.TERMINAL_NOTIFY_FORMAT = "osc777";
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

function emitted(file = out) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function count(text, part) {
  return text.split(part).length - 1;
}

async function load(options = {}) {
  return TerminalNotify({
    directory: options.directory ?? "/work/my-app",
    worktree: options.worktree,
  });
}

const permission = (properties = {}) => ({
  event: {
    type: "permission.asked",
    properties: { sessionID: "s1", permission: "bash", patterns: [], ...properties },
  },
});

const status = (type, sessionID = "s1") => ({
  event: { type: "session.status", properties: { sessionID, status: { type } } },
});

test("the package exposes only the plugin factory", async () => {
  const mod = await import("../src/index.js");
  assert.deepEqual(Object.keys(mod), ["TerminalNotify"]);
});

test("a permission request notifies with the tool and command", async () => {
  const plugin = await load();
  await plugin.event(permission({ patterns: ["npm run deploy"] }));
  assert.equal(
    emitted(),
    `${ESC}]777;notify;opencode · my-app;Permission needed: bash — npm run deploy${BEL}`,
  );
});

test("the question tool notifies once with its matching event", async () => {
  const plugin = await load();
  const questions = [{ question: "Which database should I use?" }];
  await plugin["tool.execute.before"]({ tool: "question", sessionID: "s1" }, { args: { questions } });
  await plugin.event({ event: { type: "question.asked", properties: { sessionID: "s1", questions } } });
  assert.equal(count(emitted(), "Question: Which database should I use?"), 1);
});

test("a busy turn that goes idle notifies with the reply, once", async () => {
  const plugin = await load();
  await plugin.event(status("busy"));
  await plugin.event({
    event: {
      type: "message.updated",
      properties: { info: { id: "m1", role: "assistant", sessionID: "s1" } },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: { part: { id: "p1", messageID: "m1", type: "text", text: "Fixed it. Tests pass." } },
    },
  });
  await plugin.event(status("idle"));
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(count(emitted(), "Task complete: Fixed it. Tests pass."), 1);
});

test("subagents do not notify", async () => {
  const plugin = await load();
  await plugin.event({
    event: { type: "session.created", properties: { info: { id: "a1", parentID: "s1" } } },
  });
  await plugin.event(permission({ sessionID: "a1" }));
  await plugin.event(status("busy", "a1"));
  await plugin.event(status("idle", "a1"));
  assert.equal(emitted(), "");
});

test("secrets are masked", async () => {
  const plugin = await load();
  await plugin.event(
    permission({ patterns: ["deploy ghp_abcdefghijklmnopqrstuvwxyz012345 API_KEY=sk-abcdef123456"] }),
  );
  assert.match(emitted(), /deploy \*\*\* API_KEY=\*\*\*/);
});

test("details off keeps reply text and commands out", async () => {
  process.env.TERMINAL_NOTIFY_DETAILS = "false";
  const plugin = await load();
  await plugin.event(permission({ patterns: ["npm run deploy"] }));
  await plugin["tool.execute.before"](
    { tool: "question", sessionID: "s1" },
    { args: { questions: [{ question: "Which database?" }] } },
  );
  assert.equal(
    emitted(),
    `${ESC}]777;notify;opencode · my-app;Permission needed: bash${BEL}` +
      `${ESC}]777;notify;opencode · my-app;Question waiting${BEL}`,
  );
});

test("format off writes nothing", async () => {
  process.env.TERMINAL_NOTIFY_FORMAT = "off";
  const plugin = await load();
  await plugin.event(permission());
  assert.equal(emitted(), "");
});

test("auto picks the sequence from the terminal", async () => {
  delete process.env.TERMINAL_NOTIFY_FORMAT;
  process.env.AGENT_TERMINAL_SESSION_ID = "abc";
  await (await load()).event(permission());
  assert.match(emitted(), new RegExp(`^${ESC}\\]777;notify;`));

  process.env.ATN_OUT = path.join(dir, "windows-terminal.txt");
  delete process.env.AGENT_TERMINAL_SESSION_ID;
  process.env.WT_SESSION = "abc";
  await (await load()).event(permission());
  assert.match(emitted(process.env.ATN_OUT), new RegExp(`^${ESC}\\]9;`));

  process.env.ATN_OUT = path.join(dir, "mac-terminal.txt");
  delete process.env.WT_SESSION;
  process.env.TERM_PROGRAM = "Apple_Terminal";
  await (await load()).event(permission());
  assert.equal(emitted(process.env.ATN_OUT), BEL);
});

test("the idle reminder repeats after a minute", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    process.env.TERMINAL_NOTIFY_IDLE_REMINDER = "true";
    const plugin = await load();
    await plugin.event(permission());
    assert.equal(count(emitted(), "Permission needed: bash"), 1);
    mock.timers.tick(60000);
    assert.equal(count(emitted(), "Waiting for input"), 1);
    mock.timers.tick(60000);
    assert.equal(count(emitted(), "Waiting for input"), 1);
  } finally {
    mock.timers.reset();
  }
});

test("a reply cancels the idle reminder", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    process.env.TERMINAL_NOTIFY_IDLE_REMINDER = "true";
    const plugin = await load();
    await plugin.event(permission());
    await plugin.event({ event: { type: "permission.replied", properties: { sessionID: "s1" } } });
    mock.timers.tick(60000);
    assert.equal(count(emitted(), "Waiting for input"), 0);
  } finally {
    mock.timers.reset();
  }
});
