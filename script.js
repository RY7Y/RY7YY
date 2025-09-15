// script.js — Cloudflare Worker (متوافق مع RY7LoginViewController.m)
//
// [[kv_namespaces]]
// binding = "KV_CODES"
// id = "<KV_CODES_ID>"
//
// [[kv_namespaces]]
// binding = "KV_ACTIVATIONS"
// id = "<KV_ACTIVATIONS_ID>"

// ======================= إعدادات أساسية =======================

// قائمة الأكواد الأولية (قراءة فقط) من نطاقك
const CODES_JSON_URL = "https://devry7yy.org/codes.json";

// مدة صلاحية لكل نوع
const DURATION = { monthly: 30, yearly: 365 };

// تخزين كاش الأكواد (ثواني)
const CODES_CACHE_TTL = 600; // 10 دقائق

// إعدادات لوحة الإدارة
const ADMIN_USER = "admin";
const ADMIN_PASS = "Ry@112233";
const ADMIN_COOKIE = "ry7_admin";
const ADMIN_SESSION_TTL = 24 * 3600; // 24 ساعة

// ============================================================

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const { KV_CODES, KV_ACTIVATIONS } = env;

      // ───────────────────────────
      // لوحة الإدارة (واجهة HTML/JS)
      // ───────────────────────────

      // صفحة HTML للوحة: /admin  (index1.html)
      if (request.method === "GET" && url.pathname === "/admin") {
        return htmlResponse(ADMIN_HTML);
      }

      // ملف سكربت اللوحة: /admin/script1.js
      if (request.method === "GET" && url.pathname === "/admin/script1.js") {
        return jsResponse(ADMIN_JS);
      }

      // تسجيل الدخول: POST /admin/login {username, password}
      if (request.method === "POST" && url.pathname === "/admin/login") {
        const { username, password } = await safeJson(request);
        if (username !== ADMIN_USER || password !== ADMIN_PASS) {
          return json({ success: false, message: "بيانات الدخول غير صحيحة." }, 401);
        }
        const sid = await newSession(KV_CODES, ADMIN_SESSION_TTL);
        return withSetCookie(json({ success: true, message: "تم تسجيل الدخول بنجاح." }), sid);
      }

      // تسجيل الخروج: POST /admin/logout
      if (request.method === "POST" && url.pathname === "/admin/logout") {
        const sid = getCookie(request, ADMIN_COOKIE);
        if (sid) await KV_CODES.delete(sessionKey(sid));
        return clearCookie(json({ success: true, message: "تم تسجيل الخروج." }));
      }

      // APIs محمية للوحة:
      if (url.pathname.startsWith("/admin/api/")) {
        // تأكد من الجلسة
        const sid = getCookie(request, ADMIN_COOKIE);
        if (!sid || !(await hasSession(KV_CODES, sid))) {
          return json({ success: false, message: "غير مصرح. سجّل الدخول أولاً." }, 401);
        }

        // GET /admin/api/list  → يعرض الأكواد + سجل الاستخدام
        if (request.method === "GET" && url.pathname === "/admin/api/list") {
          const allowed = await getAllowedRaw(KV_CODES); // كقوائم Array
          const usage = await listUsage(KV_CODES, 200);
          return json({ success: true, allowed, usage });
        }

        // POST /admin/api/add { type: "monthly"|"yearly", codes: string[] }
        if (request.method === "POST" && url.pathname === "/admin/api/add") {
          const { type, codes } = await safeJson(request);
          if (!["monthly", "yearly"].includes(type) || !Array.isArray(codes)) {
            return json({ success: false, message: "باراميترات غير صحيحة." }, 400);
          }
          const data = await getAllowedRaw(KV_CODES);
          data[type] = Array.from(new Set([...(data[type] || []), ...codes.map(s => (s || "").trim()).filter(Boolean)]));
          await saveAllowedRaw(KV_CODES, data);
          return json({ success: true, message: "تمت الإضافة.", allowed: data });
        }

        // POST /admin/api/remove { type, code }
        if (request.method === "POST" && url.pathname === "/admin/api/remove") {
          const { type, code } = await safeJson(request);
          if (!["monthly", "yearly"].includes(type) || !(code || "").trim()) {
            return json({ success: false, message: "باراميترات غير صحيحة." }, 400);
          }
          const data = await getAllowedRaw(KV_CODES);
          data[type] = (data[type] || []).filter(c => c !== code);
          await saveAllowedRaw(KV_CODES, data);
          return json({ success: true, message: "تم الحذف.", allowed: data });
        }

        // POST /admin/api/generate { type: "monthly"|"yearly", count: number }
        if (request.method === "POST" && url.pathname === "/admin/api/generate") {
          const { type, count } = await safeJson(request);
          if (!["monthly", "yearly"].includes(type)) {
            return json({ success: false, message: "نوع غير صحيح." }, 400);
          }
          const n = clampInt(count, 1, 200);
          const data = await getAllowedRaw(KV_CODES);
          const existing = new Set([...(data.monthly || []), ...(data.yearly || [])]);
          const created = [];
          while (created.length < n) {
            const k = genCode();
            if (!existing.has(k)) {
              existing.add(k);
              created.push(k);
            }
          }
          data[type] = Array.from(new Set([...(data[type] || []), ...created]));
          await saveAllowedRaw(KV_CODES, data);
          return json({ success: true, created, allowed: data });
        }

        return json({ success: false, message: "API غير معروفة." }, 404);
      }

      // ─────────────────────────────────────────────────────────────────────
      // GET /status?deviceId=...&bundleId=...
      // يتحقق من وجود تفعيل ساري لهذا الجهاز وهذا التطبيق معًا
      // ─────────────────────────────────────────────────────────────────────
      if (url.pathname === "/status" && request.method === "GET") {
        const deviceId  = (url.searchParams.get("deviceId")  || "").trim();
        const bundleId  = (url.searchParams.get("bundleId")  || "").trim();

        if (!deviceId || !bundleId) {
          return json({ success: false, message: "deviceId أو bundleId مفقود." }, 400);
        }

        const deviceBundleKey = `device:${deviceId}:${bundleId}`;
        const activeJson = await KV_ACTIVATIONS.get(deviceBundleKey, "json");

        if (!activeJson) {
          return json({
            success: true,
            active: false,
            message: "لا يوجد تفعيل محفوظ لهذا الجهاز/التطبيق."
          });
        }

        const { code, type, start, durationDays, deviceName } = activeJson;
        const { expiresAt, remainingDays } = computeExpiry(start, durationDays);

        if (remainingDays <= 0) {
          return json({
            success: true,
            active: false,
            code,
            type,
            expiresAt,
            remainingDays: 0,
            message: "⌛ انتهت صلاحية التفعيل السابق. أدخل كود جديد."
          });
        }

        return json({
          success: true,
          active: true,
          code,
          type,
          expiresAt,
          remainingDays,
          deviceName,
          bundleId,
          message: "✅ تفعيل ساري لهذا الجهاز وهذا التطبيق."
        });
      }

      // ─────────────────────────────────────────────────────────────────────
      // POST /activate
      // body: { deviceId, deviceName, bundleId, code }
      // يفعل الكود على هذا الجهاز وهذا التطبيق تحديدًا (One-Time: code + deviceId + bundleId)
      // ─────────────────────────────────────────────────────────────────────
      if (url.pathname === "/activate" && request.method === "POST") {
        const body = await safeJson(request);
        const deviceId   = (body.deviceId   || "").trim();
        const deviceName = (body.deviceName || "غير معروف").trim();
        const bundleId   = (body.bundleId   || "").trim();
        const code       = (body.code       || "").trim();

        if (!deviceId || !bundleId || !code) {
          return json({ success: false, message: "deviceId أو bundleId أو code مفقود." }, 400);
        }

        // 1) جلب الأكواد المصرح بها (من الكاش أو من CODES_JSON_URL)
        const allowed = await getAllowedCodes(KV_CODES);

        // 2) تحديد النوع من القائمة
        const type = resolveType(code, allowed);
        if (!type) {
          return json({ success: false, message: "الكود غير صحيح أو غير مدعوم." }, 400);
        }
        const durationDays = DURATION[type];

        // مفاتيح الحالة
        const codeKey          = `code:${code}`;                    // حالة الكود عالميًا
        const deviceBundleKey  = `device:${deviceId}:${bundleId}`;  // هذا الجهاز + هذا التطبيق
        const deviceKeyLegacy  = `device:${deviceId}`;              // توافق قديم (إن وُجد)

        // 3) تحقق حالة الكود عالميًا:
        const codeState = await KV_ACTIVATIONS.get(codeKey, "json");
        if (codeState) {
          const sameDevice = codeState.deviceId === deviceId;
          const sameBundle = (codeState.bundleId || "") === bundleId;

          if (sameDevice && sameBundle) {
            const { expiresAt, remainingDays } = computeExpiry(codeState.start, codeState.durationDays);
            if (remainingDays > 0) {
              return json({
                success: true,
                code,
                type: codeState.type,
                durationDays: codeState.durationDays,
                expiresAt,
                remainingDays,
                deviceName: codeState.deviceName,
                bundleId: codeState.bundleId,
                message: "✅ دخول تلقائي: الكود مفعل سابقًا على نفس الجهاز ونفس التطبيق."
              });
            } else {
              return json({ success: false, message: "⌛ انتهت صلاحية الكود السابق على هذا الجهاز والتطبيق." }, 403);
            }
          }

          if (sameDevice && !sameBundle) {
            return json({
              success: false,
              message: "🚫 هذا الكود مقترن بتطبيق آخر على نفس الجهاز ولا يمكن استخدامه في تطبيق مختلف."
            }, 403);
          }

          return json({
            success: false,
            message: "🚫 هذا الكود مستخدم على جهاز آخر ولا يمكن إعادة استخدامه."
          }, 403);
        }

        // 4) تفعيل جديد للجهاز الحالي وهذا التطبيق فقط
        const now = Math.floor(Date.now() / 1000);
        const activation = {
          code,
          type,
          deviceId,
          deviceName,
          bundleId,
          start: now,
          durationDays,
          activatedAt: new Date().toISOString()
        };

        // خزّن حالة الكود عالميًا
        await KV_ACTIVATIONS.put(codeKey, JSON.stringify(activation), { expirationTtl: 400 * 24 * 3600 });

        // خزّن حالة الجهاز+التطبيق (للدخول التلقائي)
        await KV_ACTIVATIONS.put(deviceBundleKey, JSON.stringify(activation), { expirationTtl: 400 * 24 * 3600 });

        // (اختياري) تنظيف مدخل التوافق القديم إن وجد
        await KV_ACTIVATIONS.delete(deviceKeyLegacy).catch(() => {});

        // احذف الكود من القائمة المتاحة حتى لا يستهلكه أحد آخر
        await removeCodeFromAllowed(KV_CODES, type, code);

        // سجل الاستخدام في KV (سجل منفصل)
        await logUsage(KV_CODES, activation);

        const { expiresAt, remainingDays } = computeExpiry(now, durationDays);
        return json({
          success: true,
          code,
          type,
          durationDays,
          expiresAt,
          remainingDays,
          deviceName,
          bundleId,
          message: `✅ تم التفعيل بنجاح — الكود مربوط بهذا التطبيق (${bundleId}) وهذا الجهاز فقط.`
        });
      }

      // مسارات أخرى
      return json({ ok: true, message: "RY7 Worker running." });
    } catch (e) {
      return json({ success: false, message: "Server error", error: String(e) }, 500);
    }
  }
};

