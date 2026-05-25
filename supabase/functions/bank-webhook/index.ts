// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type AnyObj = Record<string, unknown>;

function pickString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

function pickAmount(...vals: unknown[]): number {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.round(v));
    if (typeof v === "string") {
      const n = parseInt(v.replace(/[^\d-]/g, ""), 10);
      if (Number.isFinite(n)) return Math.max(0, n);
    }
  }
  return 0;
}

function flattenBody(body: AnyObj) {
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as AnyObj;
  return { body, data };
}

function parseIsoOrNow(raw: string): string {
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function isIncomingTransfer(body: AnyObj, data: AnyObj): boolean {
  const direction = pickString(
    body.transferType,
    body.direction,
    body.type,
    data.transferType,
    data.direction,
    data.type
  ).toLowerCase();
  if (!direction) return true;
  if (direction.includes("in")) return true;
  if (direction.includes("out")) return false;
  if (direction.includes("credit")) return true;
  if (direction.includes("debit")) return false;
  return true;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const WEBHOOK_SECRET = Deno.env.get("BANK_WEBHOOK_SECRET") || "";
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response("Missing Supabase env", { status: 500 });
  }

  if (WEBHOOK_SECRET) {
    const auth = req.headers.get("authorization") || "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const headerToken = pickString(
      req.headers.get("x-sepay-token"),
      req.headers.get("x-webhook-token")
    );
    const qsToken = pickString(new URL(req.url).searchParams.get("token"));
    const token = bearer || headerToken || qsToken;
    if (!token || token !== WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let payload: AnyObj = {};
  try {
    payload = (await req.json()) as AnyObj;
  } catch {
    return new Response("Invalid JSON payload", { status: 400 });
  }

  const { body, data } = flattenBody(payload);

  const provider = (
    pickString(
      req.headers.get("x-provider"),
      body.gateway,
      body.provider,
      body.source,
      data.gateway,
      data.provider,
      "sepay"
    ) || "sepay"
  ).toLowerCase();

  if (!isIncomingTransfer(body, data)) {
    return Response.json({ ok: true, ignored: true, reason: "OUTGOING_TRANSFER" });
  }

  const providerTxnId = pickString(
    body.transaction_id,
    body.transactionId,
    body.txn_id,
    body.txnId,
    body.reference,
    body.ref,
    body.id,
    data.transaction_id,
    data.transactionId,
    data.txn_id,
    data.reference,
    data.ref,
    data.id
  ) || crypto.randomUUID();

  const amountVnd = pickAmount(
    body.transferAmount,
    body.amount_in,
    body.amountIn,
    body.amount,
    data.transferAmount,
    data.amount_in,
    data.amountIn,
    data.amount
  );

  const transferContent = pickString(
    body.transactionContent,
    body.transaction_content,
    body.transfer_content,
    body.transferContent,
    body.description,
    body.content,
    body.addInfo,
    data.transactionContent,
    data.transaction_content,
    data.transfer_content,
    data.transferContent,
    data.description,
    data.content,
    data.addInfo
  );

  const payerName = pickString(
    body.counterAccountName,
    body.payer_name,
    body.payerName,
    body.accountName,
    data.counterAccountName,
    data.payer_name,
    data.payerName,
    data.accountName
  );

  const payerAccount = pickString(
    body.counterAccountNumber,
    body.payer_account,
    body.payerAccount,
    body.accountNumber,
    data.counterAccountNumber,
    data.payer_account,
    data.payerAccount,
    data.accountNumber
  );

  const occurredAtRaw = pickString(
    body.transactionDate,
    body.transactionTime,
    body.occurred_at,
    body.occurredAt,
    body.transaction_time,
    body.transactionTime,
    body.transaction_date,
    body.transactionDate,
    data.transactionDate,
    data.transactionTime,
    data.occurred_at,
    data.occurredAt,
    data.transaction_time,
    data.transactionTime,
    data.transaction_date,
    data.transactionDate
  );
  const occurredAt = parseIsoOrNow(occurredAtRaw);

  const headersObj: AnyObj = {};
  req.headers.forEach((v, k) => {
    headersObj[k] = v;
  });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: eventErr } = await supabase.from("bank_webhook_events").insert({
    provider,
    headers: headersObj,
    payload,
  });
  if (eventErr) {
    return new Response(`Failed logging event: ${eventErr.message}`, { status: 500 });
  }

  const upsertPayload = {
    provider,
    provider_txn_id: providerTxnId,
    occurred_at: occurredAt,
    amount_vnd: amountVnd,
    transfer_content: transferContent,
    payer_name: payerName || null,
    payer_account: payerAccount || null,
    payload,
    status: "pending",
    extracted_sessions: null,
    error_note: null,
  };

  const { data: txn, error: upErr } = await supabase
    .from("bank_transactions")
    .upsert(upsertPayload, { onConflict: "provider,provider_txn_id" })
    .select("id")
    .single();

  if (upErr || !txn) {
    return new Response(`Failed upsert transaction: ${upErr?.message || "unknown"}`, { status: 500 });
  }

  const { data: applyResult, error: applyErr } = await supabase.rpc(
    "fn_auto_apply_bank_transaction",
    { p_txn_id: txn.id }
  );

  if (applyErr) {
    return Response.json(
      { ok: false, txn_id: txn.id, error: applyErr.message },
      { status: 500 }
    );
  }

  return Response.json({
    ok: true,
    txn_id: txn.id,
    provider,
    provider_txn_id: providerTxnId,
    apply_result: applyResult,
  });
});
