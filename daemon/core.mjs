import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findRolloutPath } from "./app-server.mjs";
import { HELP_TEXT, buildStatusText, parseCommand } from "./commands.mjs";
import { markMessageSeen, readState, writeState } from "./state.mjs";
import { TYPING_START, TYPING_STOP } from "./ilink.mjs";

const DEFAULT_SANDBOX = "danger-full-access";
const DEFAULT_APPROVAL_POLICY = "never";
const DEFAULT_SERVICE_NAME = "wexx";
const DEFAULT_IDLE_ROTATION_MS = 24 * 60 * 60 * 1000;
const TYPING_TICKET_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WELCOME_MESSAGE = [
  "你好!已连接到你电脑上的 Codex。",
  "直接发消息就能派活,例如:整理资料、处理文件、写文档初稿。",
  "",
  "常用指令:",
  "/stop 或 停 —— 中断当前任务",
  "/new 或 新任务 —— 开启全新会话",
  "/status 或 状态 —— 查看任务状态",
  "/help 或 帮助 —— 查看帮助",
].join("\n");

export function shouldRotateThread(conversation, now = Date.now(), idleMs = DEFAULT_IDLE_ROTATION_MS) {
  if (!conversation?.threadId) return false;
  if (conversation.forceNewThread) return true;
  const last = Date.parse(conversation.lastMessageAt ?? "");
  if (!Number.isFinite(last)) return false;
  return now - last > idleMs;
}

export function buildDeveloperInstructions({ previousRolloutPath } = {}) {
  const lines = [
    "你是通过微信接入的 Codex 助手,帮助用户完成整理资料、处理文件、生成文档、写脚本等任务。",
    "微信只是用户与你对话的入口。不要主动提及 bridge、daemon、app-server、iLink、token 等内部实现。",
    "默认使用简体中文,回答简洁,适合在手机微信里阅读。",
    "把当前配置的 cwd 视为工作目录;产出文件保存在工作目录中,并把文件的完整路径告诉用户。",
  ];
  if (previousRolloutPath) {
    lines.push(
      `上一段微信会话的记录在 ${previousRolloutPath} 。若用户提及此前的事项而你缺少背景,先读取该文件了解上下文。`,
    );
  }
  return lines.join("\n");
}

export function normalizeMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.message_type === 2 || message.message_type === "bot") return null;

  if (message.text && message.contextToken && message.senderId) {
    const chatType = message.chatType === "group" ? "group" : "dm";
    const replyTarget = message.replyTarget ?? message.chatId ?? message.senderId;
    const conversationKey =
      message.conversationKey ?? `${chatType}:${String(replyTarget).trim()}`;
    return {
      chatType,
      contextToken: String(message.contextToken),
      conversationKey,
      createdAt: message.createdAt ?? nowIso(),
      displayName: message.displayName ?? null,
      messageId:
        message.messageId ?? `${conversationKey}:${message.createdAt ?? ""}:${hashish(message.text)}`,
      replyTarget: String(replyTarget),
      senderId: String(message.senderId),
      text: String(message.text).trim(),
    };
  }

  const item = Array.isArray(message.item_list)
    ? message.item_list.find((candidate) => candidate?.text_item?.text || candidate?.text_item?.content)
    : null;
  const text = (item?.text_item?.text ?? item?.text_item?.content)?.trim();
  const senderId = message.from_user_id;
  const groupId = message.group_id;
  const contextToken = message.context_token;
  if (!text || !senderId || !contextToken) return null;

  const chatType = groupId ? "group" : "dm";
  const replyTarget = groupId || senderId;
  const conversationKey = `${chatType}:${replyTarget}`;
  // iLink 消息实测字段(2026-07 抓取):message_id(服务端唯一)、client_id、
  // create_time_ms;codev 假设的 msg_id/create_time 不存在。ID 链按可用性
  // 降级,绝不能退化成纯文本哈希——那会永久吞掉重复发送的指令。
  const timeMs = message.create_time_ms ?? (message.create_time ? Number(message.create_time) * 1000 : null);
  return {
    chatType,
    contextToken,
    conversationKey,
    createdAt: timeMs ? new Date(Number(timeMs)).toISOString() : nowIso(),
    displayName: message.from_display_name ?? null,
    messageId:
      message.message_id ??
      message.msg_id ??
      message.client_id ??
      `${conversationKey}:${timeMs ?? ""}:${hashish(text)}`,
    replyTarget,
    senderId,
    text,
  };
}

