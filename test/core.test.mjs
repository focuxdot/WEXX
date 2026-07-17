import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  WechatCodexRunner,
  buildDeveloperInstructions,
  normalizeMessage,
  shouldRotateThread,
} from "../daemon/core.mjs";
import { resolvePaths } from "../daemon/state.mjs";

const HOUR = 60 * 60 * 1000;

function makePaths() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wexx-test-"));
  return {
    paths: resolvePaths({
      home: path.join(dir, "home"),
      codexHome: path.join(dir, "codex-home"),
      documentsCodexRoot: path.join(dir, "Documents", "Codex"),
      userHome: dir,
    }),
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
  };
}

function fakeCodexClient() {
  const calls = { created: [], interrupted: [], turns: [] };
  return {
    calls,
    async connect() {},
    isThreadLoaded: () => true,
    async createThread(options) {
      calls.created.push(options);
      return { id: `thread-${calls.created.length}` };
    },
    async resumeThread(threadId) {
      return { id: threadId };
    },
    async setThreadName() {},
    async startTurn(threadId, input) {
      calls.turns.push({ input, threadId });
      return { done: Promise.resolve({ interrupted: false, text: "done!" }), turnId: "turn-1" };
    },
    async interruptTurn(threadId, turnId) {
      calls.interrupted.push({ threadId, turnId });
    },
    async close() {},
  };
}

function fakeWechatClient() {
  const sent = [];
  return {
    sent,
    async getUpdates() {
      return { getUpdatesBuf: "", messages: [] };
    },
    async sendText({ text, toUserId }) {
      sent.push({ text, toUserId });
    },
  };
}

function inboundMessage(overrides = {}) {
  return {
    chatType: "dm",
    contextToken: "ctx-1",
    createdAt: new Date().toISOString(),
    messageId: overrides.messageId ?? `msg-${Math.random()}`,
    senderId: "user-1",
    text: "帮我整理文件",
    ...overrides,
  };
}

test("normalizeMessage handles raw ilink payload", () => {
  const normalized = normalizeMessage({
    context_token: "ctx",
    create_time: 1700000000,
    from_user_id: "wx-abc",
    item_list: [{ text_item: { text: " hello " }, type: 1 }],
    msg_id: "m1",
  });
  assert.equal(normalized.text, "hello");
  assert.equal(normalized.senderId, "wx-abc");
  assert.equal(normalized.chatType, "dm");
  assert.equal(normalized.conversationKey, "dm:wx-abc");
});

test("bot echo messages are dropped", () => {
  assert.equal(normalizeMessage({ message_type: 2 }), null);
});

test("identical text at different times gets distinct synthetic ids", () => {
  const shape = (createTime) => ({
    context_token: "ctx",
    create_time: createTime,
    from_user_id: "wx-abc",
    item_list: [{ text_item: { text: "/new" }, type: 1 }],
  });
  const first = normalizeMessage(shape(1700000000));
  const second = normalizeMessage(shape(1700000060));
  assert.notEqual(first.messageId, second.messageId);
});

test("message_id, client_id and create_time_ms are used when present", () => {
  const withMessageId = normalizeMessage({
    client_id: "wx-client-42",
    context_token: "ctx",
    from_user_id: "wx-abc",
    item_list: [{ text_item: { text: "/new" }, type: 1 }],
    message_id: "srv-msg-7",
  });
  assert.equal(withMessageId.messageId, "srv-msg-7");

  const withClientId = normalizeMessage({
    client_id: "wx-client-42",
    context_token: "ctx",
    from_user_id: "wx-abc",
    item_list: [{ text_item: { text: "/new" }, type: 1 }],
  });
  assert.equal(withClientId.messageId, "wx-client-42");

  const withMs = normalizeMessage({
    context_token: "ctx",
    create_time_ms: 1700000000123,
    from_user_id: "wx-abc",
    item_list: [{ text_item: { text: "/new" }, type: 1 }],
  });
  assert.match(withMs.messageId, /1700000000123/);
  assert.equal(withMs.createdAt, new Date(1700000000123).toISOString());
});

test("shouldRotateThread: active conversation is never cut", () => {
  const conversation = {
    lastMessageAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    threadId: "t1",
  };
  assert.equal(shouldRotateThread(conversation), false);
});

test("shouldRotateThread: rotates after 24h idle", () => {
  const conversation = {
    lastMessageAt: new Date(Date.now() - 25 * HOUR).toISOString(),
    threadId: "t1",
  };
  assert.equal(shouldRotateThread(conversation), true);
});

