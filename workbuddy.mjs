import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const CN_BILLING = 'https://www.codebuddy.cn';
const CN_CHAT = 'https://copilot.tencent.com';
const API_PREFIX = '/v2/plugin';
const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0';
const CRED_KEY = 'ai-hub/workbuddy-cn';
const VAULT_DIR = join(homedir(), '.dsh', 'workbuddy-vault', 'cn');
const LEGACY_AUTH = join(homedir(), '.dsh', '.workbuddy-auth.cn.json');
const LIVE_FILES = ['workbuddy-desktop-ai.info', 'workbuddy-desktop.info'];
const REFRESH_MARGIN_MS = 5 * 60_000;
const FALLBACK_VALID_MS = 30_000;
const AT_REST_KEY_FAILURE_TTL_MS = 60_000;
const ENCRYPTED_FIELD_KEYS = ['accessToken', 'refreshToken', 'nickname', 'displayName', 'uin', 'uid', 'userId', 'enterpriseId', 'domain'];

function defaultDesktopAuthDirs() {
  const dirs = [];
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA]) {
    if (typeof base === 'string' && base.trim()) {
      const dir = join(base.trim(), 'CodeBuddyExtension', 'Data', 'Public', 'auth');
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

function nowMs() { return Date.now(); }
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 0xe8d4a51000 ? value : value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n > 0xe8d4a51000 ? n : n * 1000;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function encodeUint32(value) {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}
function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeUint32(bytes.length), bytes]);
}
export function fieldAad(keyId, suite = 1) {
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    encodeLengthPrefixed('WBEV1'),
    encodeLengthPrefixed('sym-v1'),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0])
  ]);
}
export function deriveAtRestKey(secret) {
  if (typeof secret !== 'string' || !secret.trim()) return null;
  const key = createHash('sha256').update(secret, 'utf8').digest();
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return { key, keyId };
}
export function isEncryptedFieldWrapper(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.$wbEncrypted === 1 && typeof value.envelope === 'string' && value.envelope.length > 0);
}
export function openEncryptedField(wrapper, key) {
  if (!isEncryptedFieldWrapper(wrapper) || !key?.key || !key?.keyId) return undefined;
  try {
    const envelope = JSON.parse(Buffer.from(wrapper.envelope, 'base64').toString('utf8'));
    if (!envelope || envelope.suite !== 1 || envelope.keyId !== key.keyId) return undefined;
    const nonce = Buffer.from(String(envelope.nonce || ''), 'base64');
    const authTag = Buffer.from(String(envelope.authTag || ''), 'base64');
    const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
    if (nonce.length !== 12 || authTag.length !== 16) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key.key, nonce, { authTagLength: 16 });
    decipher.setAAD(fieldAad(envelope.keyId, envelope.suite));
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch {
    return undefined;
  }
}
export function sealEncryptedField(value, key, nonce = Buffer.alloc(12, 7)) {
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: 16 });
  cipher.setAAD(fieldAad(key.keyId, 1));
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const envelope = Buffer.from(JSON.stringify({
    suite: 1,
    keyId: key.keyId,
    nonce: nonce.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }), 'utf8').toString('base64');
  return { $wbEncrypted: 1, envelope };
}
function hasEncryptedFields(document) {
  if (!document || typeof document !== 'object') return false;
  const auth = document.auth && typeof document.auth === 'object' ? document.auth : document;
  const account = document.account && typeof document.account === 'object' ? document.account : document;
  return ENCRYPTED_FIELD_KEYS.some(k => isEncryptedFieldWrapper(auth?.[k]) || isEncryptedFieldWrapper(account?.[k]) || isEncryptedFieldWrapper(document?.[k]));
}

let cachedProcessAtRestKey = null;
let lastAtRestKeyFailureAt = 0;