export class WechatCodexRunner {
  constructor({ codexClient, wechatClient, paths, boundUserId, options = {} }) {
    this.codexClient = codexClient;
    this.wechatClient = wechatClient;
    this.paths = paths;
    this.boundUserId = boundUserId;
    this.options = options;
    this.state = readState(paths);
    this.getUpdatesBuf = this.state.getUpdatesBuf ?? "";
    this.activeTurns = new Map(); // conversationKey -> { turnId, threadId, startedAt }
    this.queues = new Map(); // conversationKey -> Promise chain
    this.daemonStartedAt = nowIso();
  }

  async connect() {
    await this.codexClient.connect?.();
  }

  // 拉一批消息。指令内联处理(快);普通消息进各会话队列异步执行,
  // 不阻塞下一轮 poll——这是 /stop 能在任务执行中生效的前提。
  async pollOnce() {
    const batch = await this.wechatClient.getUpdates(this.getUpdatesBuf);
    const results = [];

    for (const rawMessage of batch.messages ?? []) {
      const result = await this.routeMessage(rawMessage);
      results.push(result);
    }

    if (batch.getUpdatesBuf !== undefined) {
      this.getUpdatesBuf = batch.getUpdatesBuf;
      this.state.getUpdatesBuf = batch.getUpdatesBuf;
    }
    this.persist();
    return results;
  }

  async routeMessage(rawMessage) {
    const message = normalizeMessage(rawMessage);
    if (!message) return { reason: "unsupported_message", status: "ignored" };

    if (this.state.seenMessageIds.includes(message.messageId)) {
      return { reason: "duplicate_message", status: "ignored" };
    }
    markMessageSeen(this.state, message.messageId);

    // 白名单:扫码即绑定,只响应绑定者。
    if (this.boundUserId && message.senderId !== this.boundUserId) {
      return { reason: "unauthorized_sender", senderId: message.senderId, status: "ignored" };
    }

    const command = parseCommand(message.text);
    if (command) {
      return this.handleCommand(command, message);
    }

    // 首条消息:先回欢迎语,然后照常派发为任务——用户扫完码第一反应就是派活,
    // 不能让他再发一遍。
    const conversation = this.state.conversations[message.conversationKey] ?? null;
    let welcomed = false;
    if (!conversation?.threadId && !conversation?.welcomedAt) {
      await this.reply(message, this.options.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE);
      this.state.conversations[message.conversationKey] = {
        ...(conversation ?? {}),
        conversationKey: message.conversationKey,
        chatType: message.chatType,
        createdAt: nowIso(),
        lastContextToken: message.contextToken,
        lastMessageAt: message.createdAt,
        replyTarget: message.replyTarget,
        welcomedAt: nowIso(),
      };
      this.persist();
      welcomed = true;
    }

    this.enqueue(message.conversationKey, () => this.runTurn(message));
    return {
      conversationKey: message.conversationKey,
      preview: message.text.slice(0, 30),
      status: welcomed ? "welcomed_and_dispatched" : "dispatched",
    };
  }

  async handleCommand(command, message) {
    const conversationKey = message.conversationKey;
    const conversation = this.state.conversations[conversationKey] ?? null;

    if (command.name === "help") {
      await this.reply(message, HELP_TEXT);
      return { command: "help", status: "command_replied" };
    }

    if (command.name === "status") {
      await this.reply(
        message,
        buildStatusText({
          activeTurn: this.activeTurns.get(conversationKey) ?? null,
          conversation,
          daemonStartedAt: this.daemonStartedAt,
        }),
      );
      return { command: "status", status: "command_replied" };
    }

    if (command.name === "stop") {
      const active = this.activeTurns.get(conversationKey);
      if (!active) {
        await this.reply(message, "当前没有正在执行的任务。");
        return { command: "stop", status: "command_replied" };
      }
      try {
        await this.codexClient.interruptTurn(active.threadId, active.turnId);
        await this.reply(message, "已发送停止指令。");
      } catch (error) {
        await this.reply(message, `停止失败:${error.message}`);
      }
      return { command: "stop", status: "command_replied" };
    }

    if (command.name === "new") {
      if (conversation) {
        conversation.forceNewThread = true;
        conversation.previousRolloutPath = null; // 明确不带旧上下文
        this.persist();
      }
      await this.reply(message, "好的,下一条消息将开启全新任务。");
      return { command: "new", status: "command_replied" };
    }

    return { command: command.name, status: "ignored" };
  }