test("shouldRotateThread: /new forces rotation regardless of idle time", () => {
  const conversation = {
    forceNewThread: true,
    lastMessageAt: new Date().toISOString(),
    threadId: "t1",
  };
  assert.equal(shouldRotateThread(conversation), true);
});

test("lazy pointer only present when rollout path is known", () => {
  assert.match(
    buildDeveloperInstructions({ previousRolloutPath: "/tmp/rollout.jsonl" }),
    /rollout\.jsonl/,
  );
  assert.doesNotMatch(buildDeveloperInstructions({}), /rollout/);
});

test("unauthorized senders are ignored", async () => {
  const { paths, cleanup } = makePaths();
  try {
    const runner = new WechatCodexRunner({
      boundUserId: "owner-1",
      codexClient: fakeCodexClient(),
      paths,
      wechatClient: fakeWechatClient(),
    });
    const result = await runner.routeMessage(inboundMessage({ senderId: "stranger-9" }));
    assert.equal(result.status, "ignored");
    assert.equal(result.reason, "unauthorized_sender");
  } finally {
    cleanup();
  }
});

test("first message gets welcome and also executes as a task", async () => {
  const { paths, cleanup } = makePaths();
  try {
    const codexClient = fakeCodexClient();
    const wechatClient = fakeWechatClient();
    const runner = new WechatCodexRunner({
      boundUserId: "user-1",
      codexClient,
      options: { typingIndicator: false },
      paths,
      wechatClient,
    });

    const first = await runner.routeMessage(inboundMessage());
    assert.equal(first.status, "welcomed_and_dispatched");
    await runner.queues.get("dm:user-1");
    assert.match(wechatClient.sent[0].text, /已连接/);
    assert.equal(codexClient.calls.turns.length, 1);
    assert.equal(wechatClient.sent.at(-1).text, "done!");

    const second = await runner.routeMessage(inboundMessage());
    assert.equal(second.status, "dispatched");
    await runner.queues.get("dm:user-1");
    assert.equal(codexClient.calls.turns.length, 2);
  } finally {
    cleanup();
  }
});

test("stop command interrupts the active turn", async () => {
  const { paths, cleanup } = makePaths();
  try {
    const codexClient = fakeCodexClient();
    let releaseTurn;
    codexClient.startTurn = async () => ({
      done: new Promise((resolve) => {
        releaseTurn = () => resolve({ interrupted: true, text: "" });
      }),
      turnId: "turn-slow",
    });
    const wechatClient = fakeWechatClient();
    const runner = new WechatCodexRunner({
      boundUserId: "user-1",
      codexClient,
      options: { typingIndicator: false },
      paths,
      wechatClient,
    });

    await runner.routeMessage(inboundMessage({ text: "跑个长任务" })); // 首条即派发
    await waitFor(() => runner.activeTurns.has("dm:user-1"));

    const result = await runner.routeMessage(inboundMessage({ text: "停" }));
    assert.equal(result.command, "stop");
    assert.equal(codexClient.calls.interrupted.length, 1);
    assert.equal(codexClient.calls.interrupted[0].turnId, "turn-slow");

    releaseTurn();
    await runner.queues.get("dm:user-1");
    assert.match(wechatClient.sent.at(-1).text, /已中断/);
  } finally {
    cleanup();
  }
});

test("new command forces a fresh thread without pointer", async () => {
  const { paths, cleanup } = makePaths();
  try {
    const codexClient = fakeCodexClient();
    const wechatClient = fakeWechatClient();
    const runner = new WechatCodexRunner({
      boundUserId: "user-1",
      codexClient,
      options: { typingIndicator: false },
      paths,
      wechatClient,
    });

    await runner.routeMessage(inboundMessage({ text: "任务一" })); // 首条即派发
    await runner.queues.get("dm:user-1");
    assert.equal(codexClient.calls.created.length, 1);

    await runner.routeMessage(inboundMessage({ text: "新任务" }));
    await runner.routeMessage(inboundMessage({ text: "任务二" }));
    await runner.queues.get("dm:user-1");
    assert.equal(codexClient.calls.created.length, 2);
    assert.doesNotMatch(
      codexClient.calls.created[1].developerInstructions,
      /rollout/,
    );
  } finally {
    cleanup();
  }
});

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}
