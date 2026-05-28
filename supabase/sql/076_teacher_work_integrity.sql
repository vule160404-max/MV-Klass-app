-- Additive teacher work integrity layer.
-- This migration creates RPC guards only; it does not update, delete, or rewrite existing rows.

create or replace function public.mvk_current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p.role::text
    from public.profiles p
    where p.id = auth.uid()
    limit 1
  ), '');
$$;

create or replace function public.mvk_teacher_effective_classes(
  p_teacher_id uuid,
  p_date date
)
returns table(class_name text)
language sql
stable
security definer
set search_path = public
as $$
  with base_classes as (
    select btrim(tc.class_name::text) as class_name
    from public.teacher_classes tc
    where tc.teacher_id = p_teacher_id
      and nullif(btrim(tc.class_name::text), '') is not null
  ),
  inbound_substitutions as (
    select btrim(ts.class_name::text) as class_name
    from public.teacher_substitutions ts
    where ts.to_teacher_id = p_teacher_id
      and ts.date::date = p_date
      and nullif(btrim(ts.class_name::text), '') is not null
  ),
  outbound_substitutions as (
    select btrim(ts.class_name::text) as class_name
    from public.teacher_substitutions ts
    where ts.from_teacher_id = p_teacher_id
      and ts.date::date = p_date
      and nullif(btrim(ts.class_name::text), '') is not null
  ),
  candidates as (
    select class_name from base_classes
    union
    select class_name from inbound_substitutions
  )
  select distinct c.class_name
  from candidates c
  where not exists (
    select 1
    from outbound_substitutions o
    where o.class_name = c.class_name
  )
  order by c.class_name;
$$;