// ====================== المساعدات العامة ======================

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function jsResponse(js) {
  return new Response(js, {
    status: 200,
    headers: { "content-type": "text/javascript; charset=utf-8" }
  });
}

function withSetCookie(resp, sid) {
  resp.headers.set("Set-Cookie",
    `${ADMIN_COOKIE}=${sid}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL}`);
  return resp;
}

function clearCookie(resp) {
  resp.headers.set("Set-Cookie",
    `${ADMIN_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0`);
  return resp;
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const parts = cookie.split(";").map(s => s.trim());
  for (const p of parts) {
    if (p.startsWith(`${name}=`)) return p.slice(name.length + 1);
  }
  return null;
}

function computeExpiry(startUnixSec, durationDays) {
  const startMs = startUnixSec * 1000;
  const expiresAt = startMs + durationDays * 24 * 60 * 60 * 1000;
  const remainingMs = Math.max(0, expiresAt - Date.now());
  const remainingDays = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  return { expiresAt: Math.floor(expiresAt / 1000), remainingDays };
}

function resolveType(code, allowed) {
  if (allowed.monthly && allowed.monthly.has(code)) return "monthly";
  if (allowed.yearly && allowed.yearly.has(code)) return "yearly";
  return null;
}

async function safeJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function clampInt(n, min, max) {
  n = parseInt(n, 10);
  if (Number.isNaN(n)) n = min;
  return Math.max(min, Math.min(max, n));
}

