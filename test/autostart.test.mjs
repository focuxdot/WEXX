import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as win from "../daemon/autostart-win.mjs";
import * as mac from "../daemon/autostart-mac.mjs";
import { codexProbePaths } from "../daemon/app-server.mjs";

function tmpdir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wexx-autostart-"));
  return { dir, cleanup: () => rmSync(dir, { force: true, recursive: true }) };
}

test("win: install writes UTF-16LE task xml and creates+runs the task", () => {
  const { dir, cleanup } = tmpdir();
  try {
    const vbsPath = path.join(dir, "run-hidden.vbs");
    writeFileSync(vbsPath, "' stub");
    const calls = [];
    const result = win.installAutostart({
      daemonEntry: path.join(dir, "daemon", "main.mjs"),
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      homeDir: dir,
      env: { USERDOMAIN: "PC", USERNAME: "fou" },
      vbsPath,
      runSchtasks: (args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(result.installed, true);
    assert.equal(calls[0][0], "/Create");
    assert.ok(calls[0].includes(win.TASK_NAME));
    assert.equal(calls[1][0], "/Run");

    const raw = readFileSync(result.xmlPath);
    // UTF-16LE BOM:FF FE
    assert.equal(raw[0], 0xff);
    assert.equal(raw[1], 0xfe);
    const xml = raw.toString("utf16le");
    assert.match(xml, /wscript\.exe/);
    assert.match(xml, /PC\\fou/);
    assert.match(xml, /RestartOnFailure/);
    assert.match(xml, /main\.mjs/);
  } finally {
    cleanup();
  }
});

test("win: schtasks failure surfaces reason, missing vbs refuses early", () => {
  const { dir, cleanup } = tmpdir();
  try {
    const vbsPath = path.join(dir, "run-hidden.vbs");
    writeFileSync(vbsPath, "' stub");
    const failed = win.installAutostart({
      daemonEntry: path.join(dir, "main.mjs"),
      homeDir: dir,
      vbsPath,
      runSchtasks: () => ({ status: 1, stderr: "access denied", stdout: "" }),
    });
    assert.equal(failed.installed, false);
    assert.match(failed.reason, /access denied/);

    const noVbs = win.installAutostart({
      daemonEntry: path.join(dir, "main.mjs"),
      homeDir: dir,
      vbsPath: path.join(dir, "missing.vbs"),
      runSchtasks: () => ({ status: 0 }),
    });
    assert.equal(noVbs.installed, false);
    assert.match(noVbs.reason, /hidden launcher/);
  } finally {
    cleanup();
  }
});

test("win: uninstall ends then deletes the task", () => {
  const calls = [];
  const result = win.uninstallAutostart({
    runSchtasks: (args) => {
      calls.push(args[0]);
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, ["/End", "/Delete"]);
  assert.equal(result.removed, true);
});

test("mac: install writes plist and bootstraps; falls back to load", () => {
  const { dir, cleanup } = tmpdir();
  try {
    const calls = [];
    const result = mac.installAutostart({
      daemonEntry: "/repo/daemon/main.mjs",
      nodeBin: "/usr/local/bin/node",
      homeDir: dir,
      runLaunchctl: (args) => {
        calls.push(args[0]);
        if (args[0] === "bootout") throw new Error("not loaded");
      },
    });
    assert.equal(result.installed, true);
    assert.deepEqual(calls, ["bootout", "bootstrap"]);
    const plist = readFileSync(result.plistPath, "utf8");
    assert.match(plist, /com\.wexx\.daemon/);
    assert.match(plist, /main\.mjs/);

    // bootstrap 失败时退回 legacy load
    const fallbackCalls = [];
    mac.installAutostart({
      daemonEntry: "/repo/daemon/main.mjs",
      homeDir: dir,
      runLaunchctl: (args) => {
        fallbackCalls.push(args[0]);
        if (args[0] === "bootstrap") throw new Error("denied");
      },
    });
    assert.deepEqual(fallbackCalls, ["bootout", "bootstrap", "load"]);
  } finally {
    cleanup();
  }
});

test("codexProbePaths: windows probes npm/pnpm shims, unix probes brew paths", () => {
  const winPaths = codexProbePaths({
    platform: "win32",
    home: "C:\\Users\\fou",
    env: { APPDATA: "C:\\Users\\fou\\AppData\\Roaming" },
  });
  assert.ok(winPaths.some((p) => p.endsWith("npm\\codex.cmd")));
  assert.ok(winPaths.some((p) => p.includes("pnpm")));

  const unixPaths = codexProbePaths({ platform: "darwin", home: "/Users/fou", env: {} });
  assert.ok(unixPaths.includes("/opt/homebrew/bin/codex"));
});