  async runTurn(message) {
    const conversationKey = message.conversationKey;
    let conversation = this.state.conversations[conversationKey] ?? {
      conversationKey,
      chatType: message.chatType,
      createdAt: nowIso(),
    };

    const thread = await this.ensureThread(conversation, message);
    conversation = this.state.conversations[conversationKey];

    const typingTicket = await this.resolveTypingTicket(conversation, message);
    await this.sendTyping(message, typingTicket, TYPING_START);

    try {
      const { turnId, done } = await this.codexClient.startTurn(thread.threadId, [
        { type: "text", text: message.text },
      ]);
      this.activeTurns.set(conversationKey, {
        threadId: thread.threadId,
        turnId,
        startedAt: nowIso(),
      });

      // 执行中的反馈只靠“正在输入”状态,不发额外消息
      const result = await done;

      if (result.interrupted) {
        await this.reply(message, "任务已中断。");
      } else {
        const replyText = String(result.text ?? "").trim();
        if (replyText) await this.reply(message, replyText);
      }

      conversation.lastMessageAt = message.createdAt ?? nowIso();
      conversation.lastContextToken = message.contextToken;
      conversation.replyTarget = message.replyTarget;
      this.persist();
      return { conversationKey, status: "replied", threadId: thread.threadId };
    } catch (error) {
      await this.reply(message, `任务执行出错:${error.message}`).catch(() => {});
      return { conversationKey, error: error.message, status: "turn_failed" };
    } finally {
      this.activeTurns.delete(conversationKey);
      await this.sendTyping(message, typingTicket, TYPING_STOP);
    }
  }

  async ensureThread(conversation, message) {
    const conversationKey = message.conversationKey;
    const rotate = shouldRotateThread(conversation, Date.now(), this.options.idleRotationMs);

    if (conversation.threadId && !rotate) {
      if (!this.codexClient.isThreadLoaded?.(conversation.threadId)) {
        await this.codexClient.resumeThread(
          conversation.threadId,
          this.threadOptions(conversation, null),
        );
      }
      this.syncSidebarState(conversation.threadId, conversation.workspaceRoot);
      return { threadId: conversation.threadId };
    }

    // 轮转:空闲超时带惰性指针;/new 明确不带。
    let previousRolloutPath = null;
    if (conversation.threadId && rotate && !conversation.forceNewThread) {
      previousRolloutPath = findRolloutPath(this.paths.codexHome, conversation.threadId);
    }

    const workspace = this.resolveWorkspace(message);
    const thread = await this.codexClient.createThread(
      this.threadOptions({ ...conversation, ...workspace }, previousRolloutPath),
    );
    const threadId = thread?.id ?? thread?.threadId;
    if (!threadId) throw new Error("Codex app-server did not return a thread id.");

    const threadName = `${message.chatType === "group" ? "微信群" : "微信"}-${formatLocalDate(new Date())}`;
    if (this.codexClient.setThreadName) {
      await this.codexClient.setThreadName(threadId, threadName);
    }
    this.syncSidebarState(threadId, workspace.workspaceRoot);

    this.state.conversations[conversationKey] = {
      ...conversation,
      conversationKey,
      chatType: message.chatType,
      forceNewThread: false,
      previousRolloutPath,
      threadId,
      threadName,
      workspaceCwd: workspace.cwd,
      workspaceRoot: workspace.workspaceRoot,
      updatedAt: nowIso(),
    };
    this.persist();
    return { threadId };
  }