// ============ إدارة جلسات الأدمن (KV) ============
function sessionKey(sid) { return `admin:sess:${sid}`; }

async function newSession(KV_CODES, ttlSeconds) {
  const sid = cryptoRandomId();
  await KV_CODES.put(sessionKey(sid), JSON.stringify({ createdAt: Date.now() }), { expirationTtl: ttlSeconds });
  return sid;
}

async function hasSession(KV_CODES, sid) {
  const v = await KV_CODES.get(sessionKey(sid));
  return !!v;
}

function cryptoRandomId(len = 24) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

// ============ الأكواد المسموح بها: قراءة/حفظ ============
async function getAllowedCodes(KV_CODES) {
  // على شكل Sets للاستخدام السريع في /activate
  const data = await getAllowedRaw(KV_CODES);
  return toSets(data);
}

async function getAllowedRaw(KV_CODES) {
  // نحاول من KV أولاً
  let data = await KV_CODES.get("allowed-codes", "json");
  const last = await KV_CODES.get("allowed-codes:last", "text");
  const now = Math.floor(Date.now() / 1000);

  if (!data || !last || (now - parseInt(last || "0", 10)) >= CODES_CACHE_TTL) {
    // جلب من ملف JSON العام (قراءة فقط)
    try {
      const res = await fetch(CODES_JSON_URL);
      if (res.ok) {
        const fresh = await res.json();
        // دمج الأكواد الموجودة في KV مع الجديدة من الملف (للحفاظ على أي إضافات سابقة)
        data = mergeAllowed(data, fresh);
        await saveAllowedRaw(KV_CODES, data);
      } else if (!data) {
        data = { monthly: [], yearly: [] };
      }
    } catch {
      if (!data) data = { monthly: [], yearly: [] };
    }
  }

  // ضمان وجود المصفوفات
  if (!Array.isArray(data.monthly)) data.monthly = [];
  if (!Array.isArray(data.yearly)) data.yearly = [];

  return data;
}

