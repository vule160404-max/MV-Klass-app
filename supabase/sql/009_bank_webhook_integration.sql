-- =============================================================================
-- 009 — Tích hợp webhook biến động số dư (API bên thứ 3)
-- Mục tiêu:
--   1) Nhận giao dịch từ webhook vào bảng trung gian bank_transactions
--   2) Tự đối soát theo nội dung chuyển khoản (tên học sinh + số buổi)
--   3) Tự ghi nhận vào student_tuition + payment_history khi match chắc chắn
-- =============================================================================

create table if not exists public.bank_webhook_events (
  id bigint generated always as identity primary key,
  provider text not null default 'sepay',
  received_at timestamptz not null default now(),
  headers jsonb,
  payload jsonb not null,
  processed boolean not null default false,
  process_note text
);

create table if not exists public.bank_transactions (
  id bigint generated always as identity primary key,
  provider text not null default 'sepay',
  provider_txn_id text not null,
  occurred_at timestamptz not null default now(),
  amount_vnd integer not null check (amount_vnd >= 0),
  transfer_content text not null default '',
  payer_name text,
  payer_account text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'needs_review', 'applied', 'ignored', 'error')),
  matched_student_id uuid references public.students(id) on delete set null,
  extracted_sessions integer,
  applied_sessions integer,
  applied_amount_vnd integer,
  applied_payment_history_id bigint references public.payment_history(id) on delete set null,
  error_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_txn_id)
);

create extension if not exists pgcrypto;

