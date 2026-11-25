const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const MAX_LOGS = 500;
const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_INTERVAL_DAYS = 45;

const GROUP_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#06b6d4",
  "#64748b",
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function calcNextRefreshAt(baseIso, intervalDays) {
  const baseMs = baseIso ? Date.parse(baseIso) : Date.now();
  const safeBase = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(safeBase + intervalDays * DAY_MS).toISOString();
}

function defaultState() {
  return {
    auth: {
      username: "",
      passwordSalt: "",
      passwordHash: "",
      sessionSecret: "",
      updatedAt: null,
    },
    groups: [],
    accounts: [],
    scheduler: {
      enabled: true,
      intervalDays: DEFAULT_INTERVAL_DAYS,
      lastCheckAt: null,
      lastRunAt: null,
    },
    logs: [],
  };
}

let state = null;

function normalizeAccount(acc, intervalDays) {
  const importedAt = acc.importedAt || acc.createdAt || new Date().toISOString();
  const baseForNext = acc.lastRefreshedAt || importedAt;
  const nextRefreshAt = acc.nextRefreshAt || calcNextRefreshAt(baseForNext, intervalDays);

  return {
    ...acc,
    groupId: acc.groupId || null,
    note: acc.note || "",
    importedAt,
    createdAt: acc.createdAt || importedAt,
    nextRefreshAt,
    refreshCount: acc.refreshCount || 0,
    rotatedCount: acc.rotatedCount || 0,
  };
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) {
    state = defaultState();
    save();
    return state;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const prevSched = parsed.scheduler || {};
    const intervalDays =
      prevSched.intervalDays !== undefined
        ? Math.max(1, Math.min(89, Number(prevSched.intervalDays) || DEFAULT_INTERVAL_DAYS))
        : DEFAULT_INTERVAL_DAYS;

    state = {
      auth: { ...defaultState().auth, ...(parsed.auth || {}) },
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      accounts: Array.isArray(parsed.accounts)
        ? parsed.accounts.map((a) => normalizeAccount(a, intervalDays))
        : [],
      scheduler: {
        enabled: prevSched.enabled !== undefined ? Boolean(prevSched.enabled) : true,
        intervalDays,
        lastCheckAt: prevSched.lastCheckAt || null,
        lastRunAt: prevSched.lastRunAt || null,
      },
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
    };
    save();
  } catch (err) {
    console.error("[Store] Failed to parse db.json, resetting:", err.message);
    state = defaultState();
    save();
  }
  return state;
}

function save() {
  ensureDataDir();
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpPath, DB_PATH);
}

function getState() {
  if (!state) load();
  return state;
}

// --- Auth ---
function getAuth() {
  return getState().auth || defaultState().auth;
}

function setAuth(patch) {
  const s = getState();
  s.auth = { ...defaultState().auth, ...(s.auth || {}), ...patch };
  save();
  return s.auth;
}

// --- Groups ---
function getGroups() {
  return getState().groups;
}

function findGroup(id) {
  return getState().groups.find((g) => g.id === id) || null;
}

function createGroup({ name, color }) {
  const s = getState();
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("分组名称不能为空");
  if (s.groups.some((g) => g.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error("已存在同名分组");
  }
  const group = {
    id: crypto.randomUUID(),
    name: cleanName,
    color: color || GROUP_COLORS[s.groups.length % GROUP_COLORS.length],
    createdAt: new Date().toISOString(),
  };
  s.groups.push(group);
  save();
  return group;
}

function updateGroup(id, { name, color }) {
  const s = getState();
  const group = s.groups.find((g) => g.id === id);
  if (!group) return null;
  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName) throw new Error("分组名称不能为空");
    if (
      s.groups.some(
        (g) => g.id !== id && g.name.toLowerCase() === cleanName.toLowerCase()
      )
    ) {
      throw new Error("已存在同名分组");
    }
    group.name = cleanName;
  }
  if (color) group.color = color;
  save();
  return group;
}

