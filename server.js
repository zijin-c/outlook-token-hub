const express = require("express");
const path = require("path");
const store = require("./src/store");
const auth = require("./src/auth");
const oauth = require("./src/oauth");
const mail = require("./src/mail");
const scheduler = require("./src/scheduler");

const PORT = Number(process.env.PORT) || 3456;
const app = express();

app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public")));

store.load();
auth.initFromEnv();
scheduler.start();

// --- Auth Endpoints (Public) ---
app.get("/api/auth/status", (req, res) => {
  const initialized = auth.isInitialized();
  const session = auth.verifySessionFromRequest(req);
  res.json({
    ok: true,
    initialized,
    authenticated: Boolean(session),
    username: session ? session.username : null,
  });
});

app.post("/api/auth/setup", (req, res) => {
  try {
    const { username, password } = req.body || {};
    const admin = auth.setupAdmin(username, password);
    auth.setSessionCookie(res, admin.username, true);
    res.json({ ok: true, username: admin.username });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { username, password, remember = true } = req.body || {};
  if (!auth.isInitialized()) {
    return res.status(400).json({ ok: false, error: "请先初始化管理员账号" });
  }
  if (!auth.validateCredentials(username, password)) {
    return res.status(401).json({ ok: false, error: "账号或密码错误" });
  }
  const cleanUser = String(username).trim();
  auth.setSessionCookie(res, cleanUser, Boolean(remember));
  res.json({ ok: true, username: cleanUser });
});

app.post("/api/auth/logout", (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// Protect all other /api routes
app.use("/api", auth.requireAuthMiddleware);

app.post("/api/auth/change-password", (req, res) => {
  try {
    const { currentPassword, newUsername, newPassword } = req.body || {};
    const updated = auth.changeCredentials({ currentPassword, newUsername, newPassword });
    auth.setSessionCookie(res, updated.username, true);
    res.json({ ok: true, username: updated.username });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

function serializeAccount(acc) {
  const nextMs = acc.nextRefreshAt ? Date.parse(acc.nextRefreshAt) : null;
  const daysRemaining = Number.isFinite(nextMs)
    ? Math.max(0, Math.ceil((nextMs - Date.now()) / (24 * 3600 * 1000)))
    : null;
  const group = acc.groupId ? store.findGroup(acc.groupId) : null;

  return {
    id: acc.id,
    email: acc.email,
    clientId: acc.clientId,
    groupId: acc.groupId || null,
    groupName: group ? group.name : null,
    groupColor: group ? group.color : null,
    note: acc.note || "",
    refreshTokenPreview: acc.refreshToken
      ? `${acc.refreshToken.slice(0, 16)}...${acc.refreshToken.slice(-8)}`
      : "",
    credentialLine: store.formatAccountLine(acc),
    scope: acc.scope || "",
    status: acc.status,
    lastError: acc.lastError,
    importedAt: acc.importedAt || acc.createdAt,
    lastRefreshedAt: acc.lastRefreshedAt,
    nextRefreshAt: acc.nextRefreshAt,
    daysRemaining,
    lastFetchedAt: acc.lastFetchedAt,
    refreshCount: acc.refreshCount || 0,
    rotatedCount: acc.rotatedCount || 0,
    updatedAt: acc.updatedAt,
  };
}

// --- Groups ---
app.get("/api/groups", (req, res) => {
  const accounts = store.getAccounts();
  const groups = store.getGroups().map((g) => ({
    ...g,
    count: accounts.filter((a) => a.groupId === g.id).length,
  }));
  res.json({
    ok: true,
    groups,
    ungroupedCount: accounts.filter((a) => !a.groupId).length,
    totalCount: accounts.length,
  });
});

app.post("/api/groups", (req, res) => {
  try {
    const { name, color } = req.body || {};
    const group = store.createGroup({ name, color });
    res.json({ ok: true, group });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.put("/api/groups/:id", (req, res) => {
  try {
    const { name, color } = req.body || {};
    const group = store.updateGroup(req.params.id, { name, color });
    if (!group) return res.status(404).json({ ok: false, error: "分组不存在" });
    res.json({ ok: true, group });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/groups/:id", (req, res) => {
  const ok = store.deleteGroup(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: "分组不存在" });
  res.json({ ok: true });
});

// --- Accounts ---
app.get("/api/accounts", (req, res) => {
  res.json({
    ok: true,
    accounts: store.getAccounts().map(serializeAccount),
  });
});

app.post("/api/accounts/import", async (req, res) => {
  const { text, verify = false, groupId = null, note = "" } = req.body || {};
  const { parsed, errors } = store.parseAccountLines(text);
  if (parsed.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "没有解析到有效账号",
      parseErrors: errors,
    });
  }

  const { added, updated, affected } = store.upsertAccounts(parsed, { groupId, note });
  let verified = [];

  if (verify) {
    for (const acc of affected) {
      const r = await oauth.refreshStoredAccount(acc, "manual");
      verified.push({
        email: acc.email,
        ok: r.ok,
        rotated: Boolean(r.rotated),
        error: r.error || null,
      });
    }
  }

  res.json({
    ok: true,
    added,
    updated,
    parseErrors: errors,
    verified,
    accounts: store.getAccounts().map(serializeAccount),
  });
});

app.patch("/api/accounts/:id", (req, res) => {
  const { groupId, note } = req.body || {};
  const updated = store.updateAccountMeta(req.params.id, { groupId, note });
  if (!updated) return res.status(404).json({ ok: false, error: "账号不存在" });
  res.json({ ok: true, account: serializeAccount(updated) });
});

app.delete("/api/accounts/:id", (req, res) => {
  const deleted = store.deleteAccount(req.params.id);
  if (deleted) {
    oauth.clearCache(req.params.id);
    return res.json({ ok: true });
  }
  res.status(404).json({ ok: false, error: "账号不存在" });
});

app.get("/api/accounts/export", (req, res) => {
  const groupId = req.query.groupId ? String(req.query.groupId) : null;
  const text = store.exportAccountsText(groupId);
  const count = text ? text.split("\n").length : 0;

  if (req.query.download === "1") {
    const dateStr = new Date().toISOString().slice(0, 10);
    const group = groupId && groupId !== "__ungrouped__" ? store.findGroup(groupId) : null;
    const suffix = group ? `-${group.name.replace(/[^\w\u4e00-\u9fa5-]/g, "_")}` : "";
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`outlook-tokens${suffix}-${dateStr}.txt`)}`
    );
    return res.send(text);
  }
  res.json({ ok: true, text, count });
});

// --- Direct Mail Fetching ---
app.get("/api/mail/list", async (req, res) => {
  const { email, folder = "inbox", limit = 20, client_id, refresh_token } = req.query;
  const maxLimit = Math.max(1, Math.min(50, Number(limit) || 20));

  if (email && client_id && refresh_token) {
    const tokenRes = await oauth.requestTokenFromMicrosoft({
      clientId: String(client_id),
      refreshToken: String(refresh_token),
    });
    if (!tokenRes.ok) {
      return res.status(400).json({ ok: false, error: tokenRes.error });
    }
    const fetchRes = await mail.fetchMessagesForCredentials(
      { email: String(email), accessToken: tokenRes.accessToken, scope: tokenRes.scope },
      { folder: String(folder), limit: maxLimit }
    );
    if (!fetchRes.ok) {
      return res.status(502).json({ ok: false, error: fetchRes.error });
    }
    return res.json({
      ok: true,
      email,
      folder,
      protocol: fetchRes.protocol,
      new_refresh_token: tokenRes.refreshToken,
      count: fetchRes.messages.length,
      messages: fetchRes.messages,
    });
  }

  const acc = store.findAccount(email);
  if (!acc) {
    return res.status(404).json({ ok: false, error: "未找到该邮箱账号，请先导入" });
  }

  const fetchRes = await mail.fetchForStoredAccount(acc, {
    folder: String(folder),
    limit: maxLimit,
  });

  if (!fetchRes.ok) {
    return res.status(502).json({ ok: false, error: fetchRes.error });
  }

  res.json({
    ok: true,
    email: acc.email,
    folder,
    protocol: fetchRes.protocol,
    count: fetchRes.messages.length,
    messages: fetchRes.messages,
  });
});

app.get("/api/mail/latest", async (req, res) => {
  const { email, folder = "inbox", client_id, refresh_token } = req.query;

  if (email && client_id && refresh_token) {
    const tokenRes = await oauth.requestTokenFromMicrosoft({
      clientId: String(client_id),
      refreshToken: String(refresh_token),
    });
    if (!tokenRes.ok) {
      return res.status(400).json({ ok: false, error: tokenRes.error });
    }
    const fetchRes = await mail.fetchMessagesForCredentials(
      { email: String(email), accessToken: tokenRes.accessToken, scope: tokenRes.scope },
      { folder: String(folder), limit: 1 }
    );
    if (!fetchRes.ok) {
      return res.status(502).json({ ok: false, error: fetchRes.error });
    }
    const latest = fetchRes.messages[0] || null;
    return res.json({
      ok: true,
      email,
      folder,
      protocol: fetchRes.protocol,
      new_refresh_token: tokenRes.refreshToken,
      code: latest ? latest.code : null,
      message: latest,
    });
  }

  const acc = store.findAccount(email);
  if (!acc) {
    return res.status(404).json({ ok: false, error: "未找到该邮箱账号，请先导入" });
  }

  const fetchRes = await mail.fetchForStoredAccount(acc, {
    folder: String(folder),
    limit: 1,
  });
  if (!fetchRes.ok) {
    return res.status(502).json({ ok: false, error: fetchRes.error });
  }

  const latest = fetchRes.messages[0] || null;
  res.json({
    ok: true,
    email: acc.email,
    folder,
    protocol: fetchRes.protocol,
    code: latest ? latest.code : null,
    message: latest,
  });
});

// --- Token Refresh & Scheduler ---
app.post("/api/tokens/refresh", async (req, res) => {
  const { id, email, all } = req.body || {};

  if (all || (!id && !email)) {
    const summary = await scheduler.runRefreshAll("manual");
    return res.json({
      ok: true,
      summary,
      accounts: store.getAccounts().map(serializeAccount),
    });
  }

  const acc = store.findAccount(id || email);
  if (!acc) {
    return res.status(404).json({ ok: false, error: "账号不存在" });
  }

  const result = await oauth.refreshStoredAccount(acc, "manual");
  res.json({
    ok: result.ok,
    rotated: Boolean(result.rotated),
    error: result.error || null,
    account: serializeAccount(store.findAccount(acc.id)),
  });
});

app.get("/api/scheduler", (req, res) => {
  res.json({ ok: true, scheduler: scheduler.getStatus() });
});

app.put("/api/scheduler", (req, res) => {
  const { enabled, intervalDays } = req.body || {};
  store.updateScheduler({ enabled, intervalDays });
  res.json({ ok: true, scheduler: scheduler.getStatus() });
});

app.get("/api/logs", (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  res.json({ ok: true, logs: store.getLogs(limit) });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n================================================`);
  console.log(`  Outlook Mail Hub 已启动`);
  console.log(`  Web 面板: http://localhost:${PORT}`);
  console.log(`  数据文件: ${store.DB_PATH}`);
  console.log(`  登录认证: ${auth.isInitialized() ? `已就绪 (管理员: ${store.getAuth().username})` : "首次访问页面时设置管理员账号密码"}`);
  console.log(`================================================\n`);
});
