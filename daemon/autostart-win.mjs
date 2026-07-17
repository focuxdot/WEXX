// Windows 开机自启:任务计划程序(Task Scheduler)。
// 契约与 autostart-mac.mjs 一致:install/uninstall,执行器可注入(单测不碰系统)。
//
// 对应关系(参照 CXX 的 win-agent):
//   launchd RunAtLoad            -> LogonTrigger(登录即启动)
//   launchd KeepAlive            -> RestartOnFailure(1 分钟间隔,重试 999 次)
//   后台无窗运行                  -> wscript.exe + run-hidden.vbs 包装(node 是控制台程序,
//                                   直接由计划任务拉起会闪黑窗)
// 日志:Windows 下没有 launchd 那样的 stdout 重定向,daemon.log(文件 logger)即全部日志。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TASK_NAME = "WexxDaemon";

const DEFAULT_VBS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "shell",
  "windows",
  "run-hidden.vbs",
);

function escapeXml(value) {
  return String(value).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function quote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

// whoami 用 OEM 代码页输出,非 ASCII 用户名会被 UTF-8 解码弄坏;
// 环境变量是 Unicode,作为稳妥来源(CXX 用 PowerShell 取规范名,这里从简)。
function currentUserId(env = process.env) {
  const authority = String(env.USERDOMAIN || env.COMPUTERNAME || ".").trim() || ".";
  const username = String(env.USERNAME || "user").trim() || "user";
  return `${authority}\\${username}`;
}

export function buildTaskXml({ nodeBin, daemonEntry, workingDir, userId, vbsPath }) {
  // wscript run-hidden.vbs <exe> <workdir> <args...>
  const taskArgs = [vbsPath, nodeBin, workingDir, daemonEntry].map(quote).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>wexx daemon (WeChat x Codex)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>${escapeXml(taskArgs)}</Arguments>
      <WorkingDirectory>${escapeXml(workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function defaultRunSchtasks(args) {
  return spawnSync("schtasks", args, { encoding: "utf8", windowsHide: true });
}

export function installAutostart({
  daemonEntry,
  nodeBin = process.execPath,
  homeDir = os.homedir(),
  env = process.env,
  vbsPath = DEFAULT_VBS,
  runSchtasks = defaultRunSchtasks,
}) {
  if (!existsSync(vbsPath)) {
    return { installed: false, reason: `hidden launcher not found: ${vbsPath}` };
  }
  const stateDir = path.join(homeDir, ".wexx");
  mkdirSync(stateDir, { recursive: true });
  const xmlPath = path.join(stateDir, "autostart-task.xml");
  const xml = buildTaskXml({
    nodeBin,
    daemonEntry,
    workingDir: path.dirname(daemonEntry),
    userId: currentUserId(env),
    vbsPath,
  });
  // schtasks /XML 要求 UTF-16LE 带 BOM
  writeFileSync(xmlPath, `\ufeff${xml}`, "utf16le");

  const created = runSchtasks(["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
  if (created.status !== 0) {
    const reason = String(created.stderr || created.stdout || "schtasks create failed").trim();
    return { installed: false, reason };
  }
  runSchtasks(["/Run", "/TN", TASK_NAME]);
  return { installed: true, taskName: TASK_NAME, xmlPath };
}

export function uninstallAutostart({ runSchtasks = defaultRunSchtasks } = {}) {
  runSchtasks(["/End", "/TN", TASK_NAME]);
  const deleted = runSchtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
  return { removed: deleted.status === 0, taskName: TASK_NAME };
}
