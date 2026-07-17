#!/usr/bin/env node
// 维护者推送守卫:push 之前验证 GitHub SSH 身份与预期账号一致,
// 提交/推送永远不会以错误账号发出。
//
// 仓库同时通过 `git config core.sshCommand` 钉死专用密钥(无视 ~/.ssh/config),
// 本脚本是其上的再次断言:`ssh -T git@github.com` 必须以预期账号问候才放行。
//
// 配置(wexx.* 命名空间,或环境变量兜底):
//   wexx.githubAccount / WEXX_GITHUB_ACCOUNT   预期 GitHub 登录名(默认取 remote owner)
//   wexx.githubSshKey  / WEXX_GITHUB_SSH_KEY   该账号私钥路径
//
// 用法:
//   node scripts/git-push-maintainer.mjs --check         # 仅验证身份
//   node scripts/git-push-maintainer.mjs origin main     # 验证后推送
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SSH_ARGS_BASE = ["-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes"];

const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const pushArgs = checkOnly ? args.slice(1) : args;

try {
  const remote = readRemote();
  const repo = parseGitHubSshRemote(remote);
  const expectedAccount = readConfig("wexx.githubAccount") || process.env.WEXX_GITHUB_ACCOUNT || repo.owner;
  const keyPath = readConfig("wexx.githubSshKey") || process.env.WEXX_GITHUB_SSH_KEY;

  verifyKeyFile(keyPath);
  verifySshAccount({ expectedAccount, keyPath });

  if (checkOnly) {
    console.log(`OK: GitHub SSH identity verified as ${expectedAccount} for maintainer push.`);
    process.exit(0);
  }

  if (pushArgs.length === 0) {
    throw new Error("Usage: npm run push:maintainer -- origin main");
  }

  const result = spawnSync("git", ["push", ...pushArgs], {
    env: { ...process.env, GIT_SSH_COMMAND: buildSshCommand(keyPath) },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function verifyKeyFile(keyPath) {
  if (!keyPath) {
    throw new Error(
      "Maintainer SSH key is not configured. Set `git config wexx.githubSshKey <path>` or WEXX_GITHUB_SSH_KEY.",
    );
  }
  if (!existsSync(keyPath)) {
    throw new Error(`Configured maintainer SSH key file does not exist: ${keyPath}`);
  }
}

function verifySshAccount({ expectedAccount, keyPath }) {
  const result = spawnSync("ssh", ["-i", keyPath, ...SSH_ARGS_BASE, "-T", "git@github.com"], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!output.includes(`Hi ${expectedAccount}!`)) {
    throw new Error(
      `Refusing to push: GitHub SSH identity did not greet "${expectedAccount}". Got:\n${output.trim()}`,
    );
  }
}

function readRemote() {
  return run("git", ["remote", "get-url", "origin"]).trim();
}

function parseGitHubSshRemote(remote) {
  const match = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/u);
  if (!match) {
    throw new Error(`Unexpected origin SSH remote: ${remote}`);
  }
  return { owner: match[1], repo: match[2] };
}

function readConfig(name) {
  const result = spawnSync("git", ["config", "--get", name], { encoding: "utf8" });
  return result.status !== 0 ? "" : (result.stdout ?? "").trim();
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout ?? "";
}

function buildSshCommand(keyPath) {
  return `ssh -i ${shellQuote(keyPath)} -o IdentitiesOnly=yes`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