  threadOptions(conversation, previousRolloutPath) {
    return {
      approvalPolicy: this.options.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
      cwd: conversation.workspaceCwd ?? conversation.cwd,
      developerInstructions: buildDeveloperInstructions({ previousRolloutPath }),
      model: this.options.model ?? null,
      projectlessOutputDirectory: conversation.workspaceCwd,
      sandbox: this.options.sandbox ?? DEFAULT_SANDBOX,
      serviceName: DEFAULT_SERVICE_NAME,
      threadSource: "user",
      workspaceKind: conversation.workspaceRoot ? "projectless" : undefined,
      workspaceRoots: conversation.workspaceRoot ? [conversation.workspaceRoot] : undefined,
    };
  }

  // Codex 桌面版无项目对话的原生目录形态:Documents/Codex/YYYY-MM-DD/wexx-*
  resolveWorkspace(message) {
    const workspaceRoot = this.paths.documentsCodexRoot;
    const cwd = path.join(
      workspaceRoot,
      formatLocalDate(new Date()),
      message.chatType === "group" ? `wexx-group-${shortId(message.replyTarget)}` : `wexx-${shortId(message.replyTarget)}`,
    );
    mkdirSync(cwd, { recursive: true });
    return { cwd, workspaceRoot };
  }

  // 把微信 thread 补进 .codex-global-state.json,进入侧栏“对话”分组。
  syncSidebarState(threadId, workspaceRoot) {
    const globalStateFile = path.join(this.paths.codexHome, ".codex-global-state.json");
    if (!threadId || !workspaceRoot) return;
    let state = {};
    if (existsSync(globalStateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(globalStateFile, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed;
      } catch {
        return; // 读不懂就不动,避免破坏 Codex 自己的状态文件
      }
    }
    const ids = Array.isArray(state["projectless-thread-ids"])
      ? state["projectless-thread-ids"].filter(Boolean)
      : [];
    if (!ids.includes(threadId)) ids.push(threadId);
    const hints =
      state["thread-workspace-root-hints"] &&
      typeof state["thread-workspace-root-hints"] === "object" &&
      !Array.isArray(state["thread-workspace-root-hints"])
        ? state["thread-workspace-root-hints"]
        : {};
    hints[threadId] = workspaceRoot;
    state["projectless-thread-ids"] = ids;
    state["thread-workspace-root-hints"] = hints;
    mkdirSync(path.dirname(globalStateFile), { recursive: true });
    writeFileSync(globalStateFile, `${JSON.stringify(state)}\n`);
  }

  async resolveTypingTicket(conversation, message) {
    if (this.options.typingIndicator === false || !this.wechatClient.getTypingTicket) return null;
    const fresh =
      conversation?.typingTicket &&
      Date.now() - Date.parse(conversation.typingTicketUpdatedAt ?? "") < TYPING_TICKET_TTL_MS;
    if (fresh) return conversation.typingTicket;
    try {
      const ticket = await this.wechatClient.getTypingTicket({
        contextToken: message.contextToken,
        toUserId: message.replyTarget,
      });
      if (ticket && conversation) {
        conversation.typingTicket = ticket;
        conversation.typingTicketUpdatedAt = nowIso();
      }
      return ticket;
    } catch {
      return null;
    }
  }

  async sendTyping(message, typingTicket, status) {
    if (!typingTicket || !this.wechatClient.sendTyping) return;
    try {
      await this.wechatClient.sendTyping({
        status,
        toUserId: message.replyTarget,
        typingTicket,
      });
    } catch {
      // typing 失败静默降级,不阻塞回复
    }
  }

  async reply(message, text) {
    await this.wechatClient.sendText({
      contextToken: message.contextToken,
      text,
      toUserId: message.replyTarget,
    });
  }

  enqueue(conversationKey, task) {
    const tail = this.queues.get(conversationKey) ?? Promise.resolve();
    const next = tail.then(task).catch((error) => {
      this.options.log?.(`turn error: ${error.message}`);
    });
    this.queues.set(conversationKey, next);
  }

  persist() {
    this.state = writeState(this.paths, this.state);
  }

  async close() {
    this.persist();
    await this.codexClient.close?.();
  }
}

function shortId(value) {
  return (
    String(value ?? "")
      .replace(/@.*/u, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "unknown"
  );
}

function hashish(value) {
  let hash = 0;
  for (const char of String(value)) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16);
}

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nowIso() {
  return new Date().toISOString();
}