create or replace function public.teacher_submit_check_in(p_class_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.mvk_current_user_role();
  v_class_name text := btrim(coalesce(p_class_name, ''));
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_existing public.teacher_check_ins%rowtype;
  v_row public.teacher_check_ins%rowtype;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  if v_role <> 'teacher' then
    raise exception 'teacher_required' using errcode = 'P0001';
  end if;

  if v_class_name = '' then
    raise exception 'class_required' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.mvk_teacher_effective_classes(v_uid, v_today) c
    where c.class_name = v_class_name
  ) then
    raise exception 'class_not_assigned' using errcode = 'P0001';
  end if;

  select *
  into v_existing
  from public.teacher_check_ins t
  where t.teacher_id = v_uid
    and btrim(coalesce(t.class_name::text, '')) = v_class_name
    and coalesce(t.status::text, 'pending') in ('pending', 'on_time', 'late')
    and timezone('Asia/Ho_Chi_Minh', t.checked_in_at)::date = v_today
  order by t.checked_in_at desc
  limit 1;

  if found then
    raise exception 'duplicate_teacher_check_in' using errcode = 'P0001';
  end if;

  insert into public.teacher_check_ins (
    teacher_id,
    status,
    class_name,
    auto_absent,
    checked_in_at
  )
  values (
    v_uid,
    'pending',
    v_class_name,
    false,
    now()
  )
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.admin_review_teacher_check_in(
  p_check_in_id bigint,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.mvk_current_user_role();
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_row public.teacher_check_ins%rowtype;
  v_count integer := 0;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  if v_role <> 'admin' then
    raise exception 'admin_required' using errcode = 'P0001';
  end if;

  if v_status not in ('on_time', 'late', 'absent') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;

  execute
    'update public.teacher_check_ins t
     set status = ' || quote_literal(v_status) || ',
         reviewed_at = now(),
         reviewed_by = $1
     where t.id = $2
       and coalesce(t.status::text, ''pending'') = ''pending''
     returning *'
  into v_row
  using v_uid, p_check_in_id;
  get diagnostics v_count = row_count;

  if v_count = 0 then
    if exists (select 1 from public.teacher_check_ins t where t.id = p_check_in_id) then
      raise exception 'teacher_check_in_stale' using errcode = 'P0001';
    end if;
    raise exception 'teacher_check_in_not_found' using errcode = 'P0001';
  end if;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.admin_delete_teacher_check_in(p_check_in_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.mvk_current_user_role();
  v_row public.teacher_check_ins%rowtype;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  if v_role <> 'admin' then
    raise exception 'admin_required' using errcode = 'P0001';
  end if;

  delete from public.teacher_check_ins t
  where t.id = p_check_in_id
  returning * into v_row;

  if not found then
    raise exception 'teacher_check_in_not_found' using errcode = 'P0001';
  end if;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.admin_create_teacher_substitution(
  p_date date,
  p_class_name text,
  p_from_teacher_id uuid,
  p_to_teacher_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.mvk_current_user_role();
  v_class_name text := btrim(coalesce(p_class_name, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_row public.teacher_substitutions%rowtype;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  if v_role <> 'admin' then
    raise exception 'admin_required' using errcode = 'P0001';
  end if;

  if p_date is null or v_class_name = '' or p_from_teacher_id is null or p_to_teacher_id is null then
    raise exception 'missing_substitution_fields' using errcode = 'P0001';
  end if;

  if p_from_teacher_id = p_to_teacher_id then
    raise exception 'same_teacher' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = p_from_teacher_id
      and p.role = 'teacher'
  ) then
    raise exception 'from_teacher_not_teacher' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = p_to_teacher_id
      and p.role = 'teacher'
  ) then
    raise exception 'to_teacher_not_teacher' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.teacher_classes tc
    where tc.teacher_id = p_from_teacher_id
      and btrim(coalesce(tc.class_name::text, '')) = v_class_name
  ) then
    raise exception 'from_teacher_not_assigned' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.teacher_substitutions ts
    where ts.date::date = p_date
      and btrim(coalesce(ts.class_name::text, '')) = v_class_name
  ) then
    raise exception 'duplicate_teacher_substitution' using errcode = 'P0001';
  end if;

  insert into public.teacher_substitutions (
    date,
    class_name,
    from_teacher_id,
    to_teacher_id,
    note
  )
  values (
    p_date,
    v_class_name,
    p_from_teacher_id,
    p_to_teacher_id,
    v_note
  )
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.admin_delete_teacher_substitution(p_substitution_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.mvk_current_user_role();
  v_row public.teacher_substitutions%rowtype;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  if v_role <> 'admin' then
    raise exception 'admin_required' using errcode = 'P0001';
  end if;

  delete from public.teacher_substitutions t
  where t.id = p_substitution_id
  returning * into v_row;

  if not found then
    raise exception 'teacher_substitution_not_found' using errcode = 'P0001';
  end if;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.mvk_current_user_role() from public;
revoke all on function public.mvk_teacher_effective_classes(uuid, date) from public;
revoke all on function public.teacher_submit_check_in(text) from public;
revoke all on function public.admin_review_teacher_check_in(bigint, text) from public;
revoke all on function public.admin_delete_teacher_check_in(bigint) from public;
revoke all on function public.admin_create_teacher_substitution(date, text, uuid, uuid, text) from public;
revoke all on function public.admin_delete_teacher_substitution(bigint) from public;

grant execute on function public.teacher_submit_check_in(text) to authenticated;
grant execute on function public.admin_review_teacher_check_in(bigint, text) to authenticated;
grant execute on function public.admin_delete_teacher_check_in(bigint) to authenticated;
grant execute on function public.admin_create_teacher_substitution(date, text, uuid, uuid, text) to authenticated;
grant execute on function public.admin_delete_teacher_substitution(bigint) to authenticated;

comment on function public.teacher_submit_check_in(text)
  is 'Teacher check-in with server time, effective class assignment, and duplicate guard. Additive: does not mutate existing rows except inserting the requested check-in.';

comment on function public.admin_review_teacher_check_in(bigint, text)
  is 'Admin-only stale-safe review: pending rows only, so concurrent review/delete is surfaced instead of overwritten.';

comment on function public.admin_create_teacher_substitution(date, text, uuid, uuid, text)
  is 'Admin-only substitution creation with direct-assignment and same date/class duplicate guards. Schedule overlap remains validated by the web app because schedule definitions live there.';