create table if not exists public.class_payment_links (
  id bigint generated always as identity primary key,
  class_name text not null,
  token_hash text not null unique,
  status text not null default 'active' check (status in ('active','revoked','expired')),
  expires_at timestamptz not null,
  last_opened_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.parent_payment_refs (
  id bigint generated always as identity primary key,
  class_link_id bigint references public.class_payment_links(id) on delete set null,
  student_id uuid not null references public.students(id) on delete cascade,
  parent_phone text,
  ref_code text not null unique,
  status text not null default 'active' check (status in ('active','used','expired','cancelled')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bank_tx_status_created
  on public.bank_transactions(status, created_at desc);

create index if not exists idx_bank_tx_matched_student
  on public.bank_transactions(matched_student_id, created_at desc);

create index if not exists idx_class_payment_links_status
  on public.class_payment_links(class_name, status, expires_at desc);

create index if not exists idx_parent_payment_refs_student_status
  on public.parent_payment_refs(student_id, status, expires_at desc);

create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_bank_transactions_updated_at on public.bank_transactions;
create trigger trg_bank_transactions_updated_at
before update on public.bank_transactions
for each row execute procedure public.tg_set_updated_at();

drop trigger if exists trg_class_payment_links_updated_at on public.class_payment_links;
create trigger trg_class_payment_links_updated_at
before update on public.class_payment_links
for each row execute procedure public.tg_set_updated_at();

drop trigger if exists trg_parent_payment_refs_updated_at on public.parent_payment_refs;
create trigger trg_parent_payment_refs_updated_at
before update on public.parent_payment_refs
for each row execute procedure public.tg_set_updated_at();

create or replace function public.extract_payment_ref_from_transfer_content(p_content text)
returns text
language plpgsql
as $$
declare
  m text[];
begin
  if p_content is null or btrim(p_content) = '' then
    return null;
  end if;
  m := regexp_match(upper(p_content), 'REF[\s:\-_]*([A-Z0-9]{6,16})');
  if m is null or array_length(m, 1) is null then
    return null;
  end if;
  return nullif(m[1], '');
exception when others then
  return null;
end $$;

create or replace function public.make_random_hex(p_len integer default 48)
returns text
language plpgsql
as $$
declare
  out_text text := '';
begin
  while length(out_text) < greatest(8, coalesce(p_len, 48)) loop
    out_text := out_text || md5(random()::text || clock_timestamp()::text || out_text);
  end loop;
  return substr(out_text, 1, greatest(8, coalesce(p_len, 48)));
end $$;

create or replace function public.extract_sessions_from_transfer_content(p_content text)
returns integer
language plpgsql
as $$
declare
  m text[];
begin
  if p_content is null or btrim(p_content) = '' then
    return null;
  end if;
  m := regexp_match(lower(p_content), '(\d+)\s*bu[oổ]i');
  if m is null or array_length(m, 1) is null then
    return null;
  end if;
  return nullif(m[1], '')::integer;
exception when others then
  return null;
end $$;

create extension if not exists unaccent;

create or replace function public.normalize_lookup_text(p_text text)
returns text
language sql
immutable
as $$
  select trim(
    regexp_replace(
      regexp_replace(
        lower(unaccent(coalesce(p_text, ''))),
        '[^a-z0-9]+', ' ', 'g'
      ),
      '\s+', ' ', 'g'
    )
  );
$$;

create or replace function public.match_student_from_transfer_content(p_content text)
returns table(student_id uuid, candidate_count integer, top_score integer)
language sql
stable
as $$
  with vars as (
    select
      public.normalize_lookup_text(p_content) as content_norm,
      replace(public.normalize_lookup_text(p_content), ' ', '') as content_compact,
      regexp_replace(coalesce(p_content, ''), '\D', '', 'g') as content_digits
  ),
  scored as (
    select
      s.id,
      (
        case
          when regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') <> ''
            and position(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') in v.content_digits) > 0
          then 100 else 0
        end
        +
        case
          when public.normalize_lookup_text(s.name) <> ''
            and position(public.normalize_lookup_text(s.name) in v.content_norm) > 0
          then 65 else 0
        end
        +
        case
          when replace(public.normalize_lookup_text(s.name), ' ', '') <> ''
            and position(replace(public.normalize_lookup_text(s.name), ' ', '') in v.content_compact) > 0
          then 55 else 0
        end
        +
        case
          when split_part(public.normalize_lookup_text(s.name), ' ', 1) <> ''
            and position(split_part(public.normalize_lookup_text(s.name), ' ', 1) in v.content_norm) > 0
          then 8 else 0
        end
        +
        case
          when split_part(public.normalize_lookup_text(s.name), ' ', 2) <> ''
            and position(split_part(public.normalize_lookup_text(s.name), ' ', 2) in v.content_norm) > 0
          then 6 else 0
        end
      )::integer as score
    from public.students s
    cross join vars v
    where coalesce(p_content, '') <> ''
  ),
  top_score_cte as (
    select coalesce(max(score), 0)::integer as top_score
    from scored
  ),
  best as (
    select *
    from scored
    where score = (select top_score from top_score_cte)
      and score >= 60
  ),
  near_best as (
    -- Nếu nhiều ứng viên có điểm rất sát top (<= 8 điểm chênh lệch),
    -- coi là trường hợp dễ nhầm và bắt buộc duyệt tay.
    select s.*
    from scored s
    cross join top_score_cte t
    where t.top_score >= 60
      and s.score >= t.top_score - 8
  )
  select
    case
      when (select count(*) from near_best) = 1 then (select b.id from best b order by b.id limit 1)
      else null
    end,
    (select count(*)::integer from near_best),
    (select top_score from top_score_cte);
$$;

create or replace function public.fn_auto_apply_bank_transaction(p_txn_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions%rowtype;
  v_sessions integer;
  v_candidate_count integer := 0;
  v_student_id uuid;
  v_ref_code text := null;
  v_parent_ref_rec public.parent_payment_refs%rowtype;
  v_content_lower text := '';
  v_content_digits text := '';
  v_matched_candidate_id uuid;
  v_present_count integer := 0;
  v_cur_charged integer := 0;
  v_new_charged integer := 0;
  v_apply_sessions integer := 0;
  v_fee integer := 0;
  v_applied_amount integer := 0;
  v_payment_id bigint;
begin
  if auth.role() = 'authenticated' and not exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;

  select * into v_txn
  from public.bank_transactions
  where id = p_txn_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'TXN_NOT_FOUND');
  end if;

  if v_txn.status = 'applied' then
    return jsonb_build_object('ok', true, 'reason', 'ALREADY_APPLIED', 'txn_id', v_txn.id);
  end if;

  if v_txn.amount_vnd <= 0 then
    update public.bank_transactions
    set status = 'ignored', error_note = 'Số tiền <= 0'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'INVALID_AMOUNT');
  end if;

  v_sessions := coalesce(v_txn.extracted_sessions, public.extract_sessions_from_transfer_content(v_txn.transfer_content));

  v_ref_code := public.extract_payment_ref_from_transfer_content(v_txn.transfer_content);
  if v_ref_code is not null then
    select *
    into v_parent_ref_rec
    from public.parent_payment_refs pr
    where pr.ref_code = v_ref_code
      and pr.status = 'active'
      and pr.expires_at > now()
    order by pr.id desc
    limit 1;
    if found then
      v_student_id := v_parent_ref_rec.student_id;
      v_candidate_count := 1;
    end if;
  end if;

  v_content_lower := lower(coalesce(v_txn.transfer_content, ''));
  v_content_digits := regexp_replace(coalesce(v_txn.transfer_content, ''), '\D', '', 'g');

  if v_candidate_count = 0 then
    select m.student_id, m.candidate_count
    into v_matched_candidate_id, v_candidate_count
    from public.match_student_from_transfer_content(v_txn.transfer_content) m;
    if v_candidate_count = 1 then
      v_student_id := v_matched_candidate_id;
    end if;
  end if;

  if v_candidate_count <> 1 then
    update public.bank_transactions
    set status = 'needs_review',
        extracted_sessions = v_sessions,
        error_note = case
          when v_candidate_count = 0 then 'Không match được học sinh theo nội dung chuyển khoản'
          else 'Match nhiều học sinh, cần duyệt tay'
        end
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CANDIDATE_NOT_UNIQUE', 'count', v_candidate_count);
  end if;

  if v_student_id is null and v_candidate_count = 1 then
    v_student_id := v_matched_candidate_id;
  end if;

  select coalesce(cf.fee_amount, 0)
  into v_fee
  from public.class_fees cf
  join public.students s on s.class_name = cf.class_name
  where s.id = v_student_id
  limit 1;

  if (v_sessions is null or v_sessions < 1) and v_fee > 0 then
    v_sessions := floor(v_txn.amount_vnd::numeric / v_fee::numeric)::integer;
  end if;

  if v_sessions is null or v_sessions < 1 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        extracted_sessions = null,
        error_note = 'Không tách được số buổi từ nội dung CK hoặc số tiền không đủ suy ra số buổi'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'SESSIONS_NOT_FOUND');
  end if;

  select count(*)
  into v_present_count
  from public.attendance a
  where a.student_id = v_student_id
    and a.status = 'present';

  select coalesce((
    select st.charged_sessions
    from public.student_tuition st
    where st.student_id = v_student_id
    limit 1
  ), 0)
  into v_cur_charged;

  v_apply_sessions := least(greatest(v_present_count - v_cur_charged, 0), v_sessions);
  if v_apply_sessions < 1 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        extracted_sessions = v_sessions,
        error_note = 'Học sinh không còn buổi nợ để áp dụng tự động'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'NO_PENDING_SESSIONS');
  end if;

  v_new_charged := v_cur_charged + v_apply_sessions;

  insert into public.student_tuition(student_id, charged_sessions)
  values (v_student_id, v_new_charged)
  on conflict (student_id)
  do update set charged_sessions = excluded.charged_sessions;

  v_applied_amount := case when v_fee > 0 then v_apply_sessions * v_fee else v_txn.amount_vnd end;

  insert into public.payment_history(student_id, sessions_paid, amount_vnd, paid_at)
  values (v_student_id, v_apply_sessions, v_applied_amount, coalesce(v_txn.occurred_at, now()))
  returning id into v_payment_id;

  update public.bank_transactions
  set status = 'applied',
      matched_student_id = v_student_id,
      extracted_sessions = v_sessions,
      applied_sessions = v_apply_sessions,
      applied_amount_vnd = v_applied_amount,
      applied_payment_history_id = v_payment_id,
      error_note = null
  where id = v_txn.id;

  if v_parent_ref_rec.id is null then
    select *
    into v_parent_ref_rec
    from public.parent_payment_refs pr
    where pr.student_id = v_student_id
      and regexp_replace(coalesce(pr.parent_phone, ''), '\D', '', 'g') <> ''
      and position(regexp_replace(coalesce(pr.parent_phone, ''), '\D', '', 'g') in v_content_digits) > 0
      and pr.status = 'active'
      and pr.expires_at > now()
    order by pr.id desc
    limit 1;
  end if;

  if v_parent_ref_rec.id is not null then
    update public.parent_payment_refs
    set status = 'used',
        used_at = now()
    where id = v_parent_ref_rec.id
      and status = 'active';
  end if;

  return jsonb_build_object(
    'ok', true,
    'reason', 'APPLIED',
    'txn_id', v_txn.id,
    'student_id', v_student_id,
    'sessions', v_apply_sessions,
    'amount_vnd', v_applied_amount,
    'payment_history_id', v_payment_id
  );
exception when others then
  update public.bank_transactions
  set status = 'error',
      error_note = sqlerrm
  where id = p_txn_id;
  return jsonb_build_object('ok', false, 'reason', 'EXCEPTION', 'message', sqlerrm);
end $$;

grant execute on function public.fn_auto_apply_bank_transaction(bigint) to service_role;
grant execute on function public.fn_auto_apply_bank_transaction(bigint) to authenticated;

create or replace function public.create_class_payment_link(
  p_class_name text,
  p_expires_hours integer default 72
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := false;
  v_class text := btrim(coalesce(p_class_name, ''));
  v_token text;
  v_hash text;
  v_exp timestamptz;
  v_link public.class_payment_links%rowtype;
begin
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) into v_is_admin;
  if not v_is_admin then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;
  if v_class = '' then
    return jsonb_build_object('ok', false, 'reason', 'CLASS_REQUIRED');
  end if;

  v_token := public.make_random_hex(48);
  v_hash := md5(v_token);
  v_exp := now() + make_interval(hours => greatest(1, least(coalesce(p_expires_hours,72), 24 * 30)));

  insert into public.class_payment_links(class_name, token_hash, status, expires_at, created_by)
  values (v_class, v_hash, 'active', v_exp, auth.uid())
  returning * into v_link;

  return jsonb_build_object(
    'ok', true,
    'id', v_link.id,
    'token', v_token,
    'class_name', v_link.class_name,
    'expires_at', v_link.expires_at
  );
end $$;

create or replace function public.resolve_class_payment_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
  v_link public.class_payment_links%rowtype;
  v_students integer := 0;
begin
  if p_token is null or btrim(p_token) = '' then
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_REQUIRED');
  end if;
  v_hash := md5(p_token);
  select * into v_link from public.class_payment_links cl where cl.token_hash = v_hash limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_INVALID');
  end if;
  if v_link.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_INACTIVE');
  end if;
  if v_link.expires_at <= now() then
    update public.class_payment_links set status = 'expired' where id = v_link.id and status = 'active';
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_EXPIRED');
  end if;

  select count(*) into v_students
  from public.students s
  where coalesce(s.class_name, 'No class') = v_link.class_name;

  update public.class_payment_links set last_opened_at = now() where id = v_link.id;

  return jsonb_build_object(
    'ok', true,
    'mode', 'class',
    'scope', case when v_link.class_name = '__CENTER__' then 'center' else 'class' end,
    'link_id', v_link.id,
    'class_name', case when v_link.class_name = '__CENTER__' then 'Toàn trung tâm' else v_link.class_name end,
    'expires_at', v_link.expires_at,
    'students_count', v_students
  );
end $$;

create or replace function public.resolve_class_parent_payment(
  p_token text,
  p_parent_phone text,
  p_student_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
  v_link public.class_payment_links%rowtype;
  v_phone_digits text := regexp_replace(coalesce(p_parent_phone, ''), '\D', '', 'g');
  v_scope text := 'class';
  v_match_count integer := 0;
  v_candidates jsonb := '[]'::jsonb;
  v_student public.students%rowtype;
  v_ref text;
  v_present integer := 0;
  v_charged integer := 0;
  v_pending integer := 0;
  v_fee integer := 0;
  v_amount integer := 0;
  v_transfer_content text;
  v_existing public.parent_payment_refs%rowtype;
begin
  if p_token is null or btrim(p_token) = '' then
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_REQUIRED');
  end if;
  if v_phone_digits = '' then
    return jsonb_build_object('ok', false, 'reason', 'PHONE_REQUIRED');
  end if;
  v_hash := md5(p_token);
  select * into v_link from public.class_payment_links cl where cl.token_hash = v_hash limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_INVALID');
  end if;
  if v_link.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_INACTIVE');
  end if;
  if v_link.expires_at <= now() then
    update public.class_payment_links set status = 'expired' where id = v_link.id and status = 'active';
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_EXPIRED');
  end if;
  if v_link.class_name = '__CENTER__' then
    v_scope := 'center';
  end if;

  if p_student_id is null then
    if v_scope = 'center' then
      select count(*) into v_match_count
      from public.students s
      where regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits;
    else
      select count(*) into v_match_count
      from public.students s
      where coalesce(s.class_name, 'No class') = v_link.class_name
        and regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits;
    end if;
  else
    v_match_count := 1;
  end if;

  if p_student_id is null and v_match_count = 0 then
    return jsonb_build_object('ok', false, 'reason', 'STUDENT_NOT_FOUND');
  end if;
  if p_student_id is null and v_match_count > 1 then
    if v_scope = 'center' then
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'name', s.name,
          'class_name', s.class_name
        )
      ), '[]'::jsonb)
      into v_candidates
      from public.students s
      where regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
      order by s.name;
    else
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'name', s.name,
          'class_name', s.class_name
        )
      ), '[]'::jsonb)
      into v_candidates
      from public.students s
      where coalesce(s.class_name, 'No class') = v_link.class_name
        and regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
      order by s.name;
    end if;
    return jsonb_build_object(
      'ok', false,
      'reason', 'MULTI_STUDENT',
      'scope', v_scope,
      'candidates', v_candidates
    );
  end if;

  if p_student_id is null then
    if v_scope = 'center' then
      select s.* into v_student
      from public.students s
      where regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
      limit 1;
    else
      select s.* into v_student
      from public.students s
      where coalesce(s.class_name, 'No class') = v_link.class_name
        and regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
      limit 1;
    end if;
  else
    if v_scope = 'center' then
      select s.* into v_student
      from public.students s
      where s.id = p_student_id
        and regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
      limit 1;
    else
      select s.* into v_student
      from public.students s
      where s.id = p_student_id
        and coalesce(s.class_name, 'No class') = v_link.class_name
        and regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
      limit 1;
    end if;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'STUDENT_NOT_FOUND');
    end if;
  end if;

  select count(*) into v_present
  from public.attendance a
  where a.student_id = v_student.id and a.status = 'present';

  select coalesce((
    select st.charged_sessions
    from public.student_tuition st
    where st.student_id = v_student.id
    limit 1
  ), 0)
  into v_charged;

  v_pending := greatest(0, v_present - v_charged);
  select coalesce(cf.fee_amount, 0) into v_fee
  from public.class_fees cf
  where cf.class_name = coalesce(v_student.class_name, 'No class')
  limit 1;
  v_amount := v_pending * v_fee;

  if v_pending < 1 then
    return jsonb_build_object(
      'ok', true,
      'mode', 'class',
      'link_id', v_link.id,
      'class_name', v_link.class_name,
      'payment_status', 'no_debt',
      'student', jsonb_build_object(
        'id', v_student.id, 'name', v_student.name, 'class_name', v_student.class_name, 'phone', v_phone_digits
      ),
      'pending', jsonb_build_object(
        'present_sessions', v_present,
        'charged_sessions', v_charged,
        'pending_sessions', 0,
        'fee_per_session', v_fee,
        'amount_vnd', 0,
        'transfer_content', ''
      )
    );
  end if;

  select *
  into v_existing
  from public.parent_payment_refs pr
  where pr.class_link_id = v_link.id
    and pr.student_id = v_student.id
    and pr.status = 'active'
    and pr.expires_at > now()
  order by pr.id desc
  limit 1;

  if found then
    v_ref := v_existing.ref_code;
  else
    v_ref := upper(public.make_random_hex(10));
    insert into public.parent_payment_refs(class_link_id, student_id, parent_phone, ref_code, status, expires_at)
    values (v_link.id, v_student.id, v_phone_digits, v_ref, 'active', least(v_link.expires_at, now() + interval '48 hours'));
  end if;

  v_transfer_content := coalesce(v_student.name, 'HS') || ' - ' || v_phone_digits;

  return jsonb_build_object(
    'ok', true,
    'mode', 'class',
    'scope', v_scope,
    'link_id', v_link.id,
    'class_name', case when v_scope = 'center' then 'Toàn trung tâm' else v_link.class_name end,
    'ref_code', v_ref,
    'expires_at', v_link.expires_at,
    'payment_status', coalesce(v_existing.status, 'active'),
    'student', jsonb_build_object(
      'id', v_student.id,
      'name', v_student.name,
      'class_name', v_student.class_name,
      'phone', v_phone_digits
    ),
    'pending', jsonb_build_object(
      'present_sessions', v_present,
      'charged_sessions', v_charged,
      'pending_sessions', v_pending,
      'fee_per_session', v_fee,
      'amount_vnd', v_amount,
      'transfer_content', v_transfer_content
    )
  );
