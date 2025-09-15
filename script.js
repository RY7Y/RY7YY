// script.js — Cloudflare Worker (متوافق مع RY7LoginViewController.m)
//
// [[kv_namespaces]]
// binding = "KV_CODES"
// id = "<KV_CODES_ID>"
//
// [[kv_namespaces]]
// binding = "KV_ACTIVATIONS"
// id = "<KV_ACTIVATIONS_ID>"

// ✅ نعتمد على نطاقك الخاص لنشر قائمة الأكواد الأولية (قراءة فقط)
const CODES_JSON_URL = "https://devry7yy.org/codes.json";

// مدة صلاحية لكل نوع
const DURATION = { monthly: 30, yearly: 365 };

// كم ثانية نخزن فيها كاش الأكواد في KV قبل إعادة الجلب من CODES_JSON_URL
const CODES_CACHE_TTL = 600; // 10 دقائق

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const { KV_CODES, KV_ACTIVATIONS } = env;

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
        const body = await request.json().catch(() => ({}));
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

        // مداخل حفظ الحالة
        const codeKey          = `code:${code}`;                    // حالة الكود عالميًا
        const deviceBundleKey  = `device:${deviceId}:${bundleId}`;  // حالة هذا الجهاز + هذا التطبيق
        const deviceKeyLegacy  = `device:${deviceId}`;              // توافق قديم (إن وُجد)

        // 3) تحقق حالة الكود عالميًا:
        const codeState = await KV_ACTIVATIONS.get(codeKey, "json");
        if (codeState) {
          // إذا سبق وتفعل الكود:
          const sameDevice   = codeState.deviceId === deviceId;
          const sameBundle   = (codeState.bundleId || "") === bundleId;

          // حالة 3-أ: نفس الجهاز ونفس التطبيق → دخول تلقائي إن كان ما زال ساري
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

          // حالة 3-ب: نفس الجهاز لكن تطبيق مختلف → ممنوع
          if (sameDevice && !sameBundle) {
            return json({
              success: false,
              message: "🚫 هذا الكود مقترن بتطبيق آخر على نفس الجهاز ولا يمكن استخدامه في تطبيق مختلف."
            }, 403);
          }

          // حالة 3-ج: جهاز مختلف → ممنوع
          return json({
            success: false,
            message: "🚫 هذا الكود مستخدم على جهاز آخر ولا يمكن إعادة استخدامه."
          }, 403);
        }

        // 4) لم يُستخدم الكود من قبل: فعّل الآن للجهاز الحالي وهذا التطبيق فقط
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

        // خزّن حالة الجهاز+التطبيق (للدخول التلقائي لاحقًا)
        await KV_ACTIVATIONS.put(deviceBundleKey, JSON.stringify(activation), { expirationTtl: 400 * 24 * 3600 });

        // (اختياري) تنظيف مدخل التوافق القديم إن كان موجود
        await KV_ACTIVATIONS.delete(deviceKeyLegacy).catch(() => {});

        // احذف الكود من قائمة الأكواد المتاحة حتى لا يستهلكه أحد آخر
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

      // أي مسار آخر
      return json({ ok: true, message: "RY7 Worker running." });
    } catch (e) {
      return json({ success: false, message: "Server error", error: String(e) }, 500);
    }
  }
};

// ───────────────────────────────────────── Helpers ─────────────────────────────────────────

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

// جلب الأكواد من الكاش أو من CODES_JSON_URL ثم تحويلها إلى Sets
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

// حذف الكود من القائمة المتاحة (KV cache) بعد تفعيله
async function removeCodeFromAllowed(KV_CODES, type, code) {
  const data = await KV_CODES.get("allowed-codes", "json");
  if (!data) return;

  if (Array.isArray(data[type])) {
    data[type] = data[type].filter(c => c !== code);
    await KV_CODES.put("allowed-codes", JSON.stringify(data));
    await KV_CODES.put("allowed-codes:last", String(Math.floor(Date.now() / 1000)));
  }
}

// حفظ سجل الاستخدام: usage:<code> → {code, deviceId, deviceName, bundleId, activatedAt}
async function logUsage(KV_CODES, activation) {
  const { code } = activation;
  const key = `usage:${code}`;
  await KV_CODES.put(key, JSON.stringify(activation));
}

function toSets(data) {
  return {
    monthly: new Set(data.monthly || []),
    yearly: new Set(data.yearly || [])
  };
}