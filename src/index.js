// terminal-notify for opencode: desktop notifications through the terminal
// when opencode finishes, asks a question or needs a permission.
//
// The counterpart of github.com/4nuva/claude-terminal-notify: the wording,
// secret masking, terminal detection and options are the same. opencode gives
// plugins no terminalSequence channel, so the sequence is written to the
// session's own terminal (fd 1).
//
// A notification must never get in the way of a session: every handler
// catches its own errors, and nothing is written when anything goes wrong.
import { appendFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ESC = "\x1b";
const BEL = "\x07";
const ST = ESC + "\\";
const NAME = "opencode";

const FORMATS = ["auto", "osc777", "osc9", "osc99", "all", "bell", "off"];

// Known key and token shapes, masked before any text leaves the session:
// a notification can land on a lock screen or a paired phone.
const SECRETS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@/gi, // credentials in a URL
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /\b(api[_-]?key|token|secret|password|passwd|pwd|authorization)(\s*[=:]\s*)\S+/gi,
  /\b[A-Za-z0-9+\/_-]{40,}={0,2}/g,
];

function mask(s) {
  for (const re of SECRETS) {
    s = s.replace(re, (m, key, sep) =>
      typeof key === "string" && typeof sep === "string" ? `${key}${sep}***` : "***");
  }
  return s;
}

// One line of plain text: no control characters (C0, DEL, C1), so nothing in
// it can end the escape sequence early or start another one.
function clean(s) {
  s = String(s == null ? "" : s)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return mask(s).replace(/\s+/g, " ").trim();
}

function cap(s, n) {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n - 1).join("") + "…";
}

// The first sentences of a reply, without code blocks or inline code.
function firstSentences(text, count) {
  let t = String(text || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1");
  t = clean(t);
  if (!t) return "";
  const parts = t.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [t];
  return parts.slice(0, count).join(" ").trim();
}

// The part of a tool call worth naming: its command, file, URL, ...
function summarize(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ["command", "file_path", "path", "url", "pattern", "query", "description", "prompt"]) {
    if (typeof input[k] === "string" && input[k]) return input[k];
  }
  for (const v of Object.values(input)) if (typeof v === "string" && v) return v;
  return "";
}

