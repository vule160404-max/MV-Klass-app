-- =============================================================================
-- 079 - Portal Premium checkout, package entitlements, and bank auto activation
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.portal_premium_products (
  product_key text primary key,
  portal_free_group text not null,
  title text not null,
  description text not null default '',
  price_vnd integer not null default 0 check (price_vnd >= 0),
  is_active boolean not null default true,
  sort_order integer not null default 100,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portal_premium_products_group_check
    check (portal_free_group in ('entrance_10', 'university', 'ielts'))
);

drop trigger if exists trg_portal_premium_products_updated_at on public.portal_premium_products;
create trigger trg_portal_premium_products_updated_at
before update on public.portal_premium_products
for each row execute procedure public.tg_set_updated_at();

insert into public.portal_premium_products (
  product_key,
  portal_free_group,
  title,
  description,
  price_vnd,
  is_active,
  sort_order
)
values
  (
    'entrance_10',
    'entrance_10',
    'Gói Vào 10 Tiếng Anh',
    'Bao gồm đề thi form sở Thanh Hóa bám sát cấu trúc đề thi thật. Có lời giải chi tiết, đáp án.',
    0,
    true,
    10
  ),
  (
    'university',
    'university',
    'Gói THPT QG Tiếng Anh',
    'Bao gồm đề minh họa tốt nghiệp THPT. Có lời giải chi tiết, đáp án.',
    0,
    true,
    20
  )
on conflict (product_key) do update
set
  portal_free_group = excluded.portal_free_group,
  title = excluded.title,
  description = case
    when nullif(public.portal_premium_products.description, '') is null then excluded.description
    else public.portal_premium_products.description
  end,
  sort_order = excluded.sort_order,
  updated_at = now();

create table if not exists public.portal_premium_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null references public.portal_premium_products(product_key),
  amount_vnd integer not null check (amount_vnd >= 0),
  ref_code text not null unique,
  transfer_content text not null,
  status text not null default 'pending',
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  paid_at timestamptz,
  bank_transaction_id bigint references public.bank_transactions(id) on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portal_premium_orders_status_check
    check (status in ('pending', 'paid', 'cancelled', 'expired', 'needs_review'))
);

drop trigger if exists trg_portal_premium_orders_updated_at on public.portal_premium_orders;
create trigger trg_portal_premium_orders_updated_at
before update on public.portal_premium_orders
for each row execute procedure public.tg_set_updated_at();

create index if not exists portal_premium_orders_user_created_idx
  on public.portal_premium_orders(user_id, created_at desc);

create index if not exists portal_premium_orders_status_expiry_idx
  on public.portal_premium_orders(status, expires_at);

create index if not exists portal_premium_orders_product_idx
  on public.portal_premium_orders(product_key, created_at desc);

create table if not exists public.portal_premium_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null references public.portal_premium_products(product_key),
  portal_free_group text not null,
  source_order_id uuid references public.portal_premium_orders(id) on delete set null,
  status text not null default 'active',
  activated_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portal_premium_entitlements_group_check
    check (portal_free_group in ('entrance_10', 'university', 'ielts')),
  constraint portal_premium_entitlements_status_check
    check (status in ('active', 'revoked')),
  constraint portal_premium_entitlements_user_product_uidx
    unique (user_id, product_key)
);

drop trigger if exists trg_portal_premium_entitlements_updated_at on public.portal_premium_entitlements;
create trigger trg_portal_premium_entitlements_updated_at
before update on public.portal_premium_entitlements
for each row execute procedure public.tg_set_updated_at();

create index if not exists portal_premium_entitlements_user_group_idx
  on public.portal_premium_entitlements(user_id, portal_free_group, status);

alter table public.portal_premium_products enable row level security;
alter table public.portal_premium_orders enable row level security;
alter table public.portal_premium_entitlements enable row level security;

drop policy if exists portal_premium_products_select on public.portal_premium_products;
create policy portal_premium_products_select
on public.portal_premium_products
for select
to authenticated
using (
  is_active
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
);

drop policy if exists portal_premium_products_admin_write on public.portal_premium_products;
create policy portal_premium_products_admin_write
on public.portal_premium_products
for all
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
);

drop policy if exists portal_premium_orders_select_own_or_admin on public.portal_premium_orders;
create policy portal_premium_orders_select_own_or_admin
on public.portal_premium_orders
for select
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
);

drop policy if exists portal_premium_entitlements_select_own_or_admin on public.portal_premium_entitlements;
create policy portal_premium_entitlements_select_own_or_admin
on public.portal_premium_entitlements
for select
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
);

grant select, insert, update on table public.portal_premium_products to authenticated;
grant select on table public.portal_premium_orders to authenticated;
grant select on table public.portal_premium_entitlements to authenticated;
grant all on table public.portal_premium_products to service_role;
grant all on table public.portal_premium_orders to service_role;
grant all on table public.portal_premium_entitlements to service_role;

