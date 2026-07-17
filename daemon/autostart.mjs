// 开机自启:按平台分发(参照 CXX 的 mac-agent/win-agent 拆分方式)。
// macOS -> launchd LaunchAgent(autostart-mac.mjs)
// Windows -> 任务计划程序(autostart-win.mjs)
// 其他平台返回 unsupported;daemon 掉线后由 $wexx 幂等补拉兜底。
import * as mac from "./autostart-mac.mjs";
import * as win from "./autostart-win.mjs";

function backend(platform = process.platform) {
  if (platform === "darwin") return mac;
  if (platform === "win32") return win;
  return null;
}

export function installAutostart(options) {
  const impl = backend();
  if (!impl) {
    return { installed: false, reason: `autostart not implemented for ${process.platform}` };
  }
  return impl.installAutostart(options);
}

export function uninstallAutostart(options) {
  const impl = backend();
  if (!impl) return { removed: false };
  return impl.uninstallAutostart(options);
}
