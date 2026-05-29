// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, accept, x-client-info, prefer, x-supabase-api-version",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
}

function normalizeQrBankCode(bank: string) {
  const code = String(bank || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const aliases: Record<string, string> = {
    MBB: "MB",
    MBBANK: "MB",
  };
  return aliases[code] || code;
}

function paymentQrConfig() {
  const acc =
    (Deno.env.get("SEPAY_QR_ACC") ||
      Deno.env.get("SEPAY_QR_ACCOUNT") ||
      Deno.env.get("SEPAY_QR_ACCOUNT_NO") ||
      "").trim().replace(/\s+/g, "");
  const bank = normalizeQrBankCode(
    Deno.env.get("SEPAY_QR_BANK") || Deno.env.get("SEPAY_QR_BANK_CODE") || "",
  );
  return { acc, bank };
}

function buildSepayQrUrl(amount: number, transferContent: string) {
  const { acc, bank } = paymentQrConfig();
  if (!acc || !bank) return "";
  const safeAmount = Math.max(0, parseInt(String(amount || 0), 10) || 0);
  const description = encodeURIComponent(String(transferContent || ""));
  return `https://qr.sepay.vn/img?acc=${encodeURIComponent(acc)}&bank=${encodeURIComponent(
    bank,
  )}&amount=${safeAmount}&des=${description}`;
}

function authHeader(req: Request) {
  const raw = req.headers.get("authorization") || "";
  return raw.toLowerCase().startsWith("bearer ") ? raw : "";
}

function withQr(order: any) {
  const amount = Math.max(0, parseInt(String(order?.amount_vnd || 0), 10) || 0);
  const transferContent = String(order?.transfer_content || "");
  const qrUrl = buildSepayQrUrl(amount, transferContent);
  return {
    ...order,
    qr_url: qrUrl,
    qr_configured: !!qrUrl,
  };
}

function publicErrorMessage(message: string) {
  if (/login_required/i.test(message)) return "LOGIN_REQUIRED";
  if (/student_required/i.test(message)) return "STUDENT_REQUIRED";
  if (/portal_not_active/i.test(message)) return "PORTAL_NOT_ACTIVE";
  if (/product_not_ready/i.test(message)) return "PRODUCT_NOT_READY";
  if (/product_not_found/i.test(message)) return "PRODUCT_NOT_FOUND";
  if (/already_entitled/i.test(message)) return "ALREADY_ENTITLED";
  return "CHECKOUT_FAILED";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!supabaseUrl || !anonKey) {
    return json({ ok: false, error: "Missing Supabase env" }, 500);
  }

  const bearer = authHeader(req);
  if (!bearer) return json({ ok: false, error: "LOGIN_REQUIRED" }, 401);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON payload" }, 400);
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: bearer } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser(
    bearer.replace(/^bearer\s+/i, ""),
  );
  if (userErr || !userData?.user) {
    return json({ ok: false, error: "LOGIN_REQUIRED" }, 401);
  }

  const action = String(body?.action || "create").trim().toLowerCase();

  if (action === "products") {
    const { data, error } = await supabase.rpc("list_portal_premium_products");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, products: Array.isArray(data) ? data : [] });
  }

  if (action === "orders") {
    const { data, error } = await supabase.rpc("get_my_portal_premium_orders");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, orders: (Array.isArray(data) ? data : []).map(withQr) });
  }

  if (action === "status") {
    const orderId = String(body?.order_id || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
      return json({ ok: false, error: "ORDER_ID_REQUIRED" }, 400);
    }
    await supabase.rpc("recheck_portal_premium_order", { p_order_id: orderId }).catch(() => null);
    const { data, error } = await supabase.rpc("get_my_portal_premium_orders");
    if (error) return json({ ok: false, error: error.message }, 500);
    const order = (Array.isArray(data) ? data : []).find((x: any) => String(x?.id || "") === orderId);
    if (!order) return json({ ok: false, error: "ORDER_NOT_FOUND" }, 404);
    return json({ ok: true, order: withQr(order) });
  }

  const productKey = String(body?.product_key || "").trim().toLowerCase();
  if (!productKey) return json({ ok: false, error: "PRODUCT_KEY_REQUIRED" }, 400);

  const { data, error } = await supabase.rpc("create_portal_premium_order", {
    p_product_key: productKey,
  });
  if (error) {
    const publicCode = publicErrorMessage(error.message || "");
    const status = publicCode === "PRODUCT_NOT_READY" ? 409 : 400;
    return json({ ok: false, error: publicCode, detail: error.message }, status);
  }

  const order = Array.isArray(data) ? data[0] : data;
  if (!order) return json({ ok: false, error: "ORDER_NOT_CREATED" }, 500);
  return json({ ok: true, order: withQr(order) });
});
