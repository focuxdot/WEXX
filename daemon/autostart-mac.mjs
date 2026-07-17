// macOS 开机自启:launchd LaunchAgent。
// 契约与 autostart-win.mjs 一致:install/uninstall,执行器可注入(单测不碰系统)。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const LAUNCHD_LABEL = "com.wexx.daemon";

function defaultRunLaunchctl(args) {
  execFileSync("launchctl", args, { stdio: "ignore" });
}

export function installAutostart({
  daemonEntry,
  nodeBin = process.execPath,
  homeDir = os.homedir(),
  runLaunchctl = defaultRunLaunchctl,
  writeFile = writeFileSync,
}) {
  const agentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const plistPath = path.join(agentsDir, `${LAUNCHD_LABEL}.plist`);
  // 与 daemon 自己的文件 logger 分开,避免同一行被写两次
  const logPath = path.join(homeDir, ".wexx", "daemon-launchd.log");
  mkdirSync(agentsDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${daemonEntry}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
  writeFile(plistPath, plist);
  const domain = `gui/${process.getuid()}`;
  try {
    runLaunchctl(["bootout", `${domain}/${LAUNCHD_LABEL}`]);
  } catch {
  }
  try {
    runLaunchctl(["bootstrap", domain, plistPath]);
  } catch {
    // 老系统或受限环境退回 legacy 接口
    runLaunchctl(["load", plistPath]);
  }
  return { installed: true, plistPath };
}

export function uninstallAutostart({
  homeDir = os.homedir(),
  runLaunchctl = defaultRunLaunchctl,
} = {}) {
  const plistPath = path.join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (!existsSync(plistPath)) return { removed: false };
  try {
    runLaunchctl(["bootout", `gui/${process.getuid()}/${LAUNCHD_LABEL}`]);
  } catch {
    try {
      runLaunchctl(["unload", plistPath]);
    } catch {
    }
  }
  rmSync(plistPath, { force: true });
  return { removed: true, plistPath };
}
