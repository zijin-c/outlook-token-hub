const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const oauth = require("./oauth");
const store = require("./store");

/**
 * Extract likely OTP / verification code from subject + plain text.
 */
function extractVerificationCode(subject = "", text = "") {
  const combined = `${subject}\n${text}`
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");

  // 1. Contextual match (Chinese & English keywords near 4-8 digit code)
  const contextualPatterns = [
    /(?:验证码|校验码|安全码|安全代码|动态码|一次性代码|确认码|登录码)[^\dA-Za-z]{0,12}(\d{4,8})\b/i,
    /(?:verification\s*code|security\s*code|one[- ]time\s*(?:code|passcode|password)|passcode|otp|pin|code)[^\d]{0,16}(\d{4,8})\b/i,
    /\b(\d{4,8})\b\s*(?:is\s+your|为您的|是您的|用于)/i,
  ];

  for (const re of contextualPatterns) {
    const m = combined.match(re);
    if (m && m[1]) {
      return m[1];
    }
  }

  // 2. Fallback: standalone 6-digit number (excluding years 1900-2099)
  const fallback = combined.match(/\b(\d{6})\b/);
  if (fallback && fallback[1]) {
    return fallback[1];
  }

  return null;
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Protocol 1: Outlook REST API v2.0 (works with outlook.office.com/Mail.ReadWrite)
 */
async function fetchViaOutlookRest(accessToken, folder = "inbox", limit = 20) {
  const folderMap = {
    inbox: "mailfolders/inbox/messages",
    junk: "mailfolders/junkemail/messages",
    all: "messages",
  };
  const endpointPath = folderMap[folder] || folderMap.inbox;
  const url = `https://outlook.office.com/api/v2.0/me/${endpointPath}?$top=${limit}&$orderby=ReceivedDateTime desc&$select=Id,Subject,From,ToRecipients,ReceivedDateTime,IsRead,BodyPreview,Body`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Outlook REST HTTP ${res.status}: ${errText.slice(0, 180)}`);
  }

  const data = await res.json();
  const list = Array.isArray(data.value) ? data.value : [];

  return list.map((msg) => {
    const bodyContent = msg.Body?.Content || "";
    const isHtml = (msg.Body?.ContentType || "").toLowerCase() === "html";
    const textBody = isHtml ? stripHtml(bodyContent) : bodyContent;
    const htmlBody = isHtml ? bodyContent : null;
    const subject = msg.Subject || "(无主题)";
    const fromAddr = msg.From?.EmailAddress?.Address || "";
    const fromName = msg.From?.EmailAddress?.Name || fromAddr;

    return {
      id: msg.Id,
      subject,
      from: fromName && fromAddr && fromName !== fromAddr ? `${fromName} <${fromAddr}>` : fromAddr || fromName,
      fromAddress: fromAddr,
      date: msg.ReceivedDateTime,
      isRead: Boolean(msg.IsRead),
      preview: msg.BodyPreview || textBody.slice(0, 160),
      text: textBody,
      html: htmlBody,
      code: extractVerificationCode(subject, textBody || msg.BodyPreview || ""),
      protocol: "outlook-rest",
    };
  });
}

/**
 * Protocol 2: Microsoft Graph API v1.0 (works with graph.microsoft.com/Mail.Read)
 */
async function fetchViaGraphApi(accessToken, folder = "inbox", limit = 20) {
  const folderMap = {
    inbox: "mailFolders/inbox/messages",
    junk: "mailFolders/junkemail/messages",
    all: "messages",
  };
  const endpointPath = folderMap[folder] || folderMap.inbox;
  const url = `https://graph.microsoft.com/v1.0/me/${endpointPath}?$top=${limit}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,isRead,bodyPreview,body`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Graph API HTTP ${res.status}: ${errText.slice(0, 180)}`);
  }

  const data = await res.json();
  const list = Array.isArray(data.value) ? data.value : [];

  return list.map((msg) => {
    const bodyContent = msg.body?.content || "";
    const isHtml = (msg.body?.contentType || "").toLowerCase() === "html";
    const textBody = isHtml ? stripHtml(bodyContent) : bodyContent;
    const htmlBody = isHtml ? bodyContent : null;
    const subject = msg.subject || "(无主题)";
    const fromAddr = msg.from?.emailAddress?.address || "";
    const fromName = msg.from?.emailAddress?.name || fromAddr;

    return {
      id: msg.id,
      subject,
      from: fromName && fromAddr && fromName !== fromAddr ? `${fromName} <${fromAddr}>` : fromAddr || fromName,
      fromAddress: fromAddr,
      date: msg.receivedDateTime,
      isRead: Boolean(msg.isRead),
      preview: msg.bodyPreview || textBody.slice(0, 160),
      text: textBody,
      html: htmlBody,
      code: extractVerificationCode(subject, textBody || msg.bodyPreview || ""),
      protocol: "graph-api",
    };
  });
}

