import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SEEN_MESSAGES = 500;
const MAX_LOG_BYTES = 100 * 1024 * 1024;

// 本 skill 的所有状态都放在自己的目录下,不碰 ~/.codex 里的任何配置。
export function resolveHome(options = {}) {
  return (
    options.home ??
    process.env.WEXX_HOME ??
    path.join(os.homedir(), ".wexx")
  );
}

export function resolvePaths(options = {}) {
  const home = resolveHome(options);
  const userHome = options.userHome ?? os.homedir();
  return {
    home,
    accountFile: path.join(home, "account.json"),
    consentFile: path.join(home, "consent.json"),
    stateFile: path.join(home, "state.json"),
    pidFile: path.join(home, "daemon.pid"),
    logFile: path.join(home, "daemon.log"),
    launchdLogFile: path.join(home, "daemon-launchd.log"),
    qrPngFile: path.join(home, "login-qr.png"),
    codexHome: options.codexHome ?? process.env.CODEX_HOME ?? path.join(userHome, ".codex"),
    documentsCodexRoot:
      options.documentsCodexRoot ?? path.join(userHome, "Documents", "Codex"),
  };
}

export function readAccount(paths) {
  if (!existsSync(paths.accountFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(paths.accountFile, "utf8"));
    if (!parsed?.token || !parsed?.user_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAccount(paths, account) {
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(
    paths.accountFile,
    `${JSON.stringify({ ...account, saved_at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export function removeAccount(paths) {
  rmSync(paths.accountFile, { force: true });
}

// 放行模式的知情同意:只需同意一次,后续扫码(重连/换码/解绑后重绑)不再重复确认。
// 同意的对象是运行模式,不是某一次扫码,所以 unbind 不清除它。
export function readConsent(paths) {
  if (!existsSync(paths.consentFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(paths.consentFile, "utf8"));
    return parsed?.accepted_at ? parsed : null;
  } catch {
    return null;
  }
}

export function writeConsent(paths) {
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(
    paths.consentFile,
    `${JSON.stringify({ accepted_at: new Date().toISOString(), mode: "danger-full-access" }, null, 2)}\n`,
  );
}

export function emptyState() {
  return {
    conversations: {},
    seenMessageIds: [],
    getUpdatesBuf: "",
    updatedAt: null,
    version: 1,
  };
}

export function readState(paths) {
  if (!existsSync(paths.stateFile)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      conversations:
        parsed.conversations && typeof parsed.conversations === "object"
          ? parsed.conversations
          : {},
      seenMessageIds: Array.isArray(parsed.seenMessageIds)
        ? parsed.seenMessageIds.filter(Boolean).slice(-MAX_SEEN_MESSAGES)
        : [],
      getUpdatesBuf: typeof parsed.getUpdatesBuf === "string" ? parsed.getUpdatesBuf : "",
      updatedAt: parsed.updatedAt ?? null,
      version: 1,
    };
  } catch {
    return emptyState();
  }
}

export function writeState(paths, state) {
  mkdirSync(paths.home, { recursive: true });
  const next = {
    ...state,
    seenMessageIds: [...new Set(state.seenMessageIds ?? [])].slice(-MAX_SEEN_MESSAGES),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  const tempFile = `${paths.stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(next, null, 2)}\n`);
  // 原子替换,daemon 崩溃不会留下半截 state
  writeFileSync(paths.stateFile, readFileSync(tempFile));
  rmSync(tempFile, { force: true });
  return next;
}

export function markMessageSeen(state, messageId) {
  state.seenMessageIds = [...state.seenMessageIds, messageId].slice(-MAX_SEEN_MESSAGES);
}

// 日志封顶:daemon.log 超限时轮转为 .old(总占用 ≤ 2×上限);
// daemon-launchd.log 的 fd 被 launchd 以 O_APPEND 持有,rename 后旧 fd 仍会往
// 改名后的文件里写,所以只能原地 truncate。
export function rotateLogsIfNeeded(paths, maxBytes = MAX_LOG_BYTES) {
  const rotated = [];
  try {
    if (statSync(paths.logFile).size > maxBytes) {
      renameSync(paths.logFile, `${paths.logFile}.old`);
      rotated.push(paths.logFile);
    }
  } catch {
  }
  try {
    if (paths.launchdLogFile && statSync(paths.launchdLogFile).size > maxBytes) {
      truncateSync(paths.launchdLogFile, 0);
      rotated.push(paths.launchdLogFile);
    }
  } catch {
  }
  return rotated;
}

export function readDaemonPid(paths) {
  if (!existsSync(paths.pidFile)) return null;
  const pid = Number.parseInt(readFileSync(paths.pidFile, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function writeDaemonPid(paths, pid = process.pid) {
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(paths.pidFile, `${pid}\n`);
}