function deleteGroup(id) {
  const s = getState();
  const before = s.groups.length;
  s.groups = s.groups.filter((g) => g.id !== id);
  if (s.groups.length !== before) {
    // Move accounts in this group back to ungrouped
    for (const acc of s.accounts) {
      if (acc.groupId === id) acc.groupId = null;
    }
    save();
    return true;
  }
  return false;
}

// --- Accounts ---
function parseAccountLines(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parsed = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const cleanLine = lines[i].replace(/^outlook\s*:\s*/i, "").trim();
    const parts = cleanLine.split("----").map((p) => p.trim());
    if (parts.length < 4) {
      errors.push({
        line: i + 1,
        raw: lines[i].slice(0, 60),
        reason: "字段不足4个（需要 email----password----client_id----refresh_token）",
      });
      continue;
    }
    const email = parts[0];
    const password = parts[1];
    const clientId = parts[2];
    const refreshToken = parts.slice(3).join("----");

    if (!email.includes("@") || !clientId || !refreshToken) {
      errors.push({
        line: i + 1,
        raw: lines[i].slice(0, 60),
        reason: "邮箱、client_id 或 refresh_token 无效",
      });
      continue;
    }

    parsed.push({ email, password, clientId, refreshToken });
  }

  return { parsed, errors };
}