function mergeAllowed(existing, fresh) {
  const out = { monthly: [], yearly: [] };
  const eM = new Set((existing && existing.monthly) || []);
  const eY = new Set((existing && existing.yearly) || []);
  const fM = new Set((fresh && fresh.monthly) || []);
  const fY = new Set((fresh && fresh.yearly) || []);
  out.monthly = Array.from(new Set([...eM, ...fM]));
  out.yearly  = Array.from(new Set([...eY, ...fY]));
  return out;
}

async function saveAllowedRaw(KV_CODES, data) {
  await KV_CODES.put("allowed-codes", JSON.stringify({ monthly: data.monthly || [], yearly: data.yearly || [] }));
  await KV_CODES.put("allowed-codes:last", String(Math.floor(Date.now() / 1000)));
}

async function removeCodeFromAllowed(KV_CODES, type, code) {
  const data = await getAllowedRaw(KV_CODES);
  if (Array.isArray(data[type])) {
    data[type] = data[type].filter(c => c !== code);
    await saveAllowedRaw(KV_CODES, data);
  }
}

function toSets(data) {
  return {
    monthly: new Set(data.monthly || []),
    yearly: new Set(data.yearly || [])
  };
}

// ============ سجل الاستخدام ============
async function logUsage(KV_CODES, activation) {
  const { code } = activation;
  const key = `usage:${code}`;
  await KV_CODES.put(key, JSON.stringify(activation));
}

async function listUsage(KV_CODES, limit = 100) {
  const out = [];
  let cursor = undefined;
  do {
    const page = await KV_CODES.list({ prefix: "usage:", cursor, limit: Math.min(limit - out.length, 1000) });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const k of page.keys) {
      const v = await KV_CODES.get(k.name, "json");
      if (v) out.push(v);
      if (out.length >= limit) break;
    }
  } while (cursor && out.length < limit);
  return out;
}

