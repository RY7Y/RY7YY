// script.js — Cloudflare Worker
//
// ⬇️ اربط الـ KV namespaces من wrangler.toml:
// [[kv_namespaces]]
// binding = "KV_CODES"
// id = "<KV_CODES_ID>"
//
// [[kv_namespaces]]
// binding = "KV_ACTIVATIONS"
// id = "<KV_ACTIVATIONS_ID>"
//
// ثم: wrangler deploy
//
// متغير التهيئة (اختياري): URL ملف الأكواد العام
const CODES_JSON_URL = "https://ry7y.github.io/RY7YY/codes.json";

// مدة صلاحية كل نوع (أيام)
const DURATION = {
  monthly: 30,
  yearly: 365
};

// كم ثانية نخزن فيها كاش الأكواد في KV قبل إعادة الجلب
const CODES_CACHE_TTL = 600; // 10 دقائق

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const { KV_CODES, KV_ACTIVATIONS } = env;

      if (url.pathname === "/status" && request.method === "GET") {
        const deviceId = url.searchParams.get("deviceId") || "";
        if (!deviceId) {
          return json({ success: false, message: "deviceId مفقود" }, 400);
        }
        const deviceKey = `device:${deviceId}`;
        const activeJson = await KV_ACTIVATIONS.get(deviceKey, "json");
        if (!activeJson) {
          return json({
            success: true,
            active: false,
            message: "لا يوجد تفعيل محفوظ لهذا الجهاز."
          });
        }
        const { code, type, start, durationDays } = activeJson;
        const { expiresAt, remainingDays } = computeExpiry(start, durationDays);
        if (remainingDays <= 0) {
          // انتهت الصلاحية
          return json({
            success: true,
            active: false,
            type,
            code,
            expiresAt,
            remainingDays: 0,
            message: "انتهت صلاحية الكود. يرجى إدخال كود جديد."
          });
        }
        return json({
          success: true,
          active: true,
          type,
          code,
          expiresAt,
          remainingDays,
          message: "تفعيل ساري."
        });
      }

      if (url.pathname === "/activate" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const deviceId = (body.deviceId || "").trim();
        const code = (body.code || "").trim();

        if (!deviceId || !code) {
          return json({ success: false, message: "deviceId أو code مفقود." }, 400);
        }

        // 1) حمّل الأكواد المصرح بها (من KV cache أو من CODES_JSON_URL)
        const allowed = await getAllowedCodes(KV_CODES);

        // 2) حدد النوع (شهري/سنوي)
        const type = resolveType(code, allowed);
        if (!type) {
          return json({ success: false, message: "الكود غير صحيح أو غير مدعوم." }, 400);
        }
        const durationDays = DURATION[type];

        // 3) تحقق حالة الكود: هل استُخدم من قبل عالمياً؟
        const codeKey = `code:${code}`;
        const codeState = await KV_ACTIVATIONS.get(codeKey, "json");

        if (codeState) {
          // الكود سبق تفعيله من قبل
          // لو نفس الجهاز يبغى يستعلم/يدخل من جديد والمدة سارية → نرجع نجاح
          if (codeState.deviceId === deviceId) {
            const { expiresAt, remainingDays } = computeExpiry(codeState.start, codeState.durationDays);
            if (remainingDays > 0) {
              return json({
                success: true,
                type: codeState.type,
                durationDays: codeState.durationDays,
                start: codeState.start,
                expiresAt,
                remainingDays,
                message: "دخول تلقائي: التفعيل سابقًا لنفس الجهاز ولا يزال ساريًا."
              });
            } else {
              return json({
                success: false,
                message: "انتهت صلاحية الكود السابق على هذا الجهاز. أدخل كود جديد."
              }, 403);
            }
          }
          // جهاز مختلف → مرفوض (One-Time Global)
          return json({
            success: false,
            message: "🚫 هذا الكود تم استخدامه مسبقًا على جهاز آخر، ولا يمكن استخدامه مرة أخرى."
          }, 403);
        }

        // 4) لم يُستخدم الكود من قبل: فعّل الآن للجهاز الحالي
        const now = Math.floor(Date.now() / 1000); // UNIX seconds
        const activation = {
          code,
          type,
          deviceId,
          start: now,
          durationDays
        };

        // احفظ: code -> activation
        await KV_ACTIVATIONS.put(codeKey, JSON.stringify(activation), { expirationTtl: 400 * 24 * 3600 }); // TTL طويل

        // واحفظ: device -> activation (يتيح دخول تلقائي لاحقًا)
        const deviceKey = `device:${deviceId}`;
        await KV_ACTIVATIONS.put(deviceKey, JSON.stringify(activation), { expirationTtl: 400 * 24 * 3600 });

        const { expiresAt, remainingDays } = computeExpiry(now, durationDays);

        return json({
          success: true,
          type,
          durationDays,
          start: now,
          expiresAt,
          remainingDays,
          message: `تم التفعيل بنجاح. نوع الكود: ${type} — الصلاحية تبدأ من الآن.`
        });
      }

      // أي مسار آخر
      return json({ ok: true, message: "RY7 Worker up." });
    } catch (e) {
      return json({ success: false, message: "Server error", error: String(e) }, 500);
    }
  }
};

// --------- Helpers ---------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function computeExpiry(startUnixSec, durationDays) {
  const startMs = startUnixSec * 1000;
  const expiresAt = startMs + durationDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const remainingMs = Math.max(0, expiresAt - now);
  const remainingDays = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  return { expiresAt: Math.floor(expiresAt / 1000), remainingDays };
}

function resolveType(code, allowed) {
  if (allowed.monthly && allowed.monthly.has(code)) return "monthly";
  if (allowed.yearly && allowed.yearly.has(code)) return "yearly";
  return null;
}

async function getAllowedCodes(KV_CODES) {
  // جرّب الكاش أولاً
  const cached = await KV_CODES.get("allowed-codes", "json");
  const last = await KV_CODES.get("allowed-codes:last", "text");
  const now = Math.floor(Date.now() / 1000);

  if (cached && last && now - parseInt(last, 10) < CODES_CACHE_TTL) {
    return toSets(cached);
  }

  // حمل من CODES_JSON_URL
  const res = await fetch(CODES_JSON_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) {
    // fallback للكاش القديم لو موجود
    if (cached) return toSets(cached);
    throw new Error("Failed to fetch codes.json");
  }
  const data = await res.json();
  // خزّن في KV
  await KV_CODES.put("allowed-codes", JSON.stringify(data));
  await KV_CODES.put("allowed-codes:last", String(now));

  return toSets(data);
}

function toSets(data) {
  return {
    monthly: new Set(Array.isArray(data.monthly) ? data.monthly : Object.keys(data.monthly || {})),
    yearly: new Set(Array.isArray(data.yearly) ? data.yearly : Object.keys(data.yearly || {}))
  };
}