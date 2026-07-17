import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_CODEX_BIN = "codex";

// launchd/开机自启环境的 PATH 极简,bare "codex" 找不到,必须解析为绝对路径。
export function resolveCodexBin(preferred) {
  const candidates = [preferred, process.env.WEXX_CODEX_BIN].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (existsSync(candidate)) return candidate;
    } else {
      const found = whichSafe(candidate);
      if (found) return found;
    }
  }
  const found = whichSafe("codex");
  if (found) return found;
  const home = os.homedir();
  const probes = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(home, ".codex", "bin", "codex"),
    path.join(home, ".local", "bin", "codex"),
    path.join(home, ".npm-global", "bin", "codex"),
  ];
  for (const probe of probes) {
    if (existsSync(probe)) return probe;
  }
  return "codex";
}

function whichSafe(name) {
  try {
    const result = execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
    return result && existsSync(result) ? result : null;
  } catch {
    return null;
  }
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.options = { codexBin: DEFAULT_CODEX_BIN, env: {}, ...options };
    this.child = null;
    this.loadedThreads = new Set();
    this.nextId = 1;
    this.pending = new Map();
    this.turnWaiters = new Map();
  }

  async connect() {
    if (this.child) return;

    // codex 可能是 "#!/usr/bin/env node" 脚本;launchd 环境 PATH 极简,
    // 把当前 node 的目录和常见 bin 目录补进子进程 PATH。
    const augmentedPath = [
      path.dirname(process.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      process.env.PATH ?? "",
    ]
      .filter(Boolean)
      .join(path.delimiter);

    this.child = spawn(this.options.codexBin, ["app-server"], {
      env: { ...process.env, ...this.options.env, PATH: augmentedPath },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (code=${code}, signal=${signal})`);
      this.rejectAll(error);
      this.child = null;
    });

    this.child.stderr.on("data", (chunk) => {
      this.options.log?.(`[app-server] ${String(chunk).trim()}`);
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "wexx",
        title: "wexx — WeChat Skill for Codex",
        version: "1.0.0",
      },
    });
    this.notify("initialized", {});
  }

  isThreadLoaded(threadId) {
    return this.loadedThreads.has(threadId);
  }

  async createThread(options = {}) {
    const result = await this.request("thread/start", buildThreadParams(options));
    this.loadedThreads.add(result.thread.id);
    return result.thread;
  }

  async resumeThread(threadId, options = {}) {
    const result = await this.request("thread/resume", {
      ...buildThreadParams(options),
      threadId,
    });
    this.loadedThreads.add(result.thread.id);
    return result.thread;
  }

  async setThreadName(threadId, name) {
    await this.request("thread/name/set", { name, threadId });
  }

  // 返回 { turnId, done }:turnId 立即可用于 /stop 中断,done 在 turn 结束时 resolve。
  async startTurn(threadId, input) {
    const result = await this.request("turn/start", { input, threadId });
    const turnId = result.turn.id;
    const waiter = this.turnWaiters.get(turnId) ?? createTurnWaiter();
    this.turnWaiters.set(turnId, waiter);
    return { turnId, done: waiter.promise };
  }

  async interruptTurn(threadId, turnId) {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  request(method, params) {
    if (!this.child?.stdin?.writable) {
      throw new Error("codex app-server is not connected");
    }
    const id = String(this.nextId++);
    const pending = deferred();
    this.pending.set(id, { ...pending, method });
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return pending.promise;
  }

  notify(method, params) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.options.log?.(`Ignoring non-JSON app-server output: ${line}`);
      return;
    }

    if (message.id && this.pending.has(String(message.id))) {
      const pending = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.id && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params ?? {});
    }
  }

  handleNotification(method, params) {
    if (method === "thread/started") {
      this.loadedThreads.add(params.thread.id);
      return;
    }

    if (method === "item/agentMessage/delta") {
      const waiter = this.turnWaiters.get(params.turnId);
      if (waiter) waiter.stream.push(params.delta);
      return;
    }

    if (method === "item/completed") {
      const waiter = this.turnWaiters.get(params.turnId);
      if (!waiter) return;
      const item = params.item;
      if (item?.type === "agentMessage") {
        if (item.phase === "final_answer" || item.phase == null) {
          waiter.finalText = item.text;
        } else {
          waiter.commentary.push(item.text);
        }
      }
      return;
    }

    if (method === "turn/completed") {
      const turnId = params.turn?.id;
      const waiter = this.turnWaiters.get(turnId);
      if (!waiter) return;
      this.turnWaiters.delete(turnId);
      if (params.turn.status === "completed") {
        waiter.resolve({
          interrupted: false,
          text:
            waiter.finalText ||
            waiter.stream.join("").trim() ||
            waiter.commentary.join("\n").trim(),
        });
      } else if (params.turn.status === "interrupted" || params.turn.status === "aborted") {
        waiter.resolve({ interrupted: true, text: "" });
      } else {
        waiter.reject(
          new Error(params.turn.error?.message ?? `turn ended with ${params.turn.status}`),
        );
      }
    }
  }

  handleServerRequest(message) {
    const decision = this.options.onServerRequest?.(message);
    if (decision) {
      this.child.stdin.write(`${JSON.stringify({ id: message.id, result: decision })}\n`);
      return;
    }
    this.child.stdin.write(
      `${JSON.stringify({
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
        id: message.id,
      })}\n`,
    );
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.pending.clear();
    this.turnWaiters.clear();
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.kill();
  }
}

// 在 CODEX_HOME/sessions 下按 threadId 找 rollout 文件,用于轮转时的惰性上下文指针。
// 找不到返回 null(指针只是增强,缺失时模型退化为自然反问)。
export function findRolloutPath(codexHome, threadId) {
  if (!codexHome || !threadId) return null;
  const sessionsDir = path.join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) return null;

  const matches = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
        matches.push(full);
      }
    }
  };
  walk(sessionsDir, 0);
  if (!matches.length) return null;
  matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return matches[0];
}

function buildThreadParams(options) {
  return {
    approvalPolicy: options.approvalPolicy,
    cwd: options.cwd,
    developerInstructions: options.developerInstructions,
    model: options.model ?? null,
    projectlessOutputDirectory: options.projectlessOutputDirectory,
    sandbox: options.sandbox,
    serviceName: options.serviceName,
    threadSource: options.threadSource,
    workspaceKind: options.workspaceKind,
    workspaceRoots: options.workspaceRoots,
  };
}

function createTurnWaiter() {
  return { commentary: [], finalText: "", stream: [], ...deferred() };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
