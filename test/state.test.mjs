import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  readAccount,
  readConsent,
  removeAccount,
  resolvePaths,
  rotateLogsIfNeeded,
  writeAccount,
  writeConsent,
} from "../daemon/state.mjs";

function makePaths() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wexx-state-"));
  return {
    paths: resolvePaths({ home: path.join(dir, "home") }),
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
  };
}

test("consent persists once accepted", () => {
  const { paths, cleanup } = makePaths();
  try {
    assert.equal(readConsent(paths), null);
    writeConsent(paths);
    assert.ok(readConsent(paths)?.accepted_at);
  } finally {
    cleanup();
  }
});

test("oversized logs get rotated/truncated, small ones untouched", () => {
  const { paths, cleanup } = makePaths();
  try {
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.logFile, "x".repeat(64));
    writeFileSync(paths.launchdLogFile, "y".repeat(64));

    assert.deepEqual(rotateLogsIfNeeded(paths, 1024), []);
    assert.ok(existsSync(paths.logFile), "small log must not rotate");

    const rotated = rotateLogsIfNeeded(paths, 16);
    assert.deepEqual(rotated.sort(), [paths.launchdLogFile, paths.logFile].sort());
    // daemon.log 轮转为 .old,腾出新文件
    assert.equal(existsSync(paths.logFile), false);
    assert.equal(readFileSync(`${paths.logFile}.old`, "utf8").length, 64);
    // launchd 日志原地清空(fd 被 launchd 持有,不能 rename)
    assert.equal(readFileSync(paths.launchdLogFile, "utf8"), "");
  } finally {
    cleanup();
  }
});

test("consent survives unbind (mode consent, not per-scan consent)", () => {
  const { paths, cleanup } = makePaths();
  try {
    writeConsent(paths);
    writeAccount(paths, { base_url: "https://x", token: "t", user_id: "u1" });
    assert.ok(readAccount(paths));
    removeAccount(paths);
    assert.equal(readAccount(paths), null);
    assert.ok(readConsent(paths)?.accepted_at, "unbind must not clear consent");
  } finally {
    cleanup();
  }
});
