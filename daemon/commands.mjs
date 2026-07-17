// 微信指令:带外控制,daemon 本地处理,永不进入 Codex thread。
// 中文别名只做整条消息精确匹配,防止误拦正常对话。

const COMMANDS = [
  { name: "stop", slash: "/stop", aliases: ["停", "/停"] },
  { name: "new", slash: "/new", aliases: ["新任务", "/新任务"] },
  { name: "status", slash: "/status", aliases: ["状态", "/状态"] },
  { name: "help", slash: "/help", aliases: ["帮助", "/帮助"] },
];

export function parseCommand(text) {
  // 中文输入法常打出全角斜杠(／)和全角空格,先归一化
  const trimmed = String(text ?? "")
    .replace(/　/gu, " ")
    .trim()
    .replace(/^／/u, "/");
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const command of COMMANDS) {
    if (lower === command.slash || command.aliases.includes(trimmed)) {
      return { name: command.name };
    }
  }
  return null;
}

export const HELP_TEXT = [
  "可用指令(直接发送即可,其余消息都会交给 Codex 处理):",
  "/stop 或 停 —— 立即中断当前任务",
  "/new 或 新任务 —— 开启全新会话(不带旧上下文)",
  "/status 或 状态 —— 查看是否有任务在跑",
  "/help 或 帮助 —— 显示本说明",
].join("\n");

export function buildStatusText({ conversation, activeTurn, daemonStartedAt }) {
  const lines = [];
  if (activeTurn) {
    lines.push(`正在执行任务(开始于 ${formatTime(activeTurn.startedAt)})。`);
  } else {
    lines.push("当前没有正在执行的任务。");
  }
  if (conversation?.lastMessageAt) {
    lines.push(`最后一条消息:${formatTime(conversation.lastMessageAt)}`);
  }
  if (daemonStartedAt) {
    lines.push(`服务运行自:${formatTime(daemonStartedAt)}`);
  }
  return lines.join("\n");
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}