function runProbe(command, args, env, timeoutMs = 5000) {
  return new Promise(resolve => {
    let stdout = '', settled = false;
    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = ok => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok ? stdout : ''); };
    const timer = setTimeout(() => { child.kill(); done(false); }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < 65536) stdout += chunk.toString('utf8'); });
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
  });
}
async function discoverWorkbuddyExecutables() {
  const candidates = [];
  const add = p => { if (typeof p === 'string' && p.trim() && !candidates.includes(p.trim()) && existsSync(p.trim())) candidates.push(p.trim()); };
  add(process.env.WORKBUDDY_APP_EXECUTABLE);
  for (const root of [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    for (const dirName of ['WorkBuddy', 'WorkBuddyCN', 'WorkBuddy AI']) {
      for (const exe of ['WorkBuddy.exe', 'WorkBuddyAI.exe']) add(join(root, dirName, exe));
    }
  }
  if (!candidates.length && process.platform === 'win32') {
    for (const hive of ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall']) {
      const out = await runProbe('reg.exe', ['query', hive, '/s', '/f', 'WorkBuddy'], process.env, 3000);
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/REG_SZ\s+(.+)/i);
        if (!m) continue;
        const raw = m[1].trim().replace(/^"|"$/g, '').replace(/,\s*-?\d+$/, '');
        if (/\.exe$/i.test(raw)) add(raw);
        else { add(join(raw, 'WorkBuddy.exe')); add(join(raw, 'WorkBuddyAI.exe')); }
      }
    }
  }
  return candidates;
}
async function readDefaultAtRestKey() {
  if (cachedProcessAtRestKey) return cachedProcessAtRestKey;
  if (lastAtRestKeyFailureAt && nowMs() - lastAtRestKeyFailureAt < AT_REST_KEY_FAILURE_TTL_MS) return null;
  const script = "try{process.stdout.write(String(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()||''))}catch{process.exit(1)}";
  for (const exe of await discoverWorkbuddyExecutables()) {
    const out = await runProbe(exe, ['-e', script], { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, 5000);
    if (!out) continue;
    try {
      const parsed = JSON.parse(out.trim());
      const derived = deriveAtRestKey(parsed?.atRestSecretKey);
      if (derived) {
        cachedProcessAtRestKey = derived;
        return derived;
      }
    } catch {}
  }
  lastAtRestKeyFailureAt = nowMs();
  return null;
}

function firstString(source, keys, atRestKey = null) {
  for (const key of keys) {
    let value = source?.[key];
    if (isEncryptedFieldWrapper(value)) value = openEncryptedField(value, atRestKey);
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}
function envelopeData(document) {
  const data = document?.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}
function credentialFromDocument(document, source, atRestKey = null) {
  if (!document || typeof document !== 'object') return null;
  const auth = document.auth && typeof document.auth === 'object' ? document.auth : document;
  const account = document.account && typeof document.account === 'object' ? document.account : document;
  const accessToken = firstString(auth, ['accessToken', 'access_token'], atRestKey);
  const refreshToken = firstString(auth, ['refreshToken', 'refresh_token'], atRestKey);
  if (!accessToken || !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    expiresAtMs: toMs(auth.expiresAt ?? auth.expiresAtMs),
    refreshExpiresAtMs: toMs(auth.refreshExpiresAt ?? auth.refreshExpiresAtMs),
    lastRefreshAtMs: toMs(auth.lastRefreshTime ?? auth.lastRefreshAtMs ?? document.refreshedAtMs),
    domain: firstString(auth, ['domain'], atRestKey) || firstString(account, ['domain'], atRestKey),
    uid: firstString(account, ['uid', 'userId'], atRestKey),
    nickname: firstString(account, ['nickname', 'displayName'], atRestKey),
    uin: firstString(account, ['uin'], atRestKey),
    enterpriseId: firstString(account, ['enterpriseId'], atRestKey),
    source
  };
}
function isFresherDesktopCandidate(candidate, best) {
  if (!best) return true;
  if (candidate.liveRank !== best.liveRank) return candidate.liveRank > best.liveRank;
  if (candidate.lastRefreshAtMs !== best.lastRefreshAtMs) return candidate.lastRefreshAtMs > best.lastRefreshAtMs;
  if (candidate.expiresAtMs !== best.expiresAtMs) return candidate.expiresAtMs > best.expiresAtMs;
  return candidate.mtimeMs > best.mtimeMs;
}
function maskAccount(account) {
  if (!account) return null;
  const uin = account.uin || '';
  return {
    nickname: account.nickname || 'WorkBuddy 账号',
    uin: uin ? uin.slice(0, 3) + '******' + uin.slice(-3) : '',
    uidTail: account.uid ? account.uid.slice(-6) : ''
  };
}
function headersFor(credential, json = false) {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(credential.uid ? { 'X-User-Id': credential.uid } : {}),
    ...(credential.enterpriseId ? { 'X-Enterprise-Id': credential.enterpriseId } : {}),
    ...(credential.domain ? { 'X-Domain': credential.domain } : {}),
    Origin: CN_BILLING,
    Referer: CN_BILLING + '/',
    'User-Agent': PRODUCT_UA
  };
}

export function createWorkbuddy({
  credentials,
  fetchCheckin = fetch,
  fetchBilling = fetch,
  fetchRefresh = fetch,
  desktopAuthDirs,
  vaultDir = VAULT_DIR,
  legacyAuthFile = LEGACY_AUTH,
  atRestKey
} = {}) {
  let cached = null;
  let inflightLoad = null;
  let encryptedDesktopBlocked = false;
  const sessions = new Map();
  const pendingCheckins = new Map();
  const authDirs = Array.isArray(desktopAuthDirs) ? desktopAuthDirs : desktopAuthDirs ? [desktopAuthDirs] : defaultDesktopAuthDirs();
  const resolveAtRestKey = async () => {
    if (atRestKey !== undefined) {
      const raw = typeof atRestKey === 'function' ? await atRestKey() : atRestKey;
      if (!raw) return null;
      return typeof raw === 'string' ? deriveAtRestKey(raw) : raw;
    }
    return readDefaultAtRestKey();
  };
  const requireCredentials = () => {
    if (!credentials || typeof credentials.readRecord !== 'function' || typeof credentials.modifyRecord !== 'function') {
      throw new Error('DSH credentials service unavailable');
    }
    return credentials;
  };
  const readStored = async () => {
    const record = await requireCredentials().readRecord(CRED_KEY);
    if (!record || record.kind !== 'grant' || !record.payload || typeof record.payload !== 'object') return null;
    const value = record.payload;
    if (!value.accessToken || !value.refreshToken) return null;
    return { ...value, source: 'dsh-credential' };
  };
  const writeStored = async credential => {
    const payload = {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAtMs: credential.expiresAtMs || 0,
      refreshExpiresAtMs: credential.refreshExpiresAtMs || 0,
      lastRefreshAtMs: credential.lastRefreshAtMs || 0,
      domain: credential.domain || '',
      uid: credential.uid || '',
      nickname: credential.nickname || '',
      uin: credential.uin || '',
      enterpriseId: credential.enterpriseId || '',
      savedAt: new Date().toISOString()
    };
    await requireCredentials().modifyRecord(CRED_KEY, current => ({ kind: 'grant', payload }));
    cached = { ...payload, source: credential.source || 'dsh-credential' };
    return cached;
  };
  const scanVault = async () => {
    let names = [];
    try { names = (await readdir(vaultDir)).filter(name => name.endsWith('.json')); } catch { return null; }
    let best = null;
    for (const name of names) {
      try {
        const file = join(vaultDir, name);
        const doc = JSON.parse(await readFile(file, 'utf8'));
        const key = hasEncryptedFields(doc) ? await resolveAtRestKey() : null;
        const credential = credentialFromDocument(doc, 'vault', key);
        if (!credential) continue;
        const stamp = credential.lastRefreshAtMs || doc.refreshedAtMs || (await stat(file)).mtimeMs;
        if (!best || stamp > best.stamp) best = { credential, stamp };
      } catch {}
    }
    return best?.credential ?? null;
  };
  const scanDesktop = async () => {
    let best = null;
    let sawEncrypted = false;
    let resolvedKey;
    const getKey = async () => {
      if (resolvedKey === undefined) resolvedKey = await resolveAtRestKey();
      return resolvedKey;
    };
    const inspectFile = async (file, liveRank) => {
      try {
        const doc = JSON.parse(await readFile(file, 'utf8'));
        const encrypted = hasEncryptedFields(doc);
        if (encrypted) sawEncrypted = true;
        const credential = credentialFromDocument(doc, 'desktop', encrypted ? await getKey() : null);
        if (!credential) return;
        const mtimeMs = (await stat(file)).mtimeMs;
        const candidate = {
          credential,
          liveRank,
          lastRefreshAtMs: credential.lastRefreshAtMs || 0,
          expiresAtMs: credential.expiresAtMs || 0,
          mtimeMs
        };
        if (isFresherDesktopCandidate(candidate, best)) best = candidate;
      } catch {}
    };
    for (const dir of authDirs) {
      let names = [];
      try { names = await readdir(dir); } catch { continue; }
      for (const name of LIVE_FILES) {
        if (names.includes(name)) await inspectFile(join(dir, name), 1);
      }
      for (const name of names) {
        if (LIVE_FILES.includes(name) || !name.endsWith('.info')) continue;
        await inspectFile(join(dir, name), 0);
      }
    }
    if (!best && legacyAuthFile) {
      await inspectFile(legacyAuthFile, 0);
    }
    encryptedDesktopBlocked = Boolean(!best && sawEncrypted);
    return best?.credential ?? null;
  };
  const refreshToken = async credential => {
    const response = await fetchRefresh(`${CN_CHAT}${API_PREFIX}/auth/token/refresh`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...(credential.uid ? { 'X-User-Id': credential.uid } : {}),
        ...(credential.enterpriseId ? { 'X-Enterprise-Id': credential.enterpriseId } : {}),
        ...(credential.domain ? { 'X-Domain': credential.domain } : {}),
        'X-Refresh-Token': credential.refreshToken,
        'X-Auth-Refresh-Source': 'workbuddy',
        Origin: CN_BILLING,
        Referer: CN_BILLING + '/',
        'User-Agent': PRODUCT_UA
      },
      signal: AbortSignal.timeout(30000)
    });
    const document = await response.json().catch(() => null);
    if (!response.ok || !document) throw new Error('WorkBuddy token refresh failed: HTTP ' + response.status);
    const data = envelopeData(document);
    const accessToken = firstString(data, ['accessToken', 'access_token']);
    if (!accessToken) throw new Error('WorkBuddy token refresh returned no accessToken');
    return {
      ...credential,
      accessToken,
      refreshToken: firstString(data, ['refreshToken', 'refresh_token']) || credential.refreshToken,
      expiresAtMs: toMs(data.expiresAt ?? data.expiresAtMs) || (typeof data.expiresIn === 'number' ? nowMs() + data.expiresIn * 1000 : credential.expiresAtMs),
      refreshExpiresAtMs: toMs(data.refreshExpiresAt ?? data.refreshExpiresAtMs) || credential.refreshExpiresAtMs || 0,
      lastRefreshAtMs: toMs(data.lastRefreshTime) || nowMs(),
      domain: firstString(data, ['domain']) || credential.domain,
      uid: firstString(data, ['uid', 'userId']) || credential.uid,
      nickname: firstString(data, ['nickname', 'displayName']) || credential.nickname,
      uin: firstString(data, ['uin']) || credential.uin,
      enterpriseId: firstString(data, ['enterpriseId']) || credential.enterpriseId
    };
  };
  const loadCredential = async (forceRefresh = false) => {
    if (!forceRefresh && cached && (!cached.expiresAtMs || cached.expiresAtMs > nowMs() + REFRESH_MARGIN_MS)) {
      return cached;
    }
    if (inflightLoad) return inflightLoad;
    const task = (async () => {
      encryptedDesktopBlocked = false;
      let credential = forceRefresh ? cached : await readStored();
      if (!credential) credential = await scanVault();
      if (!credential) credential = await scanDesktop();
      if (!credential) return null;
      const needsRefresh = forceRefresh || !credential.expiresAtMs || credential.expiresAtMs <= nowMs() + REFRESH_MARGIN_MS;
      if (needsRefresh) {
        try {
          credential = await refreshToken(credential);
        } catch (refreshErr) {
          if (credential.expiresAtMs && credential.expiresAtMs > nowMs() + FALLBACK_VALID_MS) {
            // Token is still valid for >30s; keep using it despite transient refresh failure.
          } else if (credential.source === 'dsh-credential') {
            const fallback = (await scanVault()) || (await scanDesktop());
            if (fallback && (!fallback.expiresAtMs || fallback.expiresAtMs > nowMs() + FALLBACK_VALID_MS)) {
              credential = fallback;
            } else if (credential.expiresAtMs && credential.expiresAtMs <= nowMs()) {
              throw refreshErr;
            }
          } else if (credential.expiresAtMs && credential.expiresAtMs <= nowMs()) {
            throw refreshErr;
          }
        }
      }
      if (credential.accessToken) await writeStored(credential);
      cached = credential;
      return credential;
    })();
    inflightLoad = task;
    try { return await task; }
    finally { if (inflightLoad === task) inflightLoad = null; }
  };
  const requireCredential = async () => {
    const credential = await loadCredential();
    if (credential) return credential;
    if (encryptedDesktopBlocked) {
      throw new Error('AUTH_BOUNDARY: WorkBuddy 桌面端凭据已加密（5.6.0+），无法读取本机密钥；请使用 Web 登录或设置 WORKBUDDY_APP_EXECUTABLE');
    }
    throw new Error('WorkBuddy 未登录：请先在 WorkBuddy 桌面端登录，或使用 Web 登录');
  };
  const listModels = async () => {
    const credential = await requireCredential();
    const response = await fetch(`${CN_CHAT}/v3/config`, { headers: headersFor(credential), signal: AbortSignal.timeout(30000) });
    const document = await response.json().catch(() => null);
    if (!response.ok || !document || document.code !== 0) {
      throw new Error('WorkBuddy 模型目录读取失败: HTTP ' + response.status);
    }
    const data = envelopeData(document);
    const agents = Array.isArray(data.agents) ? data.agents : [];
    const cli = agents.find(agent => agent?.name === 'cli') || agents.find(agent => Array.isArray(agent?.models) && agent.models.length);
    const ids = cli && Array.isArray(cli.models) ? new Set(cli.models.map(String)) : null;
    const all = Array.isArray(data.models) ? data.models : [];
    const models = all.filter(model => model && typeof model.id === 'string' && (!ids || ids.has(model.id))).map(model => ({
      id: model.id,
      name: model.name || model.id,
      credits: typeof model.credits === 'string' || typeof model.credits === 'number' ? model.credits : undefined,
      contextWindow: typeof model.maxInputTokens === 'number' ? model.maxInputTokens : undefined,
      maxOutput: typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : undefined,
      tools: model.supportsToolCall === true
    }));
    return { models, account: maskAccount(credential), source: credential.source };
  };
  // TODO(enterprise-billing): When `credential.enterpriseId` is non-empty, support querying
  // POST `${CN_BILLING}/v2/billing/meter/get-enterprise-user-usage` (credit / limitNum / remainDay)
  // in addition to personal resource packages (`get-user-resource`).
  const credits = async () => {
    const credential = await requireCredential();
    const now = new Date();
    const fmt = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    const readPage = async page => {
      const response = await fetchBilling(`${CN_BILLING}/v2/billing/meter/get-user-resource`, {
        method:'POST', redirect:'error', headers:headersFor(credential,true),
        body:JSON.stringify({
          PageNumber: page,
          PageSize: 100,
          ProductCode: 'p_tcaca',
          Status: [0, 3],
          PackageEndTimeRangeBegin: fmt(now),
          PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6))
        }),
        signal:AbortSignal.timeout(30_000)
      });
      const document = await response.json().catch(() => null);
      const data = envelopeData(document).Response?.Data;
      if (!response.ok || document?.code !== 0 || (!Array.isArray(data?.Accounts) && data?.TotalCount !== 0)) {
        throw new Error('WorkBuddy 积分读取失败: HTTP ' + response.status);
      }
      return {...data, Accounts:Array.isArray(data.Accounts) ? data.Accounts : []};
    };
    const first = await readPage(1);
    const accounts = [...first.Accounts];
    for (let page = 2; accounts.length < Number(first.TotalCount); page++) {
      const next = await readPage(page);
      if (!next.Accounts.length) break;
      accounts.push(...next.Accounts);
    }
    let total = 0;
    const packages = [];
    for (const item of accounts) {
      if (!item || typeof item !== 'object') continue;
      const monthly = item.CapacityType === 4;
      const raw = item.CycleCapacityRemainPrecise ?? item.CycleCapacityRemain ?? item.CapacityRemainPrecise ?? item.CapacityRemain;
      const remain = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? '0'));
      if (!Number.isFinite(remain)) continue;
      const expire = toMs(item.ExpiredTime) || toMs(item.CycleEndTime);
      if (!monthly && (remain <= 0 || (expire && expire <= nowMs()))) continue;
      const remaining = Math.max(0,remain);
      total += remaining;
      const size = Number.parseFloat(String(item.CycleCapacitySizePrecise ?? item.CycleCapacitySize ?? item.CapacitySizePrecise ?? item.CapacitySize ?? ''));
      const cycle = toMs(item.CycleEndTime);
      packages.push({
        monthly, name:firstString(item,['PackageName']),
        remaining, total:Number.isFinite(size) && size >= 0 ? size : null,
        endsAt: (monthly ? cycle || expire : expire) || null
      });
    }
    packages.sort((a,b) => Number(b.monthly)-Number(a.monthly) || (a.endsAt ?? Infinity)-(b.endsAt ?? Infinity));
    return { remaining: Number(total.toFixed(6)), packages, account: maskAccount(credential), source: 'workbuddy-billing' };
  };
  const checkinRequest = async (credential, endpoint, signal) => {
    const timeout = AbortSignal.timeout(12_000);
    const response = await fetchCheckin(`${CN_BILLING}/v2/billing/meter/${endpoint}`, {
      method:'POST', redirect:'error', headers:headersFor(credential,true), body:'{}',
      signal:signal ? AbortSignal.any([signal,timeout]) : timeout
    });
    const document = await response.json().catch(() => null);
    if (!response.ok || document?.code !== 0 || !document.data || typeof document.data !== 'object') {
      throw new Error(`WorkBuddy 签到接口请求失败（HTTP ${response.status}，业务状态 ${Number.isInteger(document?.code) ? document.code : '未知'}）`);
    }
    return document.data;
  };
  const readCheckin = async (credential, signal) => {
    if (!credential?.uid) return null;
    const data = await checkinRequest(credential, 'checkin-activity-status', signal);
    if (typeof data.active !== 'boolean' || data.active && typeof data.today_checked_in !== 'boolean') {
      throw new Error('WorkBuddy 未返回可识别的签到状态');
    }
    return {active:data.active, claimed:data.today_checked_in === true,
      ...(Number.isFinite(data.streak_days) ? {streakDays:data.streak_days} : {})};
  };
  const checkinStatus = async signal => readCheckin(await loadCredential(), signal);
  const claimCheckin = async signal => {
    const credential = await loadCredential();
    if (!credential?.uid) throw new Error('请先登录 WorkBuddy');
    const key = credential.uid;
    if (pendingCheckins.has(key)) return pendingCheckins.get(key);
    const task = (async () => {
      const status = await readCheckin(credential, signal);
      if (!status?.active || status.claimed) return status;
      const data = await checkinRequest(credential, 'daily-checkin', signal);
      return {active:true, claimed:true,
        ...(Number.isFinite(data.credit) ? {credit:data.credit} : {}),
        ...(Number.isFinite(data.streak_days) ? {streakDays:data.streak_days} : {})};
    })();
    pendingCheckins.set(key,task);
    try { return await task; }
    finally { pendingCheckins.delete(key); }
  };
  const chat = async (prompt, model, { signal, onText, reasoningEffort } = {}) => {
    const credential = await requireCredential();
    const response = await fetch(`${CN_CHAT}/v2/chat/completions`, {
      method: 'POST',
      headers: { ...headersFor(credential, true), Accept: 'text/event-stream' },
      body: JSON.stringify({ model: model || 'auto', messages: [{ role: 'user', content: String(prompt || '') }], stream: true, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`WorkBuddy chat failed: HTTP ${response.status}${detail ? ' · ' + detail.slice(0, 180) : ''}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('WorkBuddy chat returned no body');
    const decoder = new TextDecoder();
    let buffer = '', text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const delta = chunk?.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') text += delta.content;
      }
    }
    if (!text.trim()) throw new Error('WorkBuddy chat returned no assistant text');
    onText?.(text);
    return { text };
  };
  const startLogin = async () => {
    const response = await fetch(`${CN_BILLING}${API_PREFIX}/auth/state?platform=workbuddy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': PRODUCT_UA },
      body: '{}',
      signal: AbortSignal.timeout(30000)
    });
    const document = await response.json().catch(() => null);
    if (!document) throw new Error('WorkBuddy 登录服务没有返回 JSON');
    const data = envelopeData(document);
    const state = firstString(data, ['state']);
    if (!state) throw new Error('WorkBuddy 登录服务没有返回 state');
    const url = firstString(data, ['authUrl', 'auth_url', 'url']) || `${CN_BILLING}/login?state=${encodeURIComponent(state)}`;
    const loginId = 'wbo_' + randomUUID().replaceAll('-', '');
    sessions.set(loginId, { state, url, expiresAt: nowMs() + 600000 });
    return { loginId, verificationUri: url, expiresIn: 600 };
  };
  const pollLogin = async loginId => {
    const session = sessions.get(loginId);
    if (!session) return { done: true, error: '登录会话不存在，请重新发起' };
    if (nowMs() > session.expiresAt) { sessions.delete(loginId); return { done: true, error: '登录已超时，请重新发起' }; }
    const response = await fetch(`${CN_BILLING}${API_PREFIX}/auth/token?state=${encodeURIComponent(session.state)}`, {
      headers: { Accept: 'application/json', 'User-Agent': PRODUCT_UA },
      signal: AbortSignal.timeout(30000)
    });
    const document = await response.json().catch(() => null);
    if (!document) return { done: false };
    const code = typeof document.code === 'number' ? document.code : -1;
    if (code !== 0 && code !== 200) return { done: false };
    const data = envelopeData(document);
    const accessToken = firstString(data, ['accessToken', 'access_token']);
    if (!accessToken) return { done: false };
    const profileResponse = await fetch(`${CN_BILLING}${API_PREFIX}/login/account`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': PRODUCT_UA },
      signal: AbortSignal.timeout(30000)
    }).catch(() => null);
    const profileDocument = profileResponse ? await profileResponse.json().catch(() => null) : null;
    const profile = profileDocument ? envelopeData(profileDocument) : {};
    const credential = {
      accessToken,
      refreshToken: firstString(data, ['refreshToken', 'refresh_token']),
      expiresAtMs: toMs(data.expiresAt) || (typeof data.expiresIn === 'number' ? nowMs() + data.expiresIn * 1000 : 0),
      domain: firstString(data, ['domain', 'Domain']) || firstString(profile, ['domain']),
      uid: firstString(profile, ['uid', 'userId']),
      nickname: firstString(profile, ['nickname', 'displayName']),
      uin: firstString(profile, ['uin']),
      enterpriseId: firstString(profile, ['enterpriseId']),
      source: 'oauth'
    };
    if (!credential.refreshToken) return { done: true, error: 'WorkBuddy 登录返回没有 refreshToken' };
    await writeStored(credential);
    sessions.delete(loginId);
    return { done: true, account: maskAccount(credential) };
  };
  const snapshot = async () => {
    try {
      const credential = await loadCredential();
      if (!credential) {
        return {
          loggedIn: false,
          account: null,
          models: [],
          credits: null,
          ...(encryptedDesktopBlocked ? { error: 'AUTH_BOUNDARY: WorkBuddy 桌面端凭据已加密（5.6.0+），无法读取本机密钥；请使用 Web 登录或设置 WORKBUDDY_APP_EXECUTABLE' } : {})
        };
      }
      let models = [], credit = null;
      let error = '';
      try { models = (await listModels()).models; } catch (e) { error = String(e?.message || e); }
      try { credit = await credits(); } catch (e) { error = (error ? error + '；' : '') + String(e?.message || e); }
      return { loggedIn: true, account: maskAccount(credential), models, credits: credit, source: credential.source, error: error || null };
    } catch (error) {
      return { loggedIn: false, account: null, models: [], credits: null, error: String(error?.message || error) };
    }
  };
  return { snapshot, startLogin, pollLogin, listModels, credits, chat, checkinStatus, claimCheckin };
}
