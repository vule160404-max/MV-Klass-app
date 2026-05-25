// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

function buildSepayQrUrl(amount: number, transferContent: string) {
  const acc =
    (Deno.env.get("SEPAY_QR_ACC") ||
      Deno.env.get("SEPAY_QR_ACCOUNT") ||
      Deno.env.get("SEPAY_QR_ACCOUNT_NO") ||
      "").trim();
  const bank =
    (Deno.env.get("SEPAY_QR_BANK") ||
      Deno.env.get("SEPAY_QR_BANK_CODE") ||
      "").trim();
  if (!acc || !bank) return "";
  const safeAmount = Math.max(0, parseInt(String(amount || 0), 10) || 0);
  return `https://qr.sepay.vn/img?acc=${encodeURIComponent(acc)}&bank=${encodeURIComponent(
    bank
  )}&amount=${safeAmount}&des=${encodeURIComponent(String(transferContent || ""))}`;
}

function classShortLabel(v: string) {
  return String(v || "").split(/[•·]/)[0].trim() || String(v || "");
}

function birthYearValue(v: unknown): string {
  const raw = String(v == null ? "" : v).trim();
  return /^\d{4}$/.test(raw) ? raw : "";
}

async function validatePaymentToken(supabase: any, token: string) {
  const { data, error } = await supabase.rpc("resolve_class_payment_token", { p_token: token });
  if (error) return { ok: false, reason: "TOKEN_LOOKUP_FAILED", error: error.message };
  return data || { ok: false, reason: "TOKEN_LOOKUP_FAILED" };
}