function upsertAccounts(items, { groupId = null, note = "" } = {}) {
  const s = getState();
  const now = new Date().toISOString();
  const intervalDays = s.scheduler.intervalDays || DEFAULT_INTERVAL_DAYS;
  const validGroupId = groupId && findGroup(groupId) ? groupId : null;
  let added = 0;
  let updated = 0;
  const affected = [];

  for (const item of items) {
    const existing = s.accounts.find(
      (a) => a.email.toLowerCase() === item.email.toLowerCase()
    );
    if (existing) {
      existing.password = item.password ?? existing.password;
      existing.clientId = item.clientId;
      existing.refreshToken = item.refreshToken;
      if (validGroupId) existing.groupId = validGroupId;
      if (note) existing.note = note;
      existing.importedAt = now;
      existing.nextRefreshAt = calcNextRefreshAt(now, intervalDays);
      existing.status = "pending";
      existing.lastError = null;
      existing.updatedAt = now;
      updated++;
      affected.push(existing);
    } else {
      const acc = {
        id: crypto.randomUUID(),
        email: item.email,
        password: item.password || "",
        clientId: item.clientId,
        refreshToken: item.refreshToken,
        groupId: validGroupId,
        note: note || "",
        scope: "",
        status: "pending",
        lastError: null,
        importedAt: now,
        lastRefreshedAt: null,
        nextRefreshAt: calcNextRefreshAt(now, intervalDays),
        lastFetchedAt: null,
        refreshCount: 0,
        rotatedCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      s.accounts.push(acc);
      added++;
      affected.push(acc);
    }
  }

  save();
  return { added, updated, affected };
}

function updateAccountMeta(idOrEmail, { groupId, note }) {
  const acc = findAccount(idOrEmail);
  if (!acc) return null;
  if (groupId !== undefined) {
    acc.groupId = groupId && findGroup(groupId) ? groupId : null;
  }
  if (note !== undefined) {
    acc.note = String(note || "").trim().slice(0, 120);
  }
  acc.updatedAt = new Date().toISOString();
  save();
  return acc;
}

function getAccounts() {
  return getState().accounts;
}

function findAccount(emailOrId) {
  const key = String(emailOrId || "").toLowerCase();
  return getState().accounts.find(
    (a) => a.id === emailOrId || a.email.toLowerCase() === key
  );
}

function deleteAccount(emailOrId) {
  const s = getState();
  const key = String(emailOrId || "").toLowerCase();
  const before = s.accounts.length;
  s.accounts = s.accounts.filter(
    (a) => a.id !== emailOrId && a.email.toLowerCase() !== key
  );
  if (s.accounts.length !== before) {
    save();
    return true;
  }
  return false;
}

function recordTokenRefresh(accountId, { success, newRefreshToken, scope, error, trigger = "manual" }) {
  const s = getState();
  const acc = s.accounts.find((a) => a.id === accountId);
  const now = new Date().toISOString();
  const intervalDays = s.scheduler.intervalDays || DEFAULT_INTERVAL_DAYS;
  let rotated = false;

  if (acc) {
    if (success) {
      if (newRefreshToken && newRefreshToken !== acc.refreshToken) {
        acc.refreshToken = newRefreshToken;
        acc.rotatedCount = (acc.rotatedCount || 0) + 1;
        rotated = true;
      }
      if (scope) acc.scope = scope;
      acc.status = "active";
      acc.lastError = null;
      acc.lastRefreshedAt = now;
      acc.nextRefreshAt = calcNextRefreshAt(now, intervalDays);
      acc.refreshCount = (acc.refreshCount || 0) + 1;
      acc.updatedAt = now;
    } else {
      acc.status = "error";
      acc.lastError = error || "Unknown error";
      acc.updatedAt = now;
    }
  }

  s.logs.unshift({
    id: crypto.randomUUID(),
    timestamp: now,
    email: acc ? acc.email : accountId,
    trigger,
    success: Boolean(success),
    rotated,
    message: success
      ? rotated
        ? `刷新成功，已覆盖保存新 refresh_token（下次自动刷新: ${intervalDays} 天后）`
        : `刷新成功，令牌有效（下次自动刷新: ${intervalDays} 天后）`
      : `刷新失败: ${error || "未知错误"}`,
  });

  if (s.logs.length > MAX_LOGS) {
    s.logs = s.logs.slice(0, MAX_LOGS);
  }

  save();
  return { account: acc, rotated };
}

function markFetched(accountId) {
  const s = getState();
  const acc = s.accounts.find((a) => a.id === accountId);
  if (acc) {
    acc.lastFetchedAt = new Date().toISOString();
    save();
  }
}

function getScheduler() {
  return getState().scheduler;
}

function updateScheduler(patch) {
  const s = getState();
  const prev = s.scheduler;
  const intervalDays =
    patch.intervalDays !== undefined
      ? Math.max(1, Math.min(89, Number(patch.intervalDays) || DEFAULT_INTERVAL_DAYS))
      : prev.intervalDays;

  const enabled =
    patch.enabled !== undefined ? Boolean(patch.enabled) : prev.enabled;

  const intervalChanged = intervalDays !== prev.intervalDays;

  s.scheduler = {
    ...prev,
    ...patch,
    enabled,
    intervalDays,
  };

  if (intervalChanged) {
    for (const acc of s.accounts) {
      const base = acc.lastRefreshedAt || acc.importedAt || acc.createdAt;
      acc.nextRefreshAt = calcNextRefreshAt(base, intervalDays);
    }
  }

  save();
  return s.scheduler;
}

function getLogs(limit = 100) {
  return getState().logs.slice(0, limit);
}

function formatAccountLine(acc) {
  return `${acc.email}----${acc.password || ""}----${acc.clientId}----${acc.refreshToken}`;
}

function exportAccountsText(groupId = null) {
  let list = getState().accounts;
  if (groupId === "__ungrouped__") {
    list = list.filter((a) => !a.groupId);
  } else if (groupId) {
    list = list.filter((a) => a.groupId === groupId);
  }
  return list.map(formatAccountLine).join("\n");
}

module.exports = {
  load,
  save,
  getAuth,
  setAuth,
  getGroups,
  findGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  parseAccountLines,
  upsertAccounts,
  updateAccountMeta,
  getAccounts,
  findAccount,
  deleteAccount,
  recordTokenRefresh,
  markFetched,
  getScheduler,
  updateScheduler,
  getLogs,
  formatAccountLine,
  exportAccountsText,
  DB_PATH,
  DEFAULT_INTERVAL_DAYS,
};