/**
 * Protocol 3: IMAP XOAUTH2 (fallback when REST/Graph scopes aren't granted)
 */
async function fetchViaImap(email, accessToken, folder = "inbox", limit = 20) {
  const client = new ImapFlow({
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    auth: {
      user: email,
      accessToken,
    },
    logger: false,
  });

  await client.connect();
  const mailboxName = folder === "junk" ? "Junk" : "INBOX";
  const messages = [];

  try {
    const lock = await client.getMailboxLock(mailboxName);
    try {
      const total = client.mailbox.exists || 0;
      if (total > 0) {
        const start = Math.max(1, total - limit + 1);
        const range = `${start}:${total}`;
        for await (const msg of client.fetch(range, {
          uid: true,
          flags: true,
          envelope: true,
          source: true,
        })) {
          const parsed = await simpleParser(msg.source);
          const subject = parsed.subject || "(无主题)";
          const textBody = parsed.text || stripHtml(parsed.html || "");
          const htmlBody = parsed.html || null;
          const fromText = parsed.from?.text || "";
          const fromAddr = parsed.from?.value?.[0]?.address || fromText;

          messages.push({
            id: String(msg.uid),
            subject,
            from: fromText || fromAddr,
            fromAddress: fromAddr,
            date: (parsed.date || msg.envelope?.date || new Date()).toISOString(),
            isRead: msg.flags ? msg.flags.has("\\Seen") : false,
            preview: textBody.slice(0, 160),
            text: textBody,
            html: htmlBody,
            code: extractVerificationCode(subject, textBody),
            protocol: "imap-xoauth2",
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return messages.sort((a, b) => new Date(b.date) - new Date(a.date));
}

/**
 * Fetch emails with automatic protocol routing & fallback.
 */
async function fetchMessagesForCredentials({ email, accessToken, scope = "" }, { folder = "inbox", limit = 20 } = {}) {
  const attempts = [];
  const lowerScope = scope.toLowerCase();

  // Decide preferred protocol order based on token scope
  const strategies = [];
  if (lowerScope.includes("graph.microsoft.com")) {
    strategies.push({ name: "graph-api", fn: () => fetchViaGraphApi(accessToken, folder, limit) });
    strategies.push({ name: "outlook-rest", fn: () => fetchViaOutlookRest(accessToken, folder, limit) });
    strategies.push({ name: "imap-xoauth2", fn: () => fetchViaImap(email, accessToken, folder, limit) });
  } else if (lowerScope.includes("mail.read") || lowerScope.includes("mail.readwrite")) {
    strategies.push({ name: "outlook-rest", fn: () => fetchViaOutlookRest(accessToken, folder, limit) });
    strategies.push({ name: "imap-xoauth2", fn: () => fetchViaImap(email, accessToken, folder, limit) });
    strategies.push({ name: "graph-api", fn: () => fetchViaGraphApi(accessToken, folder, limit) });
  } else {
    strategies.push({ name: "outlook-rest", fn: () => fetchViaOutlookRest(accessToken, folder, limit) });
    strategies.push({ name: "graph-api", fn: () => fetchViaGraphApi(accessToken, folder, limit) });
    strategies.push({ name: "imap-xoauth2", fn: () => fetchViaImap(email, accessToken, folder, limit) });
  }

  for (const s of strategies) {
    try {
      const messages = await s.fn();
      return { ok: true, protocol: s.name, messages };
    } catch (err) {
      attempts.push(`${s.name}: ${err.message}`);
    }
  }

  return {
    ok: false,
    error: `所有协议取件失败 -> ${attempts.join(" | ")}`,
  };
}

/**
 * Fetch emails for a stored account.
 */
async function fetchForStoredAccount(account, { folder = "inbox", limit = 20 } = {}) {
  const tokenRes = await oauth.getAccessTokenForAccount(account);
  if (!tokenRes.ok) {
    return { ok: false, error: `令牌刷新失败: ${tokenRes.error}` };
  }

  let fetchRes = await fetchMessagesForCredentials(
    {
      email: account.email,
      accessToken: tokenRes.accessToken,
      scope: tokenRes.scope,
    },
    { folder, limit }
  );

  // If cached token failed (e.g. 401), force refresh once and retry
  if (!fetchRes.ok && tokenRes.fromCache) {
    const fresh = await oauth.getAccessTokenForAccount(account, { forceRefresh: true });
    if (fresh.ok) {
      fetchRes = await fetchMessagesForCredentials(
        {
          email: account.email,
          accessToken: fresh.accessToken,
          scope: fresh.scope,
        },
        { folder, limit }
      );
    }
  }

  if (fetchRes.ok) {
    store.markFetched(account.id);
  }
  return fetchRes;
}

module.exports = {
  extractVerificationCode,
  fetchMessagesForCredentials,
  fetchForStoredAccount,
};
