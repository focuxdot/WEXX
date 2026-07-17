import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../daemon/commands.mjs";

test("slash commands parse case-insensitively", () => {
  assert.deepEqual(parseCommand("/stop"), { name: "stop" });
  assert.deepEqual(parseCommand("/STOP"), { name: "stop" });
  assert.deepEqual(parseCommand(" /new "), { name: "new" });
  assert.deepEqual(parseCommand("/status"), { name: "status" });
  assert.deepEqual(parseCommand("/help"), { name: "help" });
});

test("chinese aliases require exact full-message match", () => {
  assert.deepEqual(parseCommand("停"), { name: "stop" });
  assert.deepEqual(parseCommand("新任务"), { name: "new" });
  assert.deepEqual(parseCommand("状态"), { name: "status" });
  assert.deepEqual(parseCommand("帮助"), { name: "help" });
  // 全角斜杠/全角空格归一化(中文输入法)
  assert.deepEqual(parseCommand("／new"), { name: "new" });
  assert.deepEqual(parseCommand("／stop"), { name: "stop" });
  assert.deepEqual(parseCommand("　／状态　"), { name: "status" });
  // 斜杠中文别名(文案中使用的形式)
  assert.deepEqual(parseCommand("/停"), { name: "stop" });
  assert.deepEqual(parseCommand("/新任务"), { name: "new" });
  assert.deepEqual(parseCommand("/状态"), { name: "status" });
  assert.deepEqual(parseCommand("/帮助"), { name: "help" });
  // 出现在句子里不算指令
  assert.equal(parseCommand("停一下,先做别的"), null);
  assert.equal(parseCommand("帮助我整理文件"), null);
  assert.equal(parseCommand("查看状态如何"), null);
});

test("normal messages are not commands", () => {
  assert.equal(parseCommand("帮我做个表格"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand(null), null);
});
