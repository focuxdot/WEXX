#!/usr/bin/env node
// WeChat-Codex daemon:轮询 iLink 消息,驱动本机 codex app-server。
// 由 skill 的 connect 脚本或 launchd 拉起,独立于 Codex 会话存活。
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { CodexAppServerClient, resolveCodexBin } from "./app-server.mjs";
import { WechatCodexRunner } from "./core.mjs";
import { IlinkClient } from "./ilink.mjs";
import {
  readAccount,
  readDaemonPid,
  resolvePaths,
  rotateLogsIfNeeded,
  writeDaemonPid,
} from "./state.mjs";

// 顶层代码会立即调用 installFileLogger,声明必须在其之前(TDZ)
let logFilePath = null;
let logWritesSinceRotateCheck = 0;

const options = parseArgs(process.argv.slice(2));
const paths = resolvePaths(options);
installFileLogger(paths.logFile);
rotateLogsIfNeeded(paths);

const account = readAccount(paths);
if (!account) {
  // 以 0 退出:launchd KeepAlive(SuccessfulExit=false)下避免无绑定时的重启循环
  log("No bound WeChat account. Run the skill connect flow first.");
  process.exit(0);
}

// 单实例锁:自启服务与手动拉起可能同时发生,两个实例会互踩消息 cursor。
// 已有活实例时静默让位(exit 0,不触发 KeepAlive 重启)。
const existingPid = readDaemonPid(paths);
if (existingPid && existingPid !== process.pid) {
  log(`daemon already running (pid ${existingPid}); this instance exits.`);
  process.exit(0);
}

writeDaemonPid(paths);

const runner = new WechatCodexRunner({
  boundUserId: account.user_id,
  codexClient: new CodexAppServerClient({
    codexBin: resolveCodexBin(options.codexBin),
    log,
  }),
  options: { ...options, log },
  paths,
  wechatClient: new IlinkClient({ baseUrl: account.base_url, token: account.token }),
});

let stopping = false;
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

try {
  await runner.connect();
  log(`daemon started. bound_user=${account.user_id} state=${paths.stateFile}`);

  if (options.once) {
    const results = await runner.pollOnce();
    for (const result of results) console.log(JSON.stringify(result));
  } else {
    while (!stopping) {
      try {
        const results = await runner.pollOnce();
        // 每条消息的路由结果都记日志(仅状态,不含消息内容),便于排查
        for (const result of results) log(JSON.stringify(result));
        await delay(options.pollIntervalMs ?? 3000);
      } catch (error) {
        log(`poll error: ${error instanceof Error ? error.message : String(error)}`);
        await delay(options.retryDelayMs ?? 10_000);
      }
    }
  }
} catch (error) {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await runner.close();
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}, stopping.`);
  try {
    await runner.close();
  } finally {
    process.exit(0);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") parsed.once = true;
    else if (arg === "--verbose") parsed.verbose = true;
    else if (arg === "--home") parsed.home = argv[++i];
    else if (arg === "--codex-bin") parsed.codexBin = argv[++i];
    else if (arg === "--poll-interval-ms") parsed.pollIntervalMs = Number.parseInt(argv[++i], 10);
    else if (arg === "--idle-rotation-ms") parsed.idleRotationMs = Number.parseInt(argv[++i], 10);
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installFileLogger(filePath) {
  logFilePath = filePath;
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.error(line);
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, `${line}\n`);
      // 长期运行时也要封顶,不能只靠启动检查;stat 便宜但没必要每行做
      if ((logWritesSinceRotateCheck += 1) >= 500) {
        logWritesSinceRotateCheck = 0;
        rotateLogsIfNeeded(paths);
      }
    } catch {
    }
  }
}