end $$;

create or replace function public.create_center_payment_link(
  p_expires_hours integer default 72
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.create_class_payment_link('__CENTER__', p_expires_hours);
end $$;

create or replace function public.revoke_class_payment_link(p_link_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := false;
begin
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) into v_is_admin;
  if not v_is_admin then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;
  update public.class_payment_links
  set status = 'revoked'
  where id = p_link_id and status = 'active';
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.delete_class_payment_link(p_link_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := false;
begin
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) into v_is_admin;
  if not v_is_admin then
    return jsonb_build_object('ok', false, 'reason', 'NO_PERMISSION');
  end if;

  delete from public.parent_payment_refs
  where class_link_id = p_link_id;

  delete from public.class_payment_links
  where id = p_link_id;

  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.create_class_payment_link(text, integer) to authenticated;
grant execute on function public.resolve_class_payment_token(text) to anon, authenticated, service_role;
grant execute on function public.resolve_class_parent_payment(text, text, uuid) to anon, authenticated, service_role;
grant execute on function public.revoke_class_payment_link(bigint) to authenticated;
grant execute on function public.delete_class_payment_link(bigint) to authenticated;
grant execute on function public.create_center_payment_link(integer) to authenticated;

alter table public.bank_webhook_events enable row level security;
alter table public.bank_transactions enable row level security;
alter table public.class_payment_links enable row level security;
alter table public.parent_payment_refs enable row level security;

drop policy if exists bank_webhook_events_admin_select on public.bank_webhook_events;
create policy bank_webhook_events_admin_select
  on public.bank_webhook_events
  for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists bank_transactions_admin_select on public.bank_transactions;
create policy bank_transactions_admin_select
  on public.bank_transactions
  for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists class_payment_links_admin_all on public.class_payment_links;
create policy class_payment_links_admin_all
  on public.class_payment_links
  for all to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists parent_payment_refs_admin_all on public.parent_payment_refs;
create policy parent_payment_refs_admin_all
  on public.parent_payment_refs
  for all to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

grant select on table public.bank_webhook_events to authenticated;
grant select on table public.bank_transactions to authenticated;
grant select, insert, update, delete on table public.class_payment_links to authenticated;
grant select, insert, update, delete on table public.parent_payment_refs to authenticated;