function normalizeLookupText(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function escapeIlikePattern(s: string): string {
  return String(s || "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Có chữ cái (Unicode, kể cả tiếng Việt) → không coi chuỗi là “thuần SĐT” (tránh \d khớp ký tự số Unicode / nhầm tên). */
function inputContainsLetters(s: string): boolean {
  const t = String(s || "").trim();
  if (!t) return false;
  try {
    return /\p{L}/u.test(t);
  } catch {
    return /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/.test(t);
  }
}

function studentMatchesPaymentLinkRow(row: any, tokenInfo: any): boolean {
  const scope = String(tokenInfo?.scope || "").toLowerCase();
  if (scope === "center") return true;
  const linkName = String(tokenInfo?.class_name || "").trim();
  if (!linkName || linkName === "Toàn trung tâm") return true;
  const ln = normalizeLookupText(linkName);
  const primary = normalizeLookupText(String(row?.class_name || ""));
  if (primary && ln && primary === ln) return true;
  const arr = Array.isArray(row?.class_names) ? row.class_names : [];
  for (const c of arr) {
    if (normalizeLookupText(String(c || "")) === ln) return true;
  }
  return false;
}

async function resolveParentPaymentRpc(
  supabase: any,
  token: string,
  phoneForRpc: string,
  studentId: string,
) {
  return await supabase.rpc("resolve_class_parent_payment", {
    p_token: token,
    p_parent_phone: phoneForRpc,
    p_student_id: studentId || null,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    // 204 No Content must not include a body (RFC 7230) — body + 204 gây 500 ở gateway.
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRole) {
    return json({ ok: false, error: "Missing Supabase env" }, 500);
  }

  const urlObj = new URL(req.url);
  const wantView = (urlObj.searchParams.get("view") || "") === "1";
  if (wantView) {
    return json({
      ok: false,
      reason: "USE_STATIC_PARENT_PORTAL_PAGE",
      message: "Use static parent-payment.html page in public storage and call this function as JSON API.",
    }, 400);
  }

  const token = urlObj.searchParams.get("token") || urlObj.searchParams.get("payToken") || "";
  const mode = (urlObj.searchParams.get("mode") || "class").toLowerCase();
  const parentPhone = String(urlObj.searchParams.get("phone") || "").trim();
  const studentId = String(urlObj.searchParams.get("studentId") || "").trim();
  const payClass = urlObj.searchParams.get("payClass") || "";
  if (!token) return json({ ok: false, reason: "TOKEN_REQUIRED" }, 400);

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (mode !== "class" && mode !== "center") {
    return json({ ok: false, reason: "MODE_NOT_SUPPORTED" }, 400);
  }
  if (!parentPhone) {
    const { data: classInfo, error: classErr } = await supabase.rpc("resolve_class_payment_token", { p_token: token });
    if (classErr) return json({ ok: false, error: classErr.message }, 500);
    if (!classInfo || !classInfo.ok) return json(classInfo || { ok: false, reason: "NOT_FOUND" }, 404);
    return json({
      ok: true,
      mode: classInfo.scope || "class",
      class_name: classInfo.class_name,
      expires_at: classInfo.expires_at,
      needs_phone_lookup: true,
    });
  }

  const digitsOnly = parentPhone.replace(/\D/g, "");
  const rawTrim = parentPhone.trim();
  const compactNoSpace = rawTrim.replace(/\s/g, "");
  const compactLen = Math.max(compactNoSpace.length, 1);
  const digitRatio = digitsOnly.length / compactLen;
  const looksLikePhone =
    digitsOnly.length >= 9 &&
    (!inputContainsLetters(rawTrim) || digitRatio >= 0.65);
  let data: any = null;
  let error: any = null;

  if (!studentId && !looksLikePhone) {
    if (rawTrim.length < 2) {
      return json({ ok: false, reason: "QUERY_TOO_SHORT" }, 400);
    }
    const tokenInfo = await validatePaymentToken(supabase, token);
    if (!tokenInfo || !tokenInfo.ok) {
      return json(tokenInfo || { ok: false, reason: "TOKEN_INVALID" }, 404);
    }
    const pat = `%${escapeIlikePattern(rawTrim)}%`;
    const { data: nameRows, error: nameErr } = await supabase
      .from("students")
      .select("id,name,class_name,class_names,phone,birth_year,learning_note")
      .ilike("name", pat)
      .limit(80);
    if (nameErr) {
      return json({ ok: false, reason: "NAME_SEARCH_FAILED", error: nameErr.message }, 500);
    }
    const rows = (Array.isArray(nameRows) ? nameRows : []).filter((r: any) =>
      studentMatchesPaymentLinkRow(r, tokenInfo)
    );
    if (!rows.length) {
      return json({ ok: false, reason: "STUDENT_NOT_FOUND" }, 404);
    }
    if (rows.length === 1) {
      const st0 = rows[0];
      const pd = String(st0?.phone || "").replace(/\D/g, "");
      const r1 = await resolveParentPaymentRpc(
        supabase,
        token,
        pd,
        String(st0.id || ""),
      );
      data = r1.data;
      error = r1.error;
    } else {
      const candidates = rows.map((r: any) => ({
        id: r && r.id,
        name: r && r.name,
        class_name: r && r.class_name,
        class_names: r && r.class_names,
        birth_year: birthYearValue(r && r.birth_year),
        learning_note: String(r && r.learning_note ? r.learning_note : "").trim(),
        phone: r && r.phone,
      }));
      return json(
        {
          ok: false,
          reason: "MULTI_STUDENT",
          scope: tokenInfo.scope || "class",
          candidates,
        },
        404,
      );
    }
  } else {
    const phoneForRpc = digitsOnly.length >= 9 ? digitsOnly : rawTrim;
    const r2 = await resolveParentPaymentRpc(supabase, token, phoneForRpc, studentId);
    data = r2.data;
    error = r2.error;
  }
  if (error) {
    const tokenInfo = await validatePaymentToken(supabase, token);
    if (!tokenInfo || !tokenInfo.ok) {
      return json(tokenInfo || { ok: false, reason: "TOKEN_INVALID" }, 404);
    }
    if (parentPhone && !studentId) {
      try {
        const { data: stuRows } = await supabase
          .from("students")
          .select("id,name,class_name,birth_year,learning_note,phone")
          .eq("phone", parentPhone);
        if (Array.isArray(stuRows) && stuRows.length > 1) {
          const candidates = stuRows.map((r: any) => ({
            id: r && r.id,
            name: r && r.name,
            class_name: r && r.class_name,
            birth_year: birthYearValue(r && r.birth_year),
            learning_note: String(r && r.learning_note ? r.learning_note : "").trim(),
            phone: r && r.phone,
          }));
          return json(
            {
              ok: false,
              reason: "MULTI_STUDENT",
              candidates,
            },
            404,
          );
        }
      } catch (_e) {
        // ignore and fall through to generic error
      }
    }
    return json({ ok: false, reason: "RPC_ERROR", error: error.message }, 500);
  }
  if (!data || !data.ok) {
    if (data && data.reason === "MULTI_STUDENT" && Array.isArray((data as any).candidates)) {
      const baseCandidates = (data as any).candidates as any[];
      const ids = baseCandidates
        .map((c: any) => String(c && c.id ? c.id : "").trim())
        .filter(Boolean);
      let enhanced = baseCandidates;
      if (ids.length) {
        const { data: studentRows } = await supabase
          .from("students")
          .select("id,birth_year,class_name,class_names,learning_note")
          .in("id", ids);
        const extraMap: Record<
          string,
          { birth_year: string; class_name: string; class_names: unknown; learning_note: string }
        > = {};
        (Array.isArray(studentRows) ? studentRows : []).forEach((r: any) => {
          const sid = String(r && r.id ? r.id : "").trim();
          if (!sid) return;
          extraMap[sid] = {
            birth_year: birthYearValue(r && r.birth_year),
            class_name: String(r && r.class_name ? r.class_name : "").trim(),
            class_names: r && r.class_names,
            learning_note: String(r && r.learning_note ? r.learning_note : "").trim(),
          };
        });
        enhanced = baseCandidates.map((c: any) => {
          const sid = String(c && c.id ? c.id : "").trim();
          const extra = extraMap[sid] || {
            birth_year: "",
            class_name: "",
            class_names: undefined,
            learning_note: "",
          };
          const cls = String(c && c.class_name ? c.class_name : "").trim() || extra.class_name;
          return {
            ...c,
            class_name: cls,
            class_names: c.class_names != null ? c.class_names : extra.class_names,
            birth_year: extra.birth_year,
            learning_note: extra.learning_note,
          };
        });
      }
      return json(
        {
          ok: false,
          reason: "MULTI_STUDENT",
          candidates: enhanced,
        },
        404,
      );
    } else if (data && String((data as any).reason || "")?.startsWith("TOKEN_")) {
      return json(data, 404);
    } else if (parentPhone && !studentId) {
      try {
        const { data: stuRows } = await supabase
          .from("students")
          .select("id,name,class_name,birth_year,learning_note,phone")
          .eq("phone", parentPhone);
        if (Array.isArray(stuRows) && stuRows.length > 1) {
          const candidates = stuRows.map((r: any) => ({
            id: r && r.id,
            name: r && r.name,
            class_name: r && r.class_name,
            birth_year: birthYearValue(r && r.birth_year),
            learning_note: String(r && r.learning_note ? r.learning_note : "").trim(),
            phone: r && r.phone,
          }));
          return json(
            {
              ok: false,
              reason: "MULTI_STUDENT",
              candidates,
            },
            404,
          );
        }
      } catch (_e) {
        // ignore and fall through to default error handling
      }
    }

    if (
      data &&
      (data as any).reason === "PHONE_REQUIRED" &&
      !studentId &&
      inputContainsLetters(rawTrim) &&
      rawTrim.length >= 2
    ) {
      const tokenInfo3 = await validatePaymentToken(supabase, token);
      if (tokenInfo3 && tokenInfo3.ok) {
        const pat3 = `%${escapeIlikePattern(rawTrim)}%`;
        const { data: nameRows3, error: nameErr3 } = await supabase
          .from("students")
          .select("id,name,class_name,class_names,phone,birth_year,learning_note")
          .ilike("name", pat3)
          .limit(80);
        if (!nameErr3) {
          const rows3 = (Array.isArray(nameRows3) ? nameRows3 : []).filter((r: any) =>
            studentMatchesPaymentLinkRow(r, tokenInfo3)
          );
          if (rows3.length === 1) {
            const st0 = rows3[0];
            const pd = String(st0?.phone || "").replace(/\D/g, "");
            const r3 = await resolveParentPaymentRpc(
              supabase,
              token,
              pd,
              String(st0.id || ""),
            );
            if (!r3.error && r3.data && (r3.data as any).ok) {
              data = r3.data;
              error = null;
            } else if (r3.data && !(r3.data as any).ok) {
              return json(r3.data, 404);
            } else if (r3.error) {
              return json({ ok: false, reason: "RPC_ERROR", error: String(r3.error.message || "") }, 500);
            }
          } else if (rows3.length > 1) {
            const candidates = rows3.map((r: any) => ({
              id: r && r.id,
              name: r && r.name,
              class_name: r && r.class_name,
              class_names: r && r.class_names,
              birth_year: birthYearValue(r && r.birth_year),
              learning_note: String(r && r.learning_note ? r.learning_note : "").trim(),
              phone: r && r.phone,
            }));
            return json(
              {
                ok: false,
                reason: "MULTI_STUDENT",
                scope: tokenInfo3.scope || "class",
                candidates,
              },
              404,
            );
          } else {
            return json({ ok: false, reason: "STUDENT_NOT_FOUND" }, 404);
          }
        }
      }
    }

    if (!data || !data.ok) {
      return json(data || { ok: false, reason: "NOT_FOUND" }, 404);
    }
  }

  const pending = data.pending || {};
  const amountVnd = Math.max(0, parseInt(String(pending.amount_vnd || 0), 10) || 0);
  let transferContent = String(pending.transfer_content || "");
  let classOptions: Array<any> = [];
  let unclassifiedPresentSessions = 0;
  let linkCreatedAtIso = "";
  let selectedClassName = "";
  let selectedAmount = amountVnd;
  let selectedPresent = Math.max(0, parseInt(String(pending.present_sessions || 0), 10) || 0);
  let selectedCharged = Math.max(0, parseInt(String(pending.charged_sessions || 0), 10) || 0);
  let selectedPending = Math.max(0, parseInt(String(pending.pending_sessions || 0), 10) || 0);
  let selectedFee = Math.max(0, parseInt(String(pending.fee_per_session || 0), 10) || 0);
  try {
    if (data && data.link_id) {
      const { data: linkRows } = await supabase
        .from("class_payment_links")
        .select("created_at")
        .eq("id", data.link_id)
        .limit(1);
      const createdAt = Array.isArray(linkRows) && linkRows[0] && linkRows[0].created_at
        ? String(linkRows[0].created_at)
        : "";
      if (createdAt) linkCreatedAtIso = createdAt;
    }
    const sid = data && data.student && data.student.id ? String(data.student.id) : "";
    const rpcClassRaw = (data as any).class_options;
    const useRpcClassOptions =
      rpcClassRaw != null && Array.isArray(rpcClassRaw) && rpcClassRaw.length > 0;

    if (useRpcClassOptions) {
      classOptions = rpcClassRaw.map((row: any) => {
        const cn = String(row?.class_name ?? "").trim();
        return {
          class_name: cn,
          class_short_name: classShortLabel(cn),
          present_sessions: Math.max(0, parseInt(String(row?.present_sessions ?? 0), 10) || 0),
          charged_sessions: Math.max(0, parseInt(String(row?.charged_sessions ?? 0), 10) || 0),
          pending_sessions: Math.max(0, parseInt(String(row?.pending_sessions ?? 0), 10) || 0),
          fee_per_session: Math.max(0, parseInt(String(row?.fee_per_session ?? 0), 10) || 0),
          amount_vnd: Math.max(0, parseInt(String(row?.amount_vnd ?? 0), 10) || 0),
          prepaid_balance_vnd: Math.max(0, parseInt(String(row?.prepaid_balance_vnd ?? 0), 10) || 0),
        };
      });
      classOptions.sort((a, b) =>
        b.amount_vnd - a.amount_vnd || String(a.class_name).localeCompare(String(b.class_name))
      );
      const u = (data as any).unclassified_present_sessions;
      if (typeof u === "number" && Number.isFinite(u)) {
        unclassifiedPresentSessions = Math.max(0, Math.floor(u));
      } else if (u != null) {
        const n = parseInt(String(u), 10);
        if (Number.isFinite(n)) unclassifiedPresentSessions = Math.max(0, n);
      }
    } else if (sid) {
      const cutoffYmd = linkCreatedAtIso
        ? new Date(linkCreatedAtIso).toISOString().slice(0, 10)
        : "";
      let attQuery = supabase
        .from("attendance")
        .select("class_name,status,date")
        .eq("student_id", sid)
        .eq("status", "present")
        .limit(20000);
      if (cutoffYmd) attQuery = attQuery.lte("date", cutoffYmd);
      const { data: attRows } = await attQuery;
      const byClass: Record<string, number> = {};
      (Array.isArray(attRows) ? attRows : []).forEach((r: any) => {
        const cn = String(r && r.class_name ? r.class_name : "").trim();
        if (!cn) {
          unclassifiedPresentSessions += 1;
          return;
        }
        byClass[cn] = (byClass[cn] || 0) + 1;
      });
      const classNames = Object.keys(byClass);
      if (classNames.length) {
        const { data: feeRows } = await supabase
          .from("class_fees")
          .select("class_name,fee_amount")
          .in("class_name", classNames);
        const feeMap: Record<string, number> = {};
        (Array.isArray(feeRows) ? feeRows : []).forEach((r: any) => {
          const cn = String(r && r.class_name ? r.class_name : "").trim();
          if (!cn) return;
          feeMap[cn] = Math.max(0, parseInt(String(r.fee_amount || 0), 10) || 0);
        });
        const totalPresent = classNames.reduce((sum, c) => sum + (byClass[c] || 0), 0);
        const totalPending = Math.max(0, parseInt(String(pending.pending_sessions || 0), 10) || 0);
        const totalCharged = Math.max(0, totalPresent - totalPending);
        const allocRaw = classNames.map((c) => {
          const present = byClass[c] || 0;
          const chargedRaw = totalPresent > 0 ? (totalCharged * present) / totalPresent : 0;
          return { class_name: c, present_sessions: present, charged_floor: Math.floor(chargedRaw), frac: chargedRaw - Math.floor(chargedRaw) };
        });
        let used = allocRaw.reduce((s, x) => s + x.charged_floor, 0);
        let remain = Math.max(0, totalCharged - used);
        allocRaw.sort((a, b) => b.frac - a.frac);
        for (const x of allocRaw) {
          if (remain < 1) break;
          x.charged_floor += 1;
          remain -= 1;
        }
        classOptions = allocRaw.map((x) => {
          const fee = feeMap[x.class_name] != null ? feeMap[x.class_name] : selectedFee;
          const pendingSessions = Math.max(0, x.present_sessions - x.charged_floor);
          const amount = Math.max(0, pendingSessions * fee);
          return {
            class_name: x.class_name,
            class_short_name: classShortLabel(x.class_name),
            present_sessions: x.present_sessions,
            charged_sessions: x.charged_floor,
            pending_sessions: pendingSessions,
            fee_per_session: fee,
            amount_vnd: amount,
          };
        }).sort((a, b) => b.amount_vnd - a.amount_vnd || a.class_name.localeCompare(b.class_name));
      }
    }
  } catch (_e) {}
  if (classOptions.length) {
    const picked = classOptions.find((x) => String(x.class_name) === String(payClass)) || classOptions[0];
    selectedClassName = String(picked.class_name || "");
    selectedPresent = Math.max(0, parseInt(String(picked.present_sessions || 0), 10) || 0);
    selectedCharged = Math.max(0, parseInt(String(picked.charged_sessions || 0), 10) || 0);
    selectedPending = Math.max(0, parseInt(String(picked.pending_sessions || 0), 10) || 0);
    selectedFee = Math.max(0, parseInt(String(picked.fee_per_session || 0), 10) || 0);
    selectedAmount = Math.max(0, parseInt(String(picked.amount_vnd || 0), 10) || 0);
    const phoneDigits = String(parentPhone || "").replace(/\D/g, "");
    transferContent = `${String(data.student?.name || "HS")} - ${phoneDigits}${selectedClassName ? " - " + classShortLabel(selectedClassName) : ""}`;
  }
  try {
    const sid = data && data.student && data.student.id ? String(data.student.id) : "";
    if (sid) {
      const { data: studentRows } = await supabase
        .from("students")
        .select("id,birth_year,learning_note")
        .eq("id", sid)
        .limit(1);
      const s0 = Array.isArray(studentRows) && studentRows.length ? studentRows[0] : null;
      if (s0) {
        if (!data.student || typeof data.student !== "object") data.student = {};
        data.student.birth_year = birthYearValue((s0 as any).birth_year);
        data.student.learning_note = String((s0 as any).learning_note || "").trim();
      }
    }
  } catch (_e) {
    // ignore enrichment error
  }
  const qrUrl = buildSepayQrUrl(selectedAmount, transferContent);
  const paymentStatus = String(data.payment_status || "").toLowerCase();

  // Cờ "paid" không tồn tại trong RPC — thành công thật sự là no_debt hoặc ref portal vừa chuyển sang used (sau webhook).
  let refUsedRecently = false;
  try {
    const linkId = data && data.link_id;
    const stuId = data && data.student && (data.student as any).id;
    if (linkId != null && stuId) {
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: usedRefs } = await supabase
        .from("parent_payment_refs")
        .select("id")
        .eq("class_link_id", linkId)
        .eq("student_id", stuId)
        .eq("status", "used")
        .gte("used_at", since)
        .limit(1);
      refUsedRecently = Array.isArray(usedRefs) && usedRefs.length > 0;
    }
  } catch (_e) {
    // ignore
  }

  const paymentSuccess =
    paymentStatus === "no_debt" ||
    paymentStatus === "paid" ||
    (refUsedRecently && selectedAmount <= 0);

  return json({
    ok: true,
    link_id: data.link_id,
    ref_code: data.ref_code,
    expires_at: data.expires_at,
    student: data.student,
    pending: {
      ...data.pending,
      class_name: selectedClassName || (data.pending && data.pending.class_name) || "",
      present_sessions: selectedPresent,
      charged_sessions: selectedCharged,
      pending_sessions: selectedPending,
      fee_per_session: selectedFee,
      amount_vnd: selectedAmount,
      transfer_content: transferContent,
    },
    class_options: classOptions,
    selected_class: selectedClassName || null,
    unclassified_present_sessions: unclassifiedPresentSessions,
    payment_status: paymentStatus,
    qr_url: qrUrl,
    payment_success: paymentSuccess,
    success_text: "Đóng học phí thành công",
  });
});
