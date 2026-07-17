import crypto from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);
const QR_HTTP_TIMEOUT_MS = 35_000;
// getupdates 是长轮询,超时须大于服务端持有窗口;其余接口也共用这个上限。
// 没有超时的话,服务端挂起连接会让 daemon 永久假死(进程活着但不再收消息)。
const REQUEST_TIMEOUT_MS = 90_000;
export const TYPING_START = 1;
export const TYPING_STOP = 2;

export class IlinkClient {
  constructor({ baseUrl, token } = {}) {
    this.baseUrl = stripTrailingSlash(baseUrl ?? DEFAULT_BASE_URL);
    this.token = token;
    if (!this.token) {
      throw new Error("iLink bot token is required. Run the connect flow first.");
    }
  }

  async getUpdates(getUpdatesBuf = "") {
    const body = await this.request("ilink/bot/getupdates", {
      base_info: baseInfo(),
      get_updates_buf: getUpdatesBuf,
    });
    return {
      getUpdatesBuf: body.get_updates_buf ?? getUpdatesBuf,
      messages: Array.isArray(body.msgs) ? body.msgs : [],
    };
  }

  async sendText({ contextToken, text, toUserId }) {
    await this.request("ilink/bot/sendmessage", {
      base_info: baseInfo(),
      msg: {
        client_id: `wexx:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`,
        context_token: contextToken,
        from_user_id: "",
        item_list: [{ text_item: { text }, type: 1 }],
        message_state: 2,
        message_type: 2,
        to_user_id: toUserId,
      },
    });
  }

  async getTypingTicket({ contextToken, toUserId }) {
    const body = { base_info: baseInfo(), ilink_user_id: toUserId };
    if (contextToken) body.context_token = contextToken;
    const response = await this.request("ilink/bot/getconfig", body);
    return String(response.typing_ticket ?? "").trim() || null;
  }

  async sendTyping({ status, toUserId, typingTicket }) {
    if (!typingTicket) return;
    await this.request("ilink/bot/sendtyping", {
      base_info: baseInfo(),
      ilink_user_id: toUserId,
      status,
      typing_ticket: typingTicket,
    });
  }

  async request(endpoint, body) {
    const response = await fetch(`${this.baseUrl}/${endpoint}`, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${this.token}`,
        AuthorizationType: "ilink_bot_token",
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
        "content-type": "application/json",
        "X-WECHAT-UIN": randomWechatUin(),
      },
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok || parsed.errcode || parsed.ret) {
      throw new Error(`iLink ${endpoint} failed: HTTP ${response.status} ${text}`.trim());
    }
    return parsed;
  }
}

// —— 扫码登录(无 token 阶段,独立于 IlinkClient)——

async function loginApiGet(baseUrl, endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`${stripTrailingSlash(baseUrl)}/${endpoint}`, {
      headers: {
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`iLink ${endpoint} HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLoginQr({ botType = "3" } = {}) {
  const response = await loginApiGet(
    DEFAULT_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
  );
  const qrcode = String(response.qrcode ?? "").trim();
  const payload = String(response.qrcode_img_content ?? "").trim() || qrcode;
  if (!qrcode || !payload) throw new Error("iLink QR response missing qrcode payload");
  return { payload, qrcode };
}

// 轮询扫码状态直到 confirmed。onEvent 收到 {kind: qr|awaiting_scan|qr_refreshing} 事件。
export async function waitForLoginConfirm({
  qrcode,
  payload,
  timeoutMs = 300_000,
  onEvent = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let currentBaseUrl = DEFAULT_BASE_URL;
  let currentQr = qrcode;
  let refreshCount = 0;

  while (Date.now() < deadline) {
    let statusResponse;
    try {
      statusResponse = await loginApiGet(
        currentBaseUrl,
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQr)}`,
      );
    } catch {
      await sleep(1000);
      continue;
    }

    const status = String(statusResponse.status ?? "wait");
    if (status === "scaned") {
      onEvent({ kind: "awaiting_scan" });
    } else if (status === "scaned_but_redirect") {
      const redirectHost = String(statusResponse.redirect_host ?? "").trim();
      if (redirectHost) currentBaseUrl = `https://${redirectHost}`;
    } else if (status === "expired") {
      refreshCount += 1;
      if (refreshCount > 3) throw new Error("二维码多次过期,请重新执行连接。");
      const next = await fetchLoginQr();
      currentQr = next.qrcode;
      currentBaseUrl = DEFAULT_BASE_URL;
      onEvent({ kind: "qr_refreshing", payload: next.payload });
    } else if (status === "confirmed") {
      const account = {
        account_id: String(statusResponse.ilink_bot_id ?? "").trim(),
        base_url: String(statusResponse.baseurl ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL,
        token: String(statusResponse.bot_token ?? "").trim(),
        user_id: String(statusResponse.ilink_user_id ?? "").trim(),
      };
      if (!account.account_id || !account.token || !account.user_id) {
        throw new Error("扫码已确认,但 iLink 返回的凭证不完整。");
      }
      return account;
    }

    await sleep(1000);
  }

  throw new Error("微信扫码超时。");
}

function baseInfo() {
  return { channel_version: "0.1.0" };
}

function randomWechatUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64");
}

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/u, "");
}
