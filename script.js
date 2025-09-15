// script.js — Cloudflare Worker (متوافق مع RY7LoginViewController.m)
//
// [[kv_namespaces]]
// binding = "KV_CODES"
// id = "<KV_CODES_ID>"
//
// [[kv_namespaces]]
// binding = "KV_ACTIVATIONS"
// id = "<KV_ACTIVATIONS_ID>"

// ✅ نعتمد على نطاقك الخاص
const CODES_JSON_URL = "https://devry7yy.org/codes.json";

// مدة صلاحية لكل نوع
const DURATION = { monthly: 30, yearly: 365 };
const CODES_CACHE_TTL = 600; // 10 دقائق

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const { KV_CODES, KV_ACTIVATIONS } = env;

      // ✅ استعلام حالة الجهاز
      if (url.pathname === "/status" && request.method === "GET") {
        const deviceId = url.searchParams.get("deviceId") || "";
        if (!deviceId) return json({ success: false, message: "deviceId مفقود" }, 400);

        const deviceKey = `device:${deviceId}`;
        const activeJson = await KV_ACTIVATIONS.get(deviceKey, "json");
        if (!activeJson) {
          return json({ success: true, active: false, message: "لا يوجد تفعيل محفوظ لهذا الجهاز." });
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
            message: "⌛ انتهت صلاحية الكود السابق. أدخل كود جديد."
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
          message: "✅ تفعيل ساري على هذا الجهاز."
        });
      }

      // ✅ تفعيل كود جديد
      if (url.pathname === "/activate" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const deviceId = (body.deviceId || "").trim();
        const code = (body.code || "").trim();
        const deviceName = (body.deviceName || "غير معروف").trim();

        if (!deviceId || !code) {
          return json({ success: false, message: "deviceId أو code مفقود." }, 400);
        }

        // 1) جلب الأكواد المصرح بها
        const allowed = await getAllowedCodes(KV_CODES);

        // 2) تحديد النوع
        const type = resolveType(code, allowed);
        if (!type) return json({ success: false, message: "الكود غير صحيح أو غير مدعوم." }, 400);

        const durationDays = DURATION[type];
        const codeKey = `code:${code}`;
        const deviceKey = `device:${deviceId}`;

        // 3) تحقق هل الكود مستخدم سابقاً
        const codeState = await KV_ACTIVATIONS.get(codeKey, "json");
        if (codeState) {
          if (codeState.deviceId === deviceId) {
            const { expiresAt, remainingDays } = computeExpiry(codeState.start, codeState.durationDays);
            if (remainingDays > 0) {
              return json({
                success: true,
                code,
                type,
                durationDays: codeState.durationDays,
                expiresAt,
                remainingDays,
                deviceName: codeState.deviceName,
                message: "✅ دخول تلقائي: الكود مفعل سابقاً على هذا الجهاز."
              });
            }
            return json({ success: false, message: "⌛ انتهت صلاحية الكود السابق على هذا الجهاز." }, 403);
          }
          return json({ success: false, message: "🚫 الكود مستخدم على جهاز آخر ولا يمكن إعادة استخدامه." }, 403);
        }

        // 4) تفعيل جديد وربطه بالجهاز
        const now = Math.floor(Date.now() / 1000);
        const activation = { 
          code, 
          type, 
          deviceId, 
          deviceName, 
          start: now, 
          durationDays,
          activatedAt: new Date().toISOString()
        };

        await KV_ACTIVATIONS.put(codeKey, JSON.stringify(activation), { expirationTtl: 400 * 24 * 3600 });
        await KV_ACTIVATIONS.put(deviceKey, JSON.stringify(activation), { expirationTtl: 400 * 24 * 3600 });

        // 🔑 نحذف الكود من القائمة حتى لا يستخدمه جهاز آخر
        await removeCodeFromAllowed(KV_CODES, type, code);

        const { expiresAt, remainingDays } = computeExpiry(now, durationDays);

        return json({
          success: true,
          code,
          type,
          durationDays,
          expiresAt,
          remainingDays,
          deviceName,
          message: `✅ تم التفعيل بنجاح — نوع الكود: ${type}, الصلاحية تبدأ من الآن.`
        });
      }

      // ✅ أي مسار آخر
      return json({ ok: true, message: "RY7 Worker running." });
    } catch (e) {
      return json({ success: false, message: "Server error", error: String(e) }, 500);
    }
  }
};

// -------- Helpers --------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
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

async function getAllowedCodes(KV_CODES) {
  const cached = await KV_CODES.get("allowed-codes", "json");
  const last = await KV_CODES.get("allowed-codes:last", "text");
  const now = Math.floor(Date.now() / 1000);

  if (cached && last && now - parseInt(last, 10) < CODES_CACHE_TTL) {
    return toSets(cached);
  }

  const res = await fetch(CODES_JSON_URL);
  if (!res.ok) {
    if (cached) return toSets(cached);
    throw new Error("Failed to fetch codes.json");
  }

  const data = await res.json();
  await KV_CODES.put("allowed-codes", JSON.stringify(data));
  await KV_CODES.put("allowed-codes:last", String(now));

  return toSets(data);
}

async function removeCodeFromAllowed(KV_CODES, type, code) {
  const data = await KV_CODES.get("allowed-codes", "json");
  if (!data) return;

  if (data[type]) {
    data[type] = data[type].filter(c => c !== code);
    await KV_CODES.put("allowed-codes", JSON.stringify(data));
    await KV_CODES.put("allowed-codes:last", String(Math.floor(Date.now() / 1000)));
  }
}

function toSets(data) {
  return {
    monthly: new Set(data.monthly || []),
    yearly: new Set(data.yearly || [])
  };
}