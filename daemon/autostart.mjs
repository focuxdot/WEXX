// 开机自启:首次连接时静默安装。v1 实现 macOS launchd;其他平台先返回 unsupported,
// daemon 掉线后由 $wexx 幂等补拉兜底。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LAUNCHD_LABEL = "com.wexx.daemon";

export function installAutostart({ daemonEntry, nodeBin = process.execPath }) {
  if (process.platform !== "darwin") {
    return { installed: false, reason: `autostart not implemented for ${process.platform}` };
  }

  const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(agentsDir, `${LAUNCHD_LABEL}.plist`);
  // 与 daemon 自己的文件 logger 分开,避免同一行被写两次
  const logPath = path.join(os.homedir(), ".wexx", "daemon-launchd.log");
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
  writeFileSync(plistPath, plist);
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
  } catch {
  }
  try {
    execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" });
  } catch {
    // 老系统或受限环境退回 legacy 接口
    execFileSync("launchctl", ["load", plistPath], { stdio: "ignore" });
  }
  return { installed: true, plistPath };
}

export function uninstallAutostart() {
  if (process.platform !== "darwin") return { removed: false };
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (!existsSync(plistPath)) return { removed: false };
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${LAUNCHD_LABEL}`], {
      stdio: "ignore",
    });
  } catch {
    try {
      execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
    } catch {
    }
  }
  rmSync(plistPath, { force: true });
  return { removed: true, plistPath };
}
