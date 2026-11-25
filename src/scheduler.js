const store = require("./store");
const oauth = require("./oauth");

let timer = null;
let isRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refresh a list of accounts sequentially with polite delay.
 */
async function refreshAccountsList(accounts, trigger = "scheduled") {
  if (isRunning) {
    return { skipped: true, reason: "刷新任务正在进行中" };
  }
  isRunning = true;
  const results = [];

  try {
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const res = await oauth.refreshStoredAccount(acc, trigger);
      results.push({
        email: acc.email,
        ok: res.ok,
        rotated: Boolean(res.rotated),
        error: res.error || null,
      });
      if (i < accounts.length - 1) {
        await sleep(1200);
      }
    }

    if (results.length > 0) {
      store.updateScheduler({
        lastRunAt: new Date().toISOString(),
      });
    }
  } finally {
    isRunning = false;
  }

  return {
    skipped: false,
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    rotated: results.filter((r) => r.rotated).length,
    results,
  };
}

async function runRefreshAll(trigger = "manual") {
  return refreshAccountsList(store.getAccounts(), trigger);
}

/**
 * Check each account's individual nextRefreshAt (based on its own importedAt / lastRefreshedAt + intervalDays).
 */
async function runDueRefreshes() {
  const sched = store.getScheduler();
  if (!sched.enabled || isRunning) return;

  const now = Date.now();
  store.updateScheduler({ lastCheckAt: new Date(now).toISOString() });

  const dueAccounts = store.getAccounts().filter((acc) => {
    const dueMs = acc.nextRefreshAt ? Date.parse(acc.nextRefreshAt) : 0;
    return !dueMs || now >= dueMs;
  });

  if (dueAccounts.length === 0) return;

  console.log(
    `[Scheduler] Found ${dueAccounts.length} account(s) due for ${sched.intervalDays}-day auto-refresh.`
  );
  await refreshAccountsList(dueAccounts, "scheduled");
}

function tick() {
  runDueRefreshes().catch((err) =>
    console.error("[Scheduler] Error during due refresh check:", err.message)
  );
}

function start() {
  if (timer) return;
  // Check every 10 minutes (also run once 5 seconds after startup)
  setTimeout(tick, 5000);
  timer = setInterval(tick, 10 * 60 * 1000);
  console.log("[Scheduler] Per-account auto-refresh scheduler started.");
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function getStatus() {
  const sched = store.getScheduler();
  const accounts = store.getAccounts();
  const nextTimestamps = accounts
    .map((a) => (a.nextRefreshAt ? Date.parse(a.nextRefreshAt) : null))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  return {
    ...sched,
    nextEarliestRefreshAt: nextTimestamps.length
      ? new Date(nextTimestamps[0]).toISOString()
      : null,
    isRunning,
  };
}

module.exports = {
  start,
  stop,
  runRefreshAll,
  runDueRefreshes,
  getStatus,
};
