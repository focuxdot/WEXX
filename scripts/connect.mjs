#!/usr/bin/env node
// $wexx 的幂等入口。四种状态一条命令覆盖:
//   未绑定 -> 提示需要 login;绑定+daemon 活 -> 报状态;绑定+daemon 死 -> 静默补拉;
//   login --yes -> 扫码绑定 + 安装自启 + 起 daemon;unbind/stop -> 解绑/停止。
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { installAutostart, uninstallAutostart } from "../daemon/autostart.mjs";
import { fetchLoginQr, waitForLoginConfirm } from "../daemon/ilink.mjs";
import {
  readAccount,
  readConsent,
  readDaemonPid,
  readState,
  removeAccount,
  resolvePaths,
  writeAccount,
  writeConsent,
} from "../daemon/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON_ENTRY = path.join(ROOT, "daemon", "main.mjs");

const [subcommand = "status", ...rest] = process.argv.slice(2);
const flags = new Set(rest);
const paths = resolvePaths();

try {
  if (subcommand === "status") await status();
  else if (subcommand === "login") await login();
  else if (subcommand === "stop") await stopDaemon();
  else if (subcommand === "unbind") await unbind();
  else {
    console.log(`未知子命令: ${subcommand}。可用: status | login --yes | stop | unbind`);
    process.exitCode = 2;
  }
} catch (error) {
  console.log(`出错: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function status() {
  const account = readAccount(paths);
  if (!account) {
    console.log("状态: 未绑定微信。");
    if (readConsent(paths)) {
      console.log("授权: 用户此前已同意放行模式,无需再次确认。");
      console.log("下一步: 直接执行 `node scripts/connect.mjs login` 发起扫码。");
    } else {
      console.log("授权: 首次绑定,需先向用户说明放行模式并获得明确同意。");
      console.log("下一步: 用户同意后执行 `node scripts/connect.mjs login --yes`。");
    }
    return;
  }

  let pid = readDaemonPid(paths);
  let revived = false;
  if (!pid) {
    pid = startDaemonDetached();
    revived = true;
    await delay(1500);
  }

  const state = readState(paths);
  const conversations = Object.values(state.conversations ?? {});
  const lastActivity = conversations
    .map((conversation) => conversation.lastMessageAt)
    .filter(Boolean)
    .sort()
    .pop();

  console.log(`状态: 已绑定微信(用户 ${maskId(account.user_id)})。`);
  console.log(
    revived
      ? `daemon: 之前未在运行,已重新拉起(pid ${pid})。`
      : `daemon: 运行中(pid ${pid})。`,
  );
  console.log(`会话数: ${conversations.length}${lastActivity ? `,最后活动 ${lastActivity}` : ""}`);
  console.log("在手机微信里给绑定的 bot 发消息即可派活;发送“帮助”查看微信内指令。");
}

async function login() {
  if (readAccount(paths)) {
    console.log("已绑定微信。如需换号,先执行 unbind。");
    return status();
  }
  // 首次需 --yes(模型确认用户已同意);同意过一次后永久免确认。
  if (!flags.has("--yes") && !readConsent(paths)) {
    console.log("安全确认缺失:首次绑定需要 --yes。");
    console.log("请先向用户说明:微信远程会话将以完全放行模式运行(不逐条审批,可读写文件和联网),");
    console.log("获得用户明确同意后,再执行 `node scripts/connect.mjs login --yes`。");
    process.exitCode = 3;
    return;
  }
  writeConsent(paths);

  console.log("正在获取微信登录二维码…");
  const { payload, qrcode } = await fetchLoginQr();
  await presentQr(payload);

  const account = await waitForLoginConfirm({
    onEvent: async (event) => {
      if (event.kind === "awaiting_scan") console.log("已扫码,请在手机上确认…");
      if (event.kind === "qr_refreshing") {
        console.log("二维码已过期,已刷新:");
        await presentQr(event.payload);
      }
    },
    payload,
    qrcode,
    timeoutMs: 300_000,
  });

  writeAccount(paths, account);
  rmSync(paths.qrPngFile, { force: true });

  const autostart = installAutostart({ daemonEntry: DAEMON_ENTRY });
  const pid = startDaemonDetached();

  console.log(`绑定成功(微信用户 ${maskId(account.user_id)})。`);
  console.log(`daemon 已启动(pid ${pid})${autostart.installed ? ",并已设置开机自启。" : "。"}`);
  console.log("重要: 第一条消息必须由用户在微信里主动发起(任意内容),用于创建会话;");
  console.log("用户会收到问候语和常用指令说明,之后即可直接派活。请把这一点转告用户。");
}

async function stopDaemon() {
  const pid = readDaemonPid(paths);
  if (!pid) {
    console.log("daemon 未在运行。");
    return;
  }
  process.kill(pid, "SIGTERM");
  console.log(`已停止 daemon(pid ${pid})。注意:开机自启仍在,重启后会自动恢复;彻底移除请用 unbind。`);
}

async function unbind() {
  const pid = readDaemonPid(paths);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
  }
  uninstallAutostart();
  removeAccount(paths);
  console.log("已解绑微信并移除开机自启。重新绑定请再次执行连接流程。");
}

async function presentQr(payload) {
  // 终端 ANSI 二维码 + PNG 双保险(部分终端/主题下 ANSI 块渲染不佳)
  try {
    console.log(await QRCode.toString(payload, { errorCorrectionLevel: "M", small: true, type: "terminal" }));
  } catch {
  }
  try {
    await QRCode.toFile(paths.qrPngFile, payload, { errorCorrectionLevel: "M", margin: 1, width: 320 });
    console.log(`二维码图片: ${paths.qrPngFile}`);
    if (process.platform === "darwin") {
      spawn("open", [paths.qrPngFile], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      // start 的第一个引号参数是窗口标题,占位空串防止路径被当标题
      spawn("cmd.exe", ["/c", "start", "", paths.qrPngFile], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    }
  } catch {
  }
  console.log("请用绑定微信扫描上方二维码(5 分钟内有效)…");
}

function startDaemonDetached() {
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function maskId(value) {
  const id = String(value ?? "");
  if (id.length <= 6) return id;
  return `${id.slice(0, 3)}***${id.slice(-3)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
