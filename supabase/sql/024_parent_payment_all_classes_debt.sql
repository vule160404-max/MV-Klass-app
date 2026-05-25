-- =============================================================================
-- 024 — Cổng thanh toán: link theo một lớp vẫn trả về mọi lớp còn nợ (đồng bộ app
-- khi HS chuyển lớp: hiển thị lớp cũ cho đến khi đã đóng đủ buổi nợ).
-- Phụ thuộc 023 (optional phone). Chạy SQL Editor sau 023.
-- =============================================================================

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
  v_phone_display text := '';
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
  v_class_options jsonb := '[]'::jsonb;
  v_unclassified integer := 0;
  v_row record;
  v_pend int;
  v_pres int;
  v_chg int;
  v_fee_line int;
  v_prepaid int;
  v_amt_line int;
  v_total_pending_sessions int := 0;
  v_total_amount int := 0;
begin
  if p_token is null or btrim(p_token) = '' then
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_REQUIRED');
  end if;
  if v_phone_digits = '' and p_student_id is null then
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
      where regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
        and (
          public.normalize_lookup_text(coalesce(s.class_name, 'No class')) =
            public.normalize_lookup_text(v_link.class_name)
          or exists (
            select 1
            from unnest(coalesce(s.class_names, '{}'::text[])) x(cn)
            where public.normalize_lookup_text(trim(coalesce(x.cn, ''))) =
              public.normalize_lookup_text(v_link.class_name)
          )
        );
    end if;
  else
    v_match_count := 1;
  end if;

  if p_student_id is null and v_match_count = 0 then
    return jsonb_build_object('ok', false, 'reason', 'STUDENT_NOT_FOUND');
  end if;
  if p_student_id is null and v_match_count > 1 then
    if v_scope = 'center' then
      select coalesce(jsonb_agg(obj order by ord), '[]'::jsonb)
      into v_candidates
      from (
        select
          jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'class_name', s.class_name,
            'class_names', coalesce(s.class_names, '{}'::text[])
          ) as obj,
          s.name as ord
        from public.students s
        where regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
        order by s.name
      ) t;
    else
      select coalesce(jsonb_agg(obj order by ord), '[]'::jsonb)
      into v_candidates
      from (
        select
          jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'class_name', s.class_name,
            'class_names', coalesce(s.class_names, '{}'::text[])
          ) as obj,
          s.name as ord
        from public.students s
        where regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
          and (
            public.normalize_lookup_text(coalesce(s.class_name, 'No class')) =
              public.normalize_lookup_text(v_link.class_name)
            or exists (
              select 1
              from unnest(coalesce(s.class_names, '{}'::text[])) x(cn)
              where public.normalize_lookup_text(trim(coalesce(x.cn, ''))) =
                public.normalize_lookup_text(v_link.class_name)
            )
          )
        order by s.name
      ) t;
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
      where regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
        and (
          public.normalize_lookup_text(coalesce(s.class_name, 'No class')) =
            public.normalize_lookup_text(v_link.class_name)
          or exists (
            select 1
            from unnest(coalesce(s.class_names, '{}'::text[])) x(cn)
            where public.normalize_lookup_text(trim(coalesce(x.cn, ''))) =
              public.normalize_lookup_text(v_link.class_name)
          )
        )
      limit 1;
    end if;
  else
    if v_scope = 'center' then
      select s.* into v_student
      from public.students s
      where s.id = p_student_id
        and (
          v_phone_digits = ''
          or regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
        )
      limit 1;
    else
      select s.* into v_student
      from public.students s
      where s.id = p_student_id
        and (
          v_phone_digits = ''
          or regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = v_phone_digits
        )
        and (
          public.normalize_lookup_text(coalesce(s.class_name, 'No class')) =
            public.normalize_lookup_text(v_link.class_name)
          or exists (
            select 1
            from unnest(coalesce(s.class_names, '{}'::text[])) x(cn)
            where public.normalize_lookup_text(trim(coalesce(x.cn, ''))) =
              public.normalize_lookup_text(v_link.class_name)
          )
        )
      limit 1;
    end if;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'STUDENT_NOT_FOUND');
    end if;
  end if;

  v_phone_display := coalesce(
    nullif(v_phone_digits, ''),
    regexp_replace(coalesce(v_student.phone, ''), '\D', '', 'g'),
    ''
  );

  select count(*) into v_unclassified
  from public.attendance a
  where a.student_id = v_student.id
    and a.status = 'present'
    and (a.class_name is null or btrim(a.class_name) = '');

  -- Trung tâm và link một lớp: cùng logic gom mọi lớp có fn_pending_sessions_for_class > 0
  -- (học sinh chuyển lớp vẫn thấy nợ lớp cũ; khi đã thu đủ, lớp đó tự hết khỏi danh sách).
  for v_row in
    with cls as (
      select distinct btrim(cn) as class_name
      from (
        select a.class_name as cn
        from public.attendance a
        where a.student_id = v_student.id
          and a.status = 'present'
          and a.class_name is not null
          and btrim(a.class_name) <> ''
        union
        select stc.class_name as cn
        from public.student_tuition_by_class stc
        where stc.student_id = v_student.id
        union
        select unnest(coalesce(v_student.class_names, '{}'::text[])) as cn
      ) u
      where btrim(coalesce(u.cn, '')) <> ''
        and btrim(u.cn) <> 'No class'
    )
    select class_name from cls
    order by class_name
  loop
    v_pend := coalesce(public.fn_pending_sessions_for_class(v_student.id, v_row.class_name), 0);
    if v_pend < 1 then
      continue;
    end if;

    select count(*) into v_pres
    from public.attendance a
    join public.students s2 on s2.id = a.student_id
    where a.student_id = v_student.id
      and a.status = 'present'
      and (
        public.normalize_lookup_text(coalesce(a.class_name, '')) =
          public.normalize_lookup_text(v_row.class_name)
        or (
          a.class_name is null
          and public.normalize_lookup_text(coalesce(s2.class_name, '')) =
            public.normalize_lookup_text(v_row.class_name)
        )
      );

    select coalesce(stc.charged_sessions, 0), coalesce(stc.prepaid_balance_vnd, 0)
    into v_chg, v_prepaid
    from public.student_tuition_by_class stc
    where stc.student_id = v_student.id
      and public.normalize_lookup_text(coalesce(stc.class_name, '')) =
        public.normalize_lookup_text(v_row.class_name)
    limit 1;

    select coalesce(cf.fee_amount, 0) into v_fee_line
    from public.class_fees cf
    where public.normalize_lookup_text(coalesce(cf.class_name, '')) =
      public.normalize_lookup_text(v_row.class_name)
    limit 1;
    if v_fee_line is null then
      v_fee_line := 0;
    end if;

    v_amt_line := greatest(0, v_pend * v_fee_line);
    v_total_pending_sessions := v_total_pending_sessions + v_pend;
    v_total_amount := v_total_amount + v_amt_line;

    v_class_options := v_class_options || jsonb_build_array(
      jsonb_build_object(
        'class_name', v_row.class_name,
        'present_sessions', v_pres,
        'charged_sessions', greatest(0, v_chg),
        'pending_sessions', v_pend,
        'fee_per_session', v_fee_line,
        'amount_vnd', v_amt_line,
        'prepaid_balance_vnd', greatest(0, v_prepaid)
      )
    );
  end loop;

  select coalesce(jsonb_agg(elem order by amt desc, cls), '[]'::jsonb)
  into v_class_options
  from (
    select
      elem,
      coalesce((elem ->> 'class_name'), '') as cls,
      coalesce((elem ->> 'amount_vnd')::int, 0) as amt
    from jsonb_array_elements(v_class_options) elem
  ) z;

  v_present := 0;
  v_charged := 0;
  v_pending := v_total_pending_sessions;
  v_fee := 0;
  v_amount := v_total_amount;

  if coalesce(jsonb_array_length(v_class_options), 0) < 1 or v_total_amount < 1 then
    return jsonb_build_object(
      'ok', true,
      'mode', 'class',
      'link_id', v_link.id,
      'class_name', case when v_scope = 'center' then 'Toàn trung tâm' else v_link.class_name end,
      'unclassified_present_sessions', v_unclassified,
      'class_options', '[]'::jsonb,
      'payment_status', 'no_debt',
      'student', jsonb_build_object(
        'id', v_student.id, 'name', v_student.name, 'class_name', v_student.class_name, 'phone', v_phone_display
      ),
      'pending', jsonb_build_object(
        'present_sessions', 0,
        'charged_sessions', 0,
        'pending_sessions', 0,
        'fee_per_session', 0,
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

  v_transfer_content := coalesce(v_student.name, 'HS')
    || case when v_phone_display <> '' then ' - ' || v_phone_display else '' end;

  return jsonb_build_object(
    'ok', true,
    'mode', 'class',
    'scope', v_scope,
    'link_id', v_link.id,
    'class_name', case when v_scope = 'center' then 'Toàn trung tâm' else v_link.class_name end,
    'ref_code', v_ref,
    'expires_at', v_link.expires_at,
    'unclassified_present_sessions', v_unclassified,
    'class_options', v_class_options,
    'payment_status', coalesce(v_existing.status, 'active'),
    'student', jsonb_build_object(
      'id', v_student.id,
      'name', v_student.name,
      'class_name', v_student.class_name,
      'phone', v_phone_display
    ),
    'pending', jsonb_build_object(
      'present_sessions', v_present,
      'charged_sessions', greatest(0, v_charged),
      'pending_sessions', v_pending,
      'fee_per_session', coalesce(v_fee, 0),
      'amount_vnd', v_amount,
      'transfer_content', v_transfer_content
    )
  );
end $$;

grant execute on function public.resolve_class_parent_payment(text, text, uuid) to anon, authenticated, service_role;