// ============ مولّد الأكواد ============
function genCode() {
  // RY + 8 رموز (A-Z و 0-9)
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "RY";
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// ====================== صفحة الإدارة (HTML) ======================
const ADMIN_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة الأكواد — RY7</title>
<style>
  :root { --bg:#0f172a; --card:#111827; --muted:#94a3b8; --ok:#10b981; --warn:#f59e0b; --err:#ef4444; --txt:#e5e7eb; --link:#60a5fa; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial; background:var(--bg); color:var(--txt); }
  .wrap { max-width: 1100px; margin: 40px auto; padding: 0 16px; }
  .card { background:var(--card); border:1px solid #1f2937; border-radius:14px; padding:18px 20px; margin-bottom:16px; }
  h1 { margin:0 0 12px; font-size:22px; }
  input, select, button, textarea {
    background:#0b1220; border:1px solid #334155; color:var(--txt); border-radius:10px; padding:10px 12px; outline: none;
  }
  button { cursor:pointer; }
  .row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .grow{ flex:1 1 auto; }
  .pill{ font-size:12px; padding:4px 8px; border-radius:999px; display:inline-block; }
  .pill.ok{ background:#052e1a; color:#73e2a8; border:1px solid #14532d; }
  .pill.err{ background:#3b0a0a; color:#fca5a5; border:1px solid #7f1d1d; }
  .list{ display:grid; grid-template-columns: 1fr auto auto; gap:8px; }
  .muted{ color:var(--muted); font-size:13px; }
  .left{ text-align:left; }
  .hide{ display:none; }
  a { color: var(--link); text-decoration: none; }
</style>
</head>
<body>
<div class="wrap">
  <div id="loginCard" class="card">
    <h1>🔐 دخول الأدمن</h1>
    <div class="row">
      <input id="u" placeholder="اسم المستخدم" value="admin">
      <input id="p" placeholder="كلمة المرور" type="password">
      <button id="btnLogin">دخول</button>
    </div>
    <div id="loginMsg" class="muted"></div>
  </div>

  <div id="panel" class="hide">
    <div class="card">
      <div class="row">
        <h1>لوحة الأكواد</h1>
        <span id="loginState" class="pill ok">متصل ✅</span>
        <span class="grow"></span>
        <button id="btnLogout">تسجيل خروج</button>
      </div>
      <div class="muted">إدارة الأكواد المتاحة + الاطلاع على سجل الاستخدام.</div>
    </div>

    <div class="card">
      <h1>➕ إضافة أكواد</h1>
      <div class="row">
        <select id="addType">
          <option value="monthly">شهري (30 يوم)</option>
          <option value="yearly">سنوي (365 يوم)</option>
        </select>
        <input id="addCodes" class="grow" placeholder="أضف أكواد مفصولة بمسافة أو سطر">
        <button id="btnAdd">إضافة</button>
      </div>
      <div class="muted">مثال: RYAAAA111 RYBBBB222 ...</div>
    </div>

    <div class="card">
      <h1>⚙️ توليد أكواد جديدة</h1>
      <div class="row">
        <select id="genType">
          <option value="monthly">شهري</option>
          <option value="yearly">سنوي</option>
        </select>
        <input id="genCount" type="number" min="1" max="200" value="10" style="width:120px">
        <button id="btnGen">توليد</button>
      </div>
      <div class="muted">توليد أكواد تبدأ بـ RY ومكونة من 8 رموز كبيرة/أرقام مع عدم تكرار.</div>
      <div id="genOut" class="muted"></div>
    </div>

    <div class="card">
      <h1>📦 الأكواد المتاحة الآن</h1>
      <div id="listMonthly"></div>
      <div id="listYearly" style="margin-top:16px"></div>
    </div>

    <div class="card">
      <h1>🧾 سجل الاستخدام (آخر 200)</h1>
      <div id="usageBox" class="muted">—</div>
    </div>
  </div>
</div>
<script src="/admin/script1.js"></script>
</body>
</html>`;

// ====================== سكربت لوحة الإدارة (JS) ======================
const ADMIN_JS = `
(async function(){
  const $ = s => document.querySelector(s);
  const loginCard = $('#loginCard');
  const panel = $('#panel');
  const msg = $('#loginMsg');

  async function j(url, opt={}) {
    const r = await fetch(url, Object.assign({ headers: { 'content-type':'application/json' } }, opt));
    return r.json();
  }

  async function tryList() {
    const r = await j('/admin/api/list');
    if (r && r.success) {
      loginCard.classList.add('hide');
      panel.classList.remove('hide');
      renderAllowed(r.allowed);
      renderUsage(r.usage || []);
    } else {
      loginCard.classList.remove('hide');
      panel.classList.add('hide');
    }
  }

  function renderAllowed(allowed) {
    const paint = (type, elId) => {
      const arr = (allowed && allowed[type]) || [];
      const host = document.createElement('div');
      const title = document.createElement('div');
      title.innerHTML = '<div class="row"><div class="pill '+(type==='monthly'?'ok':'warn')+'">'+(type==='monthly'?'شهري':'سنوي')+'</div><div class="muted">(' + arr.length + ' كود)</div></div>';
      host.appendChild(title);
      const list = document.createElement('div');
      list.className = 'list';
      arr.forEach(code=>{
        const c = document.createElement('div'); c.textContent = code;
        const t = document.createElement('div'); t.className='muted'; t.textContent = type==='monthly'?'30 يوم':'365 يوم';
        const x = document.createElement('div'); const b = document.createElement('button'); b.textContent='حذف';
        b.onclick = async()=>{ const r = await j('/admin/api/remove', {method:'POST', body:JSON.stringify({type, code})}); if(r.success) tryList(); };
        x.appendChild(b);
        list.appendChild(c); list.appendChild(t); list.appendChild(x);
      });
      host.appendChild(list);
      $(elId).innerHTML = ''; $(elId).appendChild(host);
    };
    paint('monthly', '#listMonthly');
    paint('yearly',  '#listYearly');
  }

  function renderUsage(arr) {
    if (!arr.length) { $('#usageBox').textContent = '—'; return; }
    const host = document.createElement('div');
    arr.forEach(u=>{
      const d = document.createElement('div');
      d.style.borderBottom = '1px solid #1f2937';
      d.style.padding = '6px 0';
      d.innerHTML = '🔑 <b>'+u.code+'</b> — '+(u.type==='monthly'?'شهري':'سنوي')+' · 📱 '+(u.deviceName||'غير معروف')+' · 🧩 '+(u.bundleId||'-')+' · ⏱ '+(u.activatedAt||'');
      host.appendChild(d);
    });
    $('#usageBox').innerHTML = ''; $('#usageBox').appendChild(host);
  }

  // أزرار
  $('#btnLogin').onclick = async()=>{
    msg.textContent = '';
    const username = $('#u').value.trim();
    const password = $('#p').value.trim();
    const r = await j('/admin/login', { method:'POST', body: JSON.stringify({username, password}) });
    msg.textContent = r.message || '';
    if (r.success) tryList();
  };

  $('#btnLogout').onclick = async()=>{
    await j('/admin/logout', {method:'POST'});
    location.reload();
  };

  $('#btnAdd').onclick = async()=>{
    const type = $('#addType').value;
    const codes = $('#addCodes').value.split(/\\s+/).map(s=>s.trim()).filter(Boolean);
    if (!codes.length) { alert('أدخل أكواد لإضافتها'); return; }
    const r = await j('/admin/api/add', {method:'POST', body: JSON.stringify({type, codes})});
    if (r.success) { $('#addCodes').value=''; await tryList(); } else { alert(r.message||'فشل الإضافة'); }
  };

  $('#btnGen').onclick = async()=>{
    const type = $('#genType').value;
    const count = parseInt($('#genCount').value||'0',10);
    const r = await j('/admin/api/generate', {method:'POST', body: JSON.stringify({type, count})});
    if (r.success) {
      $('#genOut').textContent = 'تم توليد '+ (r.created||[]).length +' كود: ' + (r.created||[]).join(' ');
      await tryList();
    } else {
      alert(r.message||'فشل التوليد');
    }
  };

  // محاولة عرض اللوحة إن كان عندنا جلسة صالحة
  tryList();
})();
`;

// ====================== انتهى ======================