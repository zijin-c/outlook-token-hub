const store = require("./store");

const TOKEN_ENDPOINTS = [
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
  "https://login.microsoftonline.com/common/oauth2/v2.0/token",
];

// In-memory access_token cache: key -> { accessToken, expiresAt, scope }
const tokenCache = new Map();

/**
 * Exchange refresh_token for access_token (and possibly a rotated refresh_token).
 * Works both for stored accounts and stateless one-off calls.
 */
async function requestTokenFromMicrosoft({ clientId, refreshToken, scope }) {
  let lastError = "Token request failed";

  for (const endpoint of TOKEN_ENDPOINTS) {
    const params = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (scope) {
      params.set("scope", scope);
    }

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.access_token) {
        return {
          ok: true,
          accessToken: data.access_token,
          refreshToken: data.refresh_token || refreshToken,
          expiresIn: Number(data.expires_in) || 3599,
          scope: data.scope || "",
          endpoint,
        };
      }

      lastError =
        data.error_description ||
        data.error ||
        `HTTP ${res.status} from ${endpoint}`;

      // If it's a consumer/common tenant mismatch, try next endpoint
      if (data.error === "invalid_grant" && endpoint.includes("/consumers/")) {
        continue;
      }
      // For other errors on consumers, still try common once
    } catch (err) {
      lastError = err.message;
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Force refresh a stored account's token and persist any rotated refresh_token.
 */
async function refreshStoredAccount(account, trigger = "manual") {
  const result = await requestTokenFromMicrosoft({
    clientId: account.clientId,
    refreshToken: account.refreshToken,
  });

  if (result.ok) {
    const { account: updated, rotated } = store.recordTokenRefresh(account.id, {
      success: true,
      newRefreshToken: result.refreshToken,
      scope: result.scope,
      trigger,
    });

    tokenCache.set(account.id, {
      accessToken: result.accessToken,
      scope: result.scope,
      expiresAt: Date.now() + Math.max(60, result.expiresIn - 300) * 1000,
    });

    return {
      ok: true,
      accessToken: result.accessToken,
      scope: result.scope,
      rotated,
      account: updated,
    };
  }

  store.recordTokenRefresh(account.id, {
    success: false,
    error: result.error,
    trigger,
  });

  tokenCache.delete(account.id);
  return { ok: false, error: result.error };
}

/**
 * Get a valid access_token for a stored account (uses cache if still valid > 5 min).
 */
async function getAccessTokenForAccount(account, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = tokenCache.get(account.id);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        ok: true,
        accessToken: cached.accessToken,
        scope: cached.scope || account.scope || "",
        fromCache: true,
      };
    }
  }

  const res = await refreshStoredAccount(account, "mail_fetch");
  return { ...res, fromCache: false };
}

function clearCache(accountId) {
  tokenCache.delete(accountId);
}

module.exports = {
  requestTokenFromMicrosoft,
  refreshStoredAccount,
  getAccessTokenForAccount,
  clearCache,
};