alter table public.bank_transactions
  add column if not exists payment_kind text not null default 'tuition',
  add column if not exists matched_profile_id uuid references auth.users(id) on delete set null,
  add column if not exists portal_premium_order_id uuid references public.portal_premium_orders(id) on delete set null;

alter table public.bank_transactions
  drop constraint if exists bank_transactions_payment_kind_check;

alter table public.bank_transactions
  add constraint bank_transactions_payment_kind_check
  check (payment_kind in ('tuition', 'premium'));

create index if not exists bank_transactions_payment_kind_idx
  on public.bank_transactions(payment_kind, status, created_at desc);

create index if not exists bank_transactions_portal_premium_order_idx
  on public.bank_transactions(portal_premium_order_id)
  where portal_premium_order_id is not null;

create or replace function public.portal_exam_group_key(p_level text)
returns text
language sql
immutable
as $$
  select case
    when lower(trim(coalesce(p_level, ''))) = 'university' then 'university'
    when lower(trim(coalesce(p_level, ''))) = 'ielts' then 'ielts'
    else 'entrance_10'
  end;
$$;

create or replace function public.portal_premium_product_exam_count(p_portal_free_group text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.exam_files e
  where e.is_published = true
    and e.subject = 'english'
    and coalesce(e.category, '') <> 'answer'
    and public.portal_exam_group_key(e.level) = public.portal_exam_group_key(p_portal_free_group);
$$;

create or replace function public.current_portal_has_group_access(p_portal_free_group text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.portal_premium_entitlements pe
    where pe.user_id = auth.uid()
      and pe.status = 'active'
      and (pe.expires_at is null or pe.expires_at > now())
      and pe.portal_free_group = public.portal_exam_group_key(p_portal_free_group)
  );
$$;

create or replace function public.list_portal_premium_products()
returns table (
  product_key text,
  portal_free_group text,
  title text,
  description text,
  price_vnd integer,
  is_active boolean,
  sort_order integer,
  exam_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.product_key,
    p.portal_free_group,
    p.title,
    p.description,
    p.price_vnd,
    p.is_active,
    p.sort_order,
    public.portal_premium_product_exam_count(p.portal_free_group) as exam_count
  from public.portal_premium_products p
  where p.is_active
     or exists (
       select 1
       from public.profiles pr
       where pr.id = auth.uid() and pr.role = 'admin'
     )
  order by p.sort_order asc, p.product_key asc;
$$;

create or replace function public.portal_premium_make_ref_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
  i integer := 0;
begin
  loop
    i := i + 1;
    v_ref := 'PM' || upper(encode(gen_random_bytes(5), 'hex'));
    exit when not exists (
      select 1 from public.portal_premium_orders o where o.ref_code = v_ref
    );
    if i > 40 then
      raise exception 'ref_code_generation_failed';
    end if;
  end loop;
  return v_ref;
end;
$$;

create or replace function public.create_portal_premium_order(p_product_key text)
returns table (
  id uuid,
  product_key text,
  portal_free_group text,
  amount_vnd integer,
  ref_code text,
  transfer_content text,
  status text,
  expires_at timestamptz,
  created_at timestamptz,
  paid_at timestamptz,
  title text,
  description text,
  exam_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_portal_status text;
  v_product public.portal_premium_products%rowtype;
  v_order public.portal_premium_orders%rowtype;
  v_ref text;
begin
  if v_uid is null then
    raise exception 'login_required';
  end if;

  select p.role, coalesce(p.portal_status, 'active')
  into v_role, v_portal_status
  from public.profiles p
  where p.id = v_uid;

  if not found or v_role <> 'student' then
    raise exception 'student_required';
  end if;

  if v_portal_status <> 'active' then
    raise exception 'portal_not_active';
  end if;

  select *
  into v_product
  from public.portal_premium_products p
  where p.product_key = lower(trim(coalesce(p_product_key, '')))
    and p.is_active = true
  limit 1;

  if not found then
    raise exception 'product_not_found';
  end if;

  if coalesce(v_product.price_vnd, 0) <= 0 then
    raise exception 'product_not_ready';
  end if;

  if exists (
    select 1
    from public.portal_premium_entitlements pe
    where pe.user_id = v_uid
      and pe.product_key = v_product.product_key
      and pe.status = 'active'
      and (pe.expires_at is null or pe.expires_at > now())
  ) then
    select *
    into v_order
    from public.portal_premium_orders o
    where o.user_id = v_uid
      and o.product_key = v_product.product_key
      and o.status = 'paid'
    order by o.paid_at desc nulls last, o.created_at desc
    limit 1;

    if found then
      return query
        select
          v_order.id,
          v_order.product_key,
          v_product.portal_free_group,
          v_order.amount_vnd,
          v_order.ref_code,
          v_order.transfer_content,
          v_order.status,
          v_order.expires_at,
          v_order.created_at,
          v_order.paid_at,
          v_product.title,
          v_product.description,
          public.portal_premium_product_exam_count(v_product.portal_free_group);
      return;
    end if;

    raise exception 'already_entitled';
  end if;

  select *
  into v_order
  from public.portal_premium_orders o
  where o.user_id = v_uid
    and o.product_key = v_product.product_key
    and o.amount_vnd = v_product.price_vnd
    and o.status = 'pending'
    and o.expires_at > now()
  order by o.created_at desc
  limit 1;

  if not found then
    v_ref := public.portal_premium_make_ref_code();
    insert into public.portal_premium_orders(
      user_id,
      product_key,
      amount_vnd,
      ref_code,
      transfer_content,
      status,
      expires_at
    )
    values (
      v_uid,
      v_product.product_key,
      v_product.price_vnd,
      v_ref,
      'MVK PREMIUM REF ' || v_ref || ' ' || upper(v_product.product_key),
      'pending',
      now() + interval '30 minutes'
    )
    returning * into v_order;
  end if;

  return query
    select
      v_order.id,
      v_order.product_key,
      v_product.portal_free_group,
      v_order.amount_vnd,
      v_order.ref_code,
      v_order.transfer_content,
      v_order.status,
      v_order.expires_at,
      v_order.created_at,
      v_order.paid_at,
      v_product.title,
      v_product.description,
      public.portal_premium_product_exam_count(v_product.portal_free_group);
end;
$$;

create or replace function public.get_my_portal_premium_orders()
returns table (
  id uuid,
  product_key text,
  portal_free_group text,
  amount_vnd integer,
  ref_code text,
  transfer_content text,
  status text,
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz,
  title text,
  description text,
  exam_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id,
    o.product_key,
    p.portal_free_group,
    o.amount_vnd,
    o.ref_code,
    o.transfer_content,
    case when o.status = 'pending' and o.expires_at <= now() then 'expired' else o.status end as status,
    o.expires_at,
    o.paid_at,
    o.created_at,
    p.title,
    p.description,
    public.portal_premium_product_exam_count(p.portal_free_group) as exam_count
  from public.portal_premium_orders o
  join public.portal_premium_products p on p.product_key = o.product_key
  where o.user_id = auth.uid()
  order by o.created_at desc
  limit 50;
$$;

create or replace function public.can_access_exam_file(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.exam_files e
    where e.id = p_exam_id
      and e.is_published = true
      and (
        public.is_app_admin_or_teacher()
        or (
          public.current_portal_status() = 'active'
          and (
            public.current_portal_plan() = 'premium'
            or public.current_portal_has_group_access(public.portal_exam_group_key(e.level))
            or public.is_curated_free_exam(e.id)
          )
        )
      )
  );
$$;

create or replace function public.student_exam_locked_reason(
  p_exam_id uuid,
  p_access_tier text,
  p_free_rank integer
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_app_admin_or_teacher() then null
    when public.current_portal_status() = 'pending' then 'pending_approval'
    when public.current_portal_status() = 'blocked' then 'account_blocked'
    when public.current_portal_plan() = 'premium' then null
    when exists (
      select 1
      from public.exam_files e
      where e.id = p_exam_id
        and public.current_portal_has_group_access(public.portal_exam_group_key(e.level))
    ) then null
    when public.is_curated_free_exam(p_exam_id) then null
    when coalesce(p_access_tier, 'free') = 'premium' then 'premium_required'
    else 'free_limit'
  end;
$$;

drop function if exists public.list_student_exam_files();

create function public.list_student_exam_files()
returns table (
  id uuid,
  title text,
  level text,
  subject text,
  year integer,
  province text,
  exam_code text,
  exam_sort_order integer,
  category text,
  storage_path text,
  answer_path text,
  audio_path text,
  access_tier text,
  free_rank integer,
  description text,
  download_count integer,
  created_at timestamptz,
  is_published boolean,
  can_access boolean,
  locked_reason text,
  free_group text,
  group_free_rank integer,
  storage_provider text,
  object_key text,
  answer_object_key text,
  audio_object_key text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id,
    e.title,
    e.level,
    e.subject,
    e.year,
    e.province,
    e.exam_code,
    e.exam_sort_order,
    e.category,
    e.storage_path,
    e.answer_path,
    e.audio_path,
    e.access_tier,
    e.free_rank,
    e.description,
    e.download_count,
    e.created_at,
    e.is_published,
    public.can_access_exam_file(e.id) as can_access,
    public.student_exam_locked_reason(e.id, e.access_tier, e.free_rank) as locked_reason,
    e.free_group,
    e.group_free_rank,
    e.storage_provider,
    e.object_key,
    e.answer_object_key,
    e.audio_object_key
  from public.exam_files e
  where e.is_published = true
    and e.subject = 'english'
  order by e.level asc, e.year desc nulls last, e.province asc nulls last, e.exam_sort_order asc nulls last, e.created_at desc;
$$;

create or replace function public.fn_try_apply_portal_premium_order(p_txn_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions%rowtype;
  v_ref_code text := null;
  v_order public.portal_premium_orders%rowtype;
  v_product public.portal_premium_products%rowtype;
  v_existing_order public.portal_premium_orders%rowtype;
  v_note text := '';
begin
  select *
  into v_txn
  from public.bank_transactions
  where id = p_txn_id
  for update;

  if not found then
    return jsonb_build_object('matched', false, 'ok', false, 'reason', 'TXN_NOT_FOUND');
  end if;

  v_ref_code := public.extract_payment_ref_from_transfer_content(v_txn.transfer_content);

  if v_ref_code is null or v_ref_code !~ '^PM[A-Z0-9]{8,14}$' then
    return jsonb_build_object('matched', false);
  end if;

  select *
  into v_order
  from public.portal_premium_orders o
  where o.ref_code = v_ref_code
  order by o.created_at desc
  limit 1
  for update;

  if not found then
    update public.bank_transactions
    set status = 'needs_review',
        payment_kind = 'premium',
        match_confidence = 'high',
        match_score = 120,
        match_method = 'premium_ref_missing',
        match_candidates = '[]'::jsonb,
        error_note = 'Premium ref khong ton tai hoac da bi huy: ' || v_ref_code
    where id = v_txn.id;

    return jsonb_build_object(
      'matched', true,
      'ok', false,
      'reason', 'PREMIUM_REF_NOT_FOUND',
      'txn_id', v_txn.id,
      'ref_code', v_ref_code
    );
  end if;

  select *
  into v_product
  from public.portal_premium_products p
  where p.product_key = v_order.product_key
  limit 1;

  if v_order.status = 'paid' then
    if v_order.bank_transaction_id = v_txn.id then
      update public.bank_transactions
      set status = 'applied',
          payment_kind = 'premium',
          matched_profile_id = v_order.user_id,
          portal_premium_order_id = v_order.id,
          matched_class_name = coalesce(v_product.title, v_order.product_key),
          match_confidence = 'high',
          match_score = 250,
          match_method = 'premium_ref',
          match_candidates = jsonb_build_array(jsonb_build_object(
            'type', 'portal_premium_order',
            'order_id', v_order.id,
            'product_key', v_order.product_key,
            'portal_free_group', v_product.portal_free_group,
            'title', v_product.title,
            'score', 250,
            'confidence', 'high',
            'match_method', 'premium_ref',
            'matched_text', v_ref_code
          )),
          reconcile_note = 'Auto Premium: ' || coalesce(v_product.title, v_order.product_key) || ' / REF ' || v_ref_code,
          extracted_sessions = 0,
          applied_sessions = 0,
          applied_amount_vnd = coalesce(v_txn.amount_vnd, 0),
          applied_payment_history_id = null,
          error_note = null
      where id = v_txn.id;

      return jsonb_build_object(
        'matched', true,
        'ok', true,
        'reason', 'PREMIUM_ALREADY_APPLIED',
        'txn_id', v_txn.id,
        'order_id', v_order.id
      );
    end if;

    update public.bank_transactions
    set status = 'needs_review',
        payment_kind = 'premium',
        matched_profile_id = v_order.user_id,
        portal_premium_order_id = v_order.id,
        match_confidence = 'high',
        match_score = 120,
        match_method = 'premium_ref_duplicate',
        match_candidates = jsonb_build_array(jsonb_build_object(
          'order_id', v_order.id,
          'product_key', v_order.product_key,
          'status', v_order.status
        )),
        error_note = 'Premium order da thanh toan bang giao dich khac'
    where id = v_txn.id;

    return jsonb_build_object(
      'matched', true,
      'ok', false,
      'reason', 'PREMIUM_ORDER_ALREADY_PAID',
      'txn_id', v_txn.id,
      'order_id', v_order.id
    );
  end if;

  if v_order.status <> 'pending' then
    update public.bank_transactions
    set status = 'needs_review',
        payment_kind = 'premium',
        matched_profile_id = v_order.user_id,
        portal_premium_order_id = v_order.id,
        match_confidence = 'high',
        match_score = 120,
        match_method = 'premium_ref_invalid_status',
        match_candidates = jsonb_build_array(jsonb_build_object(
          'order_id', v_order.id,
          'product_key', v_order.product_key,
          'status', v_order.status
        )),
        error_note = 'Premium order khong con pending: ' || v_order.status
    where id = v_txn.id;

    return jsonb_build_object(
      'matched', true,
      'ok', false,
      'reason', 'PREMIUM_ORDER_INVALID_STATUS',
      'txn_id', v_txn.id,
      'order_id', v_order.id
    );
  end if;

  if v_order.expires_at <= now() then
    update public.portal_premium_orders
    set status = 'expired',
        review_note = 'Bank transfer arrived after checkout expiry',
        bank_transaction_id = v_txn.id
    where id = v_order.id;

    update public.bank_transactions
    set status = 'needs_review',
        payment_kind = 'premium',
        matched_profile_id = v_order.user_id,
        portal_premium_order_id = v_order.id,
        match_confidence = 'high',
        match_score = 120,
        match_method = 'premium_ref_expired',
        match_candidates = jsonb_build_array(jsonb_build_object(
          'order_id', v_order.id,
          'product_key', v_order.product_key,
          'status', 'expired'
        )),
        error_note = 'Premium order da het han'
    where id = v_txn.id;

    return jsonb_build_object(
      'matched', true,
      'ok', false,
      'reason', 'PREMIUM_ORDER_EXPIRED',
      'txn_id', v_txn.id,
      'order_id', v_order.id
    );
  end if;

  if coalesce(v_txn.amount_vnd, 0) <> coalesce(v_order.amount_vnd, 0) then
    v_note := 'Sai so tien Premium: CK ' || coalesce(v_txn.amount_vnd, 0)::text ||
      ', can ' || coalesce(v_order.amount_vnd, 0)::text;

    update public.portal_premium_orders
    set status = 'needs_review',
        review_note = v_note,
        bank_transaction_id = v_txn.id
    where id = v_order.id;

    update public.bank_transactions
    set status = 'needs_review',
        payment_kind = 'premium',
        matched_profile_id = v_order.user_id,
        portal_premium_order_id = v_order.id,
        match_confidence = 'high',
        match_score = 180,
        match_method = 'premium_ref_amount_mismatch',
        match_candidates = jsonb_build_array(jsonb_build_object(
          'order_id', v_order.id,
          'product_key', v_order.product_key,
          'expected_amount_vnd', v_order.amount_vnd,
          'received_amount_vnd', v_txn.amount_vnd
        )),
        error_note = v_note
    where id = v_txn.id;

    return jsonb_build_object(
      'matched', true,
      'ok', false,
      'reason', 'PREMIUM_AMOUNT_MISMATCH',
      'txn_id', v_txn.id,
      'order_id', v_order.id,
      'expected_amount_vnd', v_order.amount_vnd,
      'received_amount_vnd', v_txn.amount_vnd
    );
  end if;

  update public.portal_premium_orders
  set status = 'paid',
      paid_at = coalesce(v_txn.occurred_at, now()),
      bank_transaction_id = v_txn.id,
      review_note = null
  where id = v_order.id
  returning * into v_existing_order;

  insert into public.portal_premium_entitlements(
    user_id,
    product_key,
    portal_free_group,
    source_order_id,
    status,
    activated_at,
    expires_at
  )
  values (
    v_order.user_id,
    v_order.product_key,
    v_product.portal_free_group,
    v_order.id,
    'active',
    coalesce(v_txn.occurred_at, now()),
    null
  )
  on conflict (user_id, product_key)
  do update set
    portal_free_group = excluded.portal_free_group,
    source_order_id = excluded.source_order_id,
    status = 'active',
    activated_at = coalesce(public.portal_premium_entitlements.activated_at, excluded.activated_at),
    expires_at = null,
    updated_at = now();

  insert into public.portal_account_audit(
    actor_id,
    target_user_id,
    action,
    old_portal_plan,
    new_portal_plan,
    old_portal_status,
    new_portal_status,
    note
  )
  select
    null,
    v_order.user_id,
    'premium_payment_activated',
    p.portal_plan,
    p.portal_plan,
    p.portal_status,
    p.portal_status,
    'Auto Premium: ' || coalesce(v_product.title, v_order.product_key) || ' / REF ' || v_order.ref_code
  from public.profiles p
  where p.id = v_order.user_id;

  update public.bank_transactions
  set status = 'applied',
      payment_kind = 'premium',
      matched_profile_id = v_order.user_id,
      portal_premium_order_id = v_order.id,
      matched_class_name = coalesce(v_product.title, v_order.product_key),
      match_confidence = 'high',
      match_score = 250,
      match_method = 'premium_ref',
      match_candidates = jsonb_build_array(jsonb_build_object(
        'type', 'portal_premium_order',
        'order_id', v_order.id,
        'product_key', v_order.product_key,
        'portal_free_group', v_product.portal_free_group,
        'title', v_product.title,
        'score', 250,
        'confidence', 'high',
        'match_method', 'premium_ref',
        'matched_text', v_ref_code
      )),
      reconcile_note = 'Auto Premium: ' || coalesce(v_product.title, v_order.product_key) || ' / REF ' || v_ref_code,
      extracted_sessions = 0,
      applied_sessions = 0,
      applied_amount_vnd = coalesce(v_txn.amount_vnd, 0),
      applied_payment_history_id = null,
      error_note = null
  where id = v_txn.id;

  return jsonb_build_object(
    'matched', true,
    'ok', true,
    'reason', 'PREMIUM_APPLIED',
    'txn_id', v_txn.id,
    'order_id', v_order.id,
    'user_id', v_order.user_id,
    'product_key', v_order.product_key,
    'portal_free_group', v_product.portal_free_group,
    'amount_vnd', coalesce(v_txn.amount_vnd, 0)
  );
exception when others then
  update public.bank_transactions
  set status = 'error',
      payment_kind = 'premium',
      error_note = sqlerrm
  where id = p_txn_id;
  return jsonb_build_object('matched', true, 'ok', false, 'reason', 'PREMIUM_EXCEPTION', 'message', sqlerrm);
end;
$$;

create or replace function public.fn_auto_apply_bank_transaction(p_txn_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions%rowtype;
  v_premium_result jsonb := null;
  v_ref_code text := null;
  v_parent_ref_rec public.parent_payment_refs%rowtype;
  v_content_digits text := '';
  v_student_id uuid := null;
  v_match_confidence text := null;
  v_match_score integer := null;
  v_match_method text := null;
  v_match_candidates jsonb := '[]'::jsonb;
  v_top record;
  v_near_count integer := 0;
  v_classes text[] := '{}'::text[];
  v_line record;
  v_remaining integer := 0;
  v_total_sessions integer := 0;
  v_total_applied integer := 0;
  v_first_payment_id bigint := null;
  v_last_payment_id bigint := null;
  v_prepaid_class text := '';
  v_prepaid_fee integer := 0;
  v_class_names text[] := '{}'::text[];
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

  if v_txn.status = 'manual_not_received' then
    return jsonb_build_object('ok', false, 'reason', 'MANUAL_NOT_RECEIVED', 'txn_id', v_txn.id);
  end if;

  if v_txn.amount_vnd <= 0 then
    update public.bank_transactions
    set status = 'ignored',
        error_note = 'So tien <= 0',
        match_candidates = '[]'::jsonb
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'INVALID_AMOUNT');
  end if;

  v_premium_result := public.fn_try_apply_portal_premium_order(v_txn.id);
  if coalesce((v_premium_result->>'matched')::boolean, false) then
    return v_premium_result;
  end if;

  v_content_digits := regexp_replace(coalesce(v_txn.transfer_content, ''), '\D', '', 'g');
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
      v_match_confidence := 'high';
      v_match_score := 200;
      v_match_method := 'ref';
      select jsonb_build_array(jsonb_build_object(
        'student_id', s.id,
        'student_name', s.name,
        'parent_name', s.parent_name,
        'class_name', s.class_name,
        'phone', s.phone,
        'score', 200,
        'confidence', 'high',
        'match_method', 'ref',
        'matched_text', v_ref_code
      ))
      into v_match_candidates
      from public.students s
      where s.id = v_student_id;
    end if;
  end if;

  if v_student_id is null then
    with c as (
      select *
      from public.match_students_from_transfer_content(v_txn.transfer_content)
      where score >= 60
      order by score desc, student_name
      limit 5
    ),
    top_score as (
      select coalesce(max(score), 0)::integer as score from c
    ),
    near_best as (
      select c.*
      from c, top_score t
      where t.score >= 60
        and c.score >= t.score - 8
    )
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'student_id', c.student_id,
        'student_name', c.student_name,
        'parent_name', c.parent_name,
        'class_name', c.class_name,
        'phone', c.phone,
        'score', c.score,
        'confidence', c.confidence,
        'match_method', c.match_method,
        'matched_text', c.matched_text,
        'matched_tokens', c.matched_tokens
      ) order by c.score desc, c.student_name), '[]'::jsonb),
      (select count(*)::integer from near_best)
    into v_match_candidates, v_near_count
    from c;

    select *
    into v_top
    from public.match_students_from_transfer_content(v_txn.transfer_content)
    where score >= 60
    order by score desc, student_name
    limit 1;

    if found then
      v_match_confidence := v_top.confidence;
      v_match_score := v_top.score;
      v_match_method := v_top.match_method;
      if v_top.confidence = 'high' and v_near_count = 1 then
        v_student_id := v_top.student_id;
      end if;
    end if;
  end if;

  if v_student_id is null then
    update public.bank_transactions
    set status = 'needs_review',
        match_confidence = v_match_confidence,
        match_score = v_match_score,
        match_method = v_match_method,
        match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
        error_note = case
          when jsonb_array_length(coalesce(v_match_candidates, '[]'::jsonb)) = 0 then
            'Khong match duoc hoc sinh theo noi dung chuyen khoan'
          else
            'Match chua du chac chan, can chon hoc sinh tu goi y'
        end
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'CANDIDATE_NOT_UNIQUE', 'count', v_near_count);
  end if;

  select array_agg(distinct c) filter (where c is not null and btrim(c) <> '')
  into v_classes
  from (
    select unnest(coalesce(s.class_names, '{}'::text[])) as c
    from public.students s
    where s.id = v_student_id
    union all
    select nullif(btrim(s.class_name), '') as c
    from public.students s
    where s.id = v_student_id
    union all
    select distinct nullif(btrim(a.class_name), '') as c
    from public.attendance a
    where a.student_id = v_student_id
      and a.status = 'present'
      and nullif(btrim(coalesce(a.class_name, '')), '') is not null
    union all
    select nullif(btrim(stc.class_name), '') as c
    from public.student_tuition_by_class stc
    where stc.student_id = v_student_id
  ) u;

  if coalesce(array_length(v_classes, 1), 0) = 0 then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        match_confidence = v_match_confidence,
        match_score = v_match_score,
        match_method = v_match_method,
        match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
        error_note = 'Hoc sinh chua co lop de doi soat'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'NO_CLASS_FOR_STUDENT');
  end if;

  v_remaining := coalesce(v_txn.amount_vnd, 0);

  for v_line in
    with raw as (
      select distinct nullif(btrim(c), '') as class_name
      from unnest(v_classes) c
      where nullif(btrim(c), '') is not null
    ),
    assigned_norm as (
      select distinct public.normalize_lookup_text(nullif(btrim(t.x), '')) as n
      from public.students s,
      lateral (
        select s.class_name as x
        union all
        select unnest(coalesce(s.class_names, '{}'::text[])) as x
      ) t
      where s.id = v_student_id
        and nullif(btrim(t.x), '') is not null
    ),
    with_meta as (
      select
        r.class_name,
        public.fn_pending_sessions_for_class(v_student_id, r.class_name) as pend,
        (select coalesce(cf.fee_amount, 0) from public.class_fees cf where cf.class_name = r.class_name limit 1) as fee,
        case when exists (
          select 1 from assigned_norm an where an.n = public.normalize_lookup_text(r.class_name)
        ) then 1 else 2 end as tier
      from raw r
    )
    select *,
      case
        when pend > 0 and pend * fee = v_txn.amount_vnd then 1
        when pend > 0 and v_txn.amount_vnd > pend * fee then 2
        when pend > 0 and v_txn.amount_vnd < pend * fee and mod(v_txn.amount_vnd, fee) = 0 then 3
        when pend > 0 then 4
        else 9
      end as debt_rank
    from with_meta
    where fee > 0
    order by debt_rank, tier, class_name
  loop
    if v_prepaid_class = '' and v_line.tier = 1 then
      v_prepaid_class := v_line.class_name;
      v_prepaid_fee := v_line.fee;
    end if;
    if coalesce(v_line.pend, 0) <= 0 or v_remaining < coalesce(v_line.fee, 0) then
      continue;
    end if;

    declare
      v_sessions integer := least(v_line.pend, floor(v_remaining::numeric / v_line.fee::numeric)::integer);
      v_amount integer := v_sessions * v_line.fee;
    begin
      if v_sessions < 1 then
        continue;
      end if;

      insert into public.student_tuition_by_class(student_id, class_name, charged_sessions, prepaid_balance_vnd)
      values (v_student_id, v_line.class_name, v_sessions, 0)
      on conflict (student_id, class_name)
      do update set
        charged_sessions = coalesce(public.student_tuition_by_class.charged_sessions, 0) + excluded.charged_sessions,
        updated_at = now();

      insert into public.payment_history(
        student_id,
        sessions_paid,
        sessions_applied_to_charged,
        amount_vnd,
        prepaid_topup_vnd,
        paid_at,
        payment_channel,
        class_name,
        reconcile_note,
        bank_transaction_id
      )
      values (
        v_student_id,
        v_sessions,
        v_sessions,
        v_amount,
        0,
        coalesce(v_txn.occurred_at, now()),
        'bank_auto',
        v_line.class_name,
        'Auto CK: match ' || coalesce(v_match_method, 'unknown') ||
          ' (' || coalesce(v_match_confidence, 'unknown') || ', score ' || coalesce(v_match_score, 0)::text || ')' ||
          ' - tru no truoc',
        v_txn.id
      )
      returning id into v_last_payment_id;

      if v_first_payment_id is null then
        v_first_payment_id := v_last_payment_id;
      end if;
      v_total_sessions := v_total_sessions + v_sessions;
      v_total_applied := v_total_applied + v_amount;
      v_remaining := greatest(0, v_remaining - v_amount);
      v_class_names := array_append(v_class_names, v_line.class_name);
    end;
  end loop;

  if v_remaining > 0 then
    if v_prepaid_class = '' then
      select c, coalesce(cf.fee_amount, 0)
      into v_prepaid_class, v_prepaid_fee
      from unnest(v_classes) c
      left join public.class_fees cf on cf.class_name = c
      where c is not null and btrim(c) <> '' and coalesce(cf.fee_amount, 0) > 0
      order by c
      limit 1;
    end if;

    if coalesce(v_prepaid_class, '') = '' then
      update public.bank_transactions
      set status = 'needs_review',
          matched_student_id = v_student_id,
          match_confidence = v_match_confidence,
          match_score = v_match_score,
          match_method = v_match_method,
          match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
          error_note = 'Khong chon duoc lop de luu hoc phi du'
      where id = v_txn.id;
      return jsonb_build_object('ok', false, 'reason', 'NO_PREPAID_CLASS');
    end if;

    insert into public.student_tuition_by_class(student_id, class_name, charged_sessions, prepaid_balance_vnd)
    values (v_student_id, v_prepaid_class, 0, v_remaining)
    on conflict (student_id, class_name)
    do update set
      prepaid_balance_vnd = coalesce(public.student_tuition_by_class.prepaid_balance_vnd, 0) + excluded.prepaid_balance_vnd,
      updated_at = now();

    insert into public.payment_history(
      student_id,
      sessions_paid,
      sessions_applied_to_charged,
      amount_vnd,
      prepaid_topup_vnd,
      paid_at,
      payment_channel,
      class_name,
      reconcile_note,
      bank_transaction_id
    )
    values (
      v_student_id,
      case when coalesce(v_prepaid_fee, 0) > 0 then floor(v_remaining::numeric / v_prepaid_fee::numeric)::integer else 0 end,
      0,
      v_remaining,
      v_remaining,
      coalesce(v_txn.occurred_at, now()),
      'bank_auto',
      v_prepaid_class,
      'Auto CK: match ' || coalesce(v_match_method, 'unknown') ||
        ' (' || coalesce(v_match_confidence, 'unknown') || ', score ' || coalesce(v_match_score, 0)::text || ')' ||
        ' - het no truoc, phan con lai vao tra truoc',
      v_txn.id
    )
    returning id into v_last_payment_id;

    if v_first_payment_id is null then
      v_first_payment_id := v_last_payment_id;
    end if;
    v_class_names := array_append(v_class_names, v_prepaid_class);
  end if;

  if v_first_payment_id is null then
    update public.bank_transactions
    set status = 'needs_review',
        matched_student_id = v_student_id,
        match_confidence = v_match_confidence,
        match_score = v_match_score,
        match_method = v_match_method,
        match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
        error_note = 'So tien CK khong du ghi nhan buoi hoac hoc phi du'
    where id = v_txn.id;
    return jsonb_build_object('ok', false, 'reason', 'AMOUNT_TOO_SMALL');
  end if;

  perform public.fn_sync_student_tuition_total(v_student_id);

  update public.bank_transactions
  set status = 'applied',
      matched_student_id = v_student_id,
      matched_class_name = (
        select string_agg(distinct x, ', ' order by x)
        from unnest(v_class_names) x
        where x is not null and btrim(x) <> ''
      ),
      match_confidence = v_match_confidence,
      match_score = v_match_score,
      match_method = v_match_method,
      match_candidates = coalesce(v_match_candidates, '[]'::jsonb),
      reconcile_note = 'Auto: match ' || coalesce(v_match_method, 'unknown') ||
        ' (' || coalesce(v_match_confidence, 'unknown') || ', score ' || coalesce(v_match_score, 0)::text || ')' ||
        ' - tru no truoc' ||
        case when greatest(0, coalesce(v_txn.amount_vnd, 0) - v_total_applied) > 0
          then ' - con du vao tra truoc'
          else ''
        end,
      extracted_sessions = v_total_sessions,
      applied_sessions = v_total_sessions,
      applied_amount_vnd = coalesce(v_txn.amount_vnd, 0),
      applied_payment_history_id = v_first_payment_id,
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
    'sessions', v_total_sessions,
    'amount_vnd', coalesce(v_txn.amount_vnd, 0),
    'prepaid_topup_vnd', greatest(0, coalesce(v_txn.amount_vnd, 0) - v_total_applied),
    'payment_history_id', v_first_payment_id
  );
exception when others then
  update public.bank_transactions
  set status = 'error',
      error_note = sqlerrm
  where id = p_txn_id;
  return jsonb_build_object('ok', false, 'reason', 'EXCEPTION', 'message', sqlerrm);
end $$;

grant execute on function public.portal_exam_group_key(text) to authenticated;
grant execute on function public.portal_premium_product_exam_count(text) to authenticated;
grant execute on function public.current_portal_has_group_access(text) to authenticated;
grant execute on function public.list_portal_premium_products() to authenticated;
grant execute on function public.create_portal_premium_order(text) to authenticated;
grant execute on function public.get_my_portal_premium_orders() to authenticated;
grant execute on function public.can_access_exam_file(uuid) to authenticated;
grant execute on function public.student_exam_locked_reason(uuid, text, integer) to authenticated;
grant execute on function public.list_student_exam_files() to authenticated;
grant execute on function public.fn_try_apply_portal_premium_order(bigint) to service_role;
grant execute on function public.fn_auto_apply_bank_transaction(bigint) to service_role;
grant execute on function public.fn_auto_apply_bank_transaction(bigint) to authenticated;

notify pgrst, 'reload schema';
