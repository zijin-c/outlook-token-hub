const crypto = require("crypto");
const store = require("./store");

const COOKIE_NAME = "outlook_hub_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString("hex");
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function ensureSessionSecret() {
  const auth = store.getAuth();
  if (!auth.sessionSecret) {
    store.setAuth({ sessionSecret: crypto.randomBytes(32).toString("hex") });
  }
  return store.getAuth().sessionSecret;
}

/**
 * If ADMIN_PASSWORD env var is set, initialize or sync admin credentials on startup.
 */
function initFromEnv() {
  ensureSessionSecret();
  const envPass = (process.env.ADMIN_PASSWORD || process.env.ACCESS_PASSWORD || "").trim();
  const envUser = (process.env.ADMIN_USER || "admin").trim() || "admin";

  if (envPass) {
    const salt = crypto.randomBytes(16).toString("hex");
    store.setAuth({
      username: envUser,
      passwordSalt: salt,
      passwordHash: hashPassword(envPass, salt),
      updatedAt: new Date().toISOString(),
    });
    console.log(`[Auth] 已从环境变量加载管理员账号: ${envUser}`);
  }
}

function isInitialized() {
  const auth = store.getAuth();
  return Boolean(auth.username && auth.passwordHash && auth.passwordSalt);
}

function setupAdmin(username, password) {
  if (isInitialized()) {
    throw new Error("管理员账号已初始化，请直接登录");
  }
  const cleanUser = String(username || "").trim();
  const cleanPass = String(password || "");
  if (cleanUser.length < 2) throw new Error("账号长度至少 2 个字符");
  if (cleanPass.length < 4) throw new Error("密码长度至少 4 个字符");

  const salt = crypto.randomBytes(16).toString("hex");
  store.setAuth({
    username: cleanUser,
    passwordSalt: salt,
    passwordHash: hashPassword(cleanPass, salt),
    updatedAt: new Date().toISOString(),
  });
  return { username: cleanUser };
}

function validateCredentials(username, password) {
  const auth = store.getAuth();
  if (!isInitialized()) return false;
  if (String(username || "").trim() !== auth.username) return false;
  return verifyPassword(password, auth.passwordSalt, auth.passwordHash);
}

function changeCredentials({ currentPassword, newUsername, newPassword }) {
  const auth = store.getAuth();
  if (!verifyPassword(currentPassword, auth.passwordSalt, auth.passwordHash)) {
    throw new Error("当前密码不正确");
  }
  const cleanUser = String(newUsername || auth.username).trim();
  const cleanPass = String(newPassword || "");
  if (cleanUser.length < 2) throw new Error("账号长度至少 2 个字符");
  if (cleanPass && cleanPass.length < 4) throw new Error("新密码长度至少 4 个字符");

  const patch = {
    username: cleanUser,
    updatedAt: new Date().toISOString(),
  };
  if (cleanPass) {
    const salt = crypto.randomBytes(16).toString("hex");
    patch.passwordSalt = salt;
    patch.passwordHash = hashPassword(cleanPass, salt);
    // Rotate session secret so old stolen sessions are invalidated
    patch.sessionSecret = crypto.randomBytes(32).toString("hex");
  }
  store.setAuth(patch);
  return { username: cleanUser };
}

function signSession(username) {
  const secret = ensureSessionSecret();
  const payload = Buffer.from(
    JSON.stringify({
      u: username,
      exp: Date.now() + SESSION_TTL_MS,
    })
  ).toString("base64url");

  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function parseCookies(cookieHeader = "") {
  const out = {};
  for (const part of String(cookieHeader).split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function verifySessionFromRequest(req) {
  const auth = store.getAuth();
  if (!auth.sessionSecret || !isInitialized()) return null;

  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token || !token.includes(".")) return null;

  const [payload, sig] = token.split(".");
  const expectedSig = crypto
    .createHmac("sha256", auth.sessionSecret)
    .update(payload)
    .digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded || decoded.u !== auth.username || Date.now() > decoded.exp) {
      return null;
    }
    return { username: decoded.u };
  } catch {
    return null;
  }
}

function setSessionCookie(res, username, remember = true) {
  const token = signSession(username);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (remember) {
    parts.push(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

function requireAuthMiddleware(req, res, next) {
  // Optional API Key header for automated scripts
  const apiKey = (process.env.API_KEY || "").trim();
  if (apiKey) {
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (bearer && bearer === apiKey) return next();
  }

  const session = verifySessionFromRequest(req);
  if (session) {
    req.user = session;
    return next();
  }

  return res.status(401).json({
    ok: false,
    code: "UNAUTHORIZED",
    initialized: isInitialized(),
    error: "请先登录",
  });
}

module.exports = {
  initFromEnv,
  isInitialized,
  setupAdmin,
  validateCredentials,
  changeCredentials,
  verifySessionFromRequest,
  setSessionCookie,
  clearSessionCookie,
  requireAuthMiddleware,
};