// An option, shared with the Claude Code plugin so both read the same setting:
// TERMINAL_NOTIFY_FORMAT, TERMINAL_NOTIFY_DETAILS, TERMINAL_NOTIFY_IDLE_REMINDER.
function option(env, key, fallback) {
  const k = key.toUpperCase();
  for (const name of [`CLAUDE_PLUGIN_OPTION_${k}`, `CLAUDE_PLUGIN_OPTION_${key}`, `TERMINAL_NOTIFY_${k}`]) {
    const v = env[name];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return fallback;
}

function flag(env, key, fallback) {
  const v = option(env, key, "");
  if (!v) return fallback;
  return !/^(0|false|no|off)$/i.test(v);
}

// Which sequence the terminal shows as a notification.
function detectFormat(env) {
  const program = String(env.TERM_PROGRAM || "").toLowerCase();
  const term = String(env.TERM || "").toLowerCase();
  // Agent Terminal shows OSC 777 with its title and body, and forwards it to
  // the phones paired with it.
  if (env.AGENT_TERMINAL_SESSION_ID) return "osc777";
  if (env.KITTY_WINDOW_ID || term === "xterm-kitty") return "osc99";
  if (program === "ghostty" || env.GHOSTTY_RESOURCES_DIR || program === "warpterminal" || term.includes("rxvt")) {
    return "osc777";
  }
  if (program === "iterm.app" || program === "wezterm" || env.WT_SESSION || env.ConEmuPID) return "osc9";
  // Terminals with no notification sequence: the bell at least gets a look.
  if (program === "apple_terminal" || program === "vscode") return "bell";
  return "osc9";
}

function sequence(format, title, body) {
  switch (format) {
    case "osc777":
      // `;` separates the fields, so neither part may hold one.
      return `${ESC}]777;notify;${title.replace(/;/g, ",")};${body.replace(/;/g, ",")}${BEL}`;
    case "osc9": {
      // A body that starts with a number reads as a ConEmu command (`9;4`
      // progress, ...).
      let text = `${title}: ${body}`;
      if (/^[\s᠎​]*[+-]?\p{Nd}/u.test(text)) text = `· ${text}`;
      return `${ESC}]9;${text}${BEL}`;
    }
    case "osc99":
      return `${ESC}]99;;${`${title}: ${body}`.replace(/;/g, ",")}${ST}`;
    case "all":
      // Every notification sequence, for a terminal the detection does not
      // know. A terminal that reads more than one shows more than one. 777
      // goes last: Agent Terminal keeps the last notice of a burst, and 777
      // is the one that carries the title.
      return ["osc9", "osc99", "osc777"].map((f) => sequence(f, title, body)).join("");
    case "bell":
      return BEL;
    default:
      return null;
  }
}

// The selected format, computed per notification so environment changes are
// always seen.
function pickFormat(env) {
  const chosen = option(env, "format", "auto").toLowerCase();
  const format = FORMATS.includes(chosen) ? chosen : "auto";
  return format === "auto" ? detectFormat(env) : format;
}

// The notification for an event, shaped like the Claude Code hook's input so
// the wording can stay exactly the same.
function build(p, env) {
  if (!p || typeof p !== "object") return null;
  // A subagent's work is not the person's turn: only the main agent notifies.
  if (p.agent_id) return null;
  const details = flag(env, "details", true);
  const ev = p.hook_event_name;
  let body;
  if (ev === "Stop") {
    let ctx = "";
    if (details) {
      try {
        ctx = firstSentences(p.last_assistant_message, 2);
      } catch { ctx = ""; }
    }
    body = "Task complete" + (ctx ? `: ${ctx}` : "");
  } else if (ev === "PermissionRequest") {
    const tool = clean(p.tool_name) || "a tool";
    const sum = details ? cap(clean(summarize(p.tool_input)), 80) : "";
    body = `Permission needed: ${tool}` + (sum ? ` — ${sum}` : "");
  } else if (ev === "PreToolUse" && p.tool_name === "AskUserQuestion") {
    const qs = p.tool_input && p.tool_input.questions;
    const q = details ? clean(Array.isArray(qs) && qs[0] ? qs[0].question : "") : "";
    body = "Question" + (q ? `: ${q}` : " waiting");
  } else if (ev === "Notification" && p.notification_type === "idle_prompt") {
    if (!flag(env, "idle_reminder", false)) return null;
    body = "Waiting for input";
  } else {
    return null;
  }
  const folder = path.basename(String(p.cwd || "").replace(/[\\/]+$/, "")) || NAME;
  const title = cap(clean(`${NAME} · ${folder}`), 80);
  return { title, body: cap(clean(body), 200) };
}

function diag(line) {
  const target = process.env.ATN_DEBUG;
  if (!target) return;
  try {
    appendFileSync(target === "1" ? path.join(tmpdir(), "agent-terminal-notify.log") : target,
      `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function writeSequence(seq) {
  if (!seq) return;
  if (process.env.ATN_OUT) {
    try {
      appendFileSync(process.env.ATN_OUT, seq);
      return;
    } catch {}
  }
  // fd 1 directly: the TUI owns process.stdout, but the session's terminal is
  // still fd 1.
  const buf = Buffer.from(seq, "utf8");
  try {
    writeSync(1, buf);
    return;
  } catch (e) {
    diag(`fd1 write failed: ${(e && e.code) || e}`);
  }
  try {
    process.stdout.write(buf);
  } catch {}
}

export const TerminalNotify = async (ctx) => {
  const env = process.env;
  const cwd = ctx.worktree || ctx.directory || "";
  const subagents = new Set();
  const roles = new Map();
  const lastAssistant = new Map();
  const parts = new Map();
  const lastStop = new Map();
  const lastQuestion = new Map();
  const statusBySession = new Map();
  const reminders = new Map();

  function sessionText(sid) {
    const mid = lastAssistant.get(sid);
    if (!mid) return "";
    const m = parts.get(mid);
    if (!m) return "";
    return Array.from(m.values()).join("\n");
  }

  function emit(p) {
    const n = build(p, env);
    if (!n) return;
    const format = pickFormat(env);
    const seq = sequence(format, n.title, n.body);
    if (!seq) return;
    diag(`notify ${format} ${p.hook_event_name} pid=${process.pid} tty=${process.stdout.isTTY}`);
    writeSequence(seq);
  }

  function agentTag(sid) {
    return sid && subagents.has(sid) ? sid : undefined;
  }

  function notifyStop(sid) {
    const now = Date.now();
    if (now - (lastStop.get(sid) || 0) < 3000) return;
    lastStop.set(sid, now);
    emit({
      hook_event_name: "Stop",
      cwd,
      last_assistant_message: sessionText(sid),
      agent_id: agentTag(sid),
    });
  }

  function notifyQuestion(sid, questions) {
    const now = Date.now();
    if (now - (lastQuestion.get(sid) || 0) < 5000) return;
    lastQuestion.set(sid, now);
    emit({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions },
      cwd,
      agent_id: agentTag(sid),
    });
  }

  function clearReminder(sid) {
    const t = reminders.get(sid);
    if (t) {
      clearTimeout(t);
      reminders.delete(sid);
    }
  }

  // `idle_reminder`: notify again when a question or permission has waited a
  // minute for a reply. Any turn activity clears it.
  function armReminder(sid) {
    if (!sid || !flag(env, "idle_reminder", false)) return;
    clearReminder(sid);
    const t = setTimeout(() => {
      reminders.delete(sid);
      emit({
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
        cwd,
        agent_id: agentTag(sid),
      });
    }, 60000);
    t.unref?.();
    reminders.set(sid, t);
  }

  diag(`loaded pid=${process.pid} tty=${process.stdout.isTTY} format=${pickFormat(env)} cwd=${cwd}`);

  return {
    event: async ({ event }) => {
      try {
        const e = event || {};
        const p = e.properties || {};
        const type = e.type;
        const sid = p.sessionID || (p.info && p.info.id);

        if (sid && (type === "permission.replied" || type === "question.replied" ||
            type === "question.v2.replied")) {
          clearReminder(sid);
        }

        if (type === "session.created" || type === "session.updated") {
          const info = p.info || {};
          if (info.id && info.parentID) subagents.add(info.id);
          return;
        }

        if (type === "message.updated") {
          const info = p.info || {};
          if (info.id) {
            roles.set(info.id, info.role);
            if (info.role === "assistant" && info.sessionID) {
              const old = lastAssistant.get(info.sessionID);
              if (old && old !== info.id) parts.delete(old);
              lastAssistant.set(info.sessionID, info.id);
            }
          }
          return;
        }

        if (type === "message.part.updated") {
          const part = p.part || {};
          if (part.type === "text" && !part.synthetic && !part.ignored && part.text &&
              roles.get(part.messageID) === "assistant") {
            let m = parts.get(part.messageID);
            if (!m) {
              m = new Map();
              parts.set(part.messageID, m);
            }
            m.set(part.id || part.messageID, part.text);
          }
          return;
        }

        if (type === "permission.asked") {
          if (sid && subagents.has(sid)) return;
          const tool = p.permission || "a tool";
          const patterns = Array.isArray(p.patterns) ? p.patterns : [];
          emit({
            hook_event_name: "PermissionRequest",
            tool_name: tool,
            tool_input: { command: patterns[0] || "" },
            cwd,
            agent_id: agentTag(sid),
          });
          armReminder(sid);
          return;
        }

        if (type === "question.asked" || type === "question.v2.asked") {
          if (sid && subagents.has(sid)) return;
          notifyQuestion(sid, Array.isArray(p.questions) ? p.questions : []);
          armReminder(sid);
          return;
        }

        if (type === "session.status") {
          const cur = p.status && p.status.type;
          if (cur === "busy") clearReminder(sid);
          if (cur === "idle") {
            clearReminder(sid);
            if (statusBySession.get(sid) === "busy") notifyStop(sid);
          }
          if (sid) statusBySession.set(sid, cur);
          return;
        }

        if (type === "session.idle") {
          clearReminder(sid);
          notifyStop(sid);
        }
      } catch {}
    },

    "tool.execute.before": async (input, output) => {
      try {
        if (!input || input.tool !== "question") return;
        const sid = input.sessionID;
        if (sid && subagents.has(sid)) return;
        const qs = output && output.args && output.args.questions;
        notifyQuestion(sid, Array.isArray(qs) ? qs : []);
        armReminder(sid);
      } catch {}
    },
  };
};
