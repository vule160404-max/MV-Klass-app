-- =============================================================================
-- 066 - Tighten bank auto-match scoring
-- Avoid medium matches from common Vietnamese tokens only (le/thi/van/nguyen),
-- while promoting strong parent/student partial names with distinctive tokens.
-- =============================================================================

create or replace function public.match_students_from_transfer_content(p_content text)
returns table(
  student_id uuid,
  student_name text,
  parent_name text,
  class_name text,
  phone text,
  score integer,
  confidence text,
  match_method text,
  matched_text text,
  matched_tokens text[]
)
language sql
stable
as $$
  with vars as (
    select
      public.normalize_lookup_text(p_content) as content_norm,
      public.bank_match_clean_transfer_text(p_content) as clean_norm,
      replace(public.normalize_lookup_text(p_content), ' ', '') as content_compact,
      replace(public.bank_match_clean_transfer_text(p_content), ' ', '') as clean_compact,
      regexp_replace(coalesce(p_content, ''), '\D', '', 'g') as content_digits
  ),
  prepared as (
    select
      s.id,
      s.name,
      s.parent_name,
      s.class_name,
      s.phone,
      public.normalize_lookup_text(s.name) as name_norm,
      public.normalize_lookup_text(s.parent_name) as parent_norm,
      replace(public.normalize_lookup_text(s.name), ' ', '') as name_compact,
      replace(public.normalize_lookup_text(s.parent_name), ' ', '') as parent_compact,
      regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') as phone_digits
    from public.students s
    where coalesce(p_content, '') <> ''
  ),
  tokenized as (
    select
      p.*,
      coalesce(array(
        select distinct t
        from regexp_split_to_table(p.name_norm, '\s+') t
        where length(t) >= 2
          and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
        order by t
      ), '{}'::text[]) as name_hits,
      coalesce(array(
        select distinct t
        from regexp_split_to_table(p.parent_norm, '\s+') t
        where length(t) >= 2
          and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
        order by t
      ), '{}'::text[]) as parent_hits,
      coalesce(array(
        select distinct t
        from regexp_split_to_table(p.name_norm, '\s+') t
        where length(t) >= 3
          and t not in ('le', 'thi', 'van', 'nguyen')
        order by t
      ), '{}'::text[]) as name_meaningful,
      coalesce(array(
        select distinct t
        from regexp_split_to_table(p.parent_norm, '\s+') t
        where length(t) >= 3
          and t not in ('le', 'thi', 'van', 'nguyen')
        order by t
      ), '{}'::text[]) as parent_meaningful,
      coalesce(array(
        select distinct t
        from regexp_split_to_table(p.name_norm, '\s+') t
        where length(t) >= 3
          and t not in ('le', 'thi', 'van', 'nguyen')
          and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
        order by t
      ), '{}'::text[]) as name_meaningful_hits,
      coalesce(array(
        select distinct t
        from regexp_split_to_table(p.parent_norm, '\s+') t
        where length(t) >= 3
          and t not in ('le', 'thi', 'van', 'nguyen')
          and position(' ' || t || ' ' in ' ' || v.clean_norm || ' ') > 0
        order by t
      ), '{}'::text[]) as parent_meaningful_hits,
      case
        when length(p.phone_digits) >= 9
          and position(p.phone_digits in v.content_digits) > 0
        then 150 else 0
      end as phone_score,
      case
        when length(p.name_compact) >= 8
          and (
            position(' ' || p.name_norm || ' ' in ' ' || v.clean_norm || ' ') > 0
            or position(p.name_compact in v.clean_compact) > 0
          )
        then 125 else 0
      end as student_full_score,
      case
        when length(p.parent_compact) >= 6
          and (
            position(' ' || p.parent_norm || ' ' in ' ' || v.clean_norm || ' ') > 0
            or position(p.parent_compact in v.clean_compact) > 0
          )
        then 120 else 0
      end as parent_full_score
    from prepared p
    cross join vars v
  ),
  scored as (
    select
      t.*,
      coalesce(array_length(t.name_meaningful, 1), 0) as name_meaningful_count,
      coalesce(array_length(t.parent_meaningful, 1), 0) as parent_meaningful_count,
      coalesce(array_length(t.name_meaningful_hits, 1), 0) as name_meaningful_hit_count,
      coalesce(array_length(t.parent_meaningful_hits, 1), 0) as parent_meaningful_hit_count,
      case
        when coalesce(array_length(t.name_meaningful, 1), 0) >= 2
          and coalesce(array_length(t.name_meaningful_hits, 1), 0) = coalesce(array_length(t.name_meaningful, 1), 0)
        then 112
        when coalesce(array_length(t.name_meaningful_hits, 1), 0) >= 2
          and coalesce(array_length(t.name_meaningful_hits, 1), 0)::numeric / greatest(coalesce(array_length(t.name_meaningful, 1), 0), 1) >= 0.67
        then 92
        when coalesce(array_length(t.name_meaningful_hits, 1), 0) >= 2
        then 72
        when coalesce(array_length(t.name_meaningful_hits, 1), 0) = 1
        then 24
        else 0
      end as student_token_score,
      case
        when coalesce(array_length(t.parent_meaningful, 1), 0) >= 2
          and coalesce(array_length(t.parent_meaningful_hits, 1), 0) = coalesce(array_length(t.parent_meaningful, 1), 0)
        then 112
        when coalesce(array_length(t.parent_meaningful_hits, 1), 0) >= 2
          and coalesce(array_length(t.parent_meaningful_hits, 1), 0)::numeric / greatest(coalesce(array_length(t.parent_meaningful, 1), 0), 1) >= 0.67
        then 92
        else 0
      end as parent_token_score
    from tokenized t
  ),
  ranked as (
    select
      s.*,
      greatest(
        s.phone_score,
        s.student_full_score,
        s.parent_full_score,
        s.student_token_score,
        s.parent_token_score
      )::integer as best_score
    from scored s
  )
  select
    r.id,
    r.name,
    r.parent_name,
    r.class_name,
    r.phone,
    r.best_score,
    case
      when r.best_score >= 110 then 'high'
      when r.best_score >= 80 then 'medium'
      else 'low'
    end,
    case
      when r.phone_score = r.best_score and r.phone_score > 0 then 'phone'
      when r.student_full_score = r.best_score and r.student_full_score > 0 then 'student_name'
      when r.parent_full_score = r.best_score and r.parent_full_score > 0 then 'parent_name'
      when r.parent_token_score = r.best_score and r.parent_token_score > 0 then 'parent_name'
      when r.student_token_score = r.best_score and r.student_token_score > 0 then 'student_name'
      else 'mixed'
    end,
    case
      when r.phone_score = r.best_score and r.phone_score > 0 then r.phone_digits
      when r.parent_full_score = r.best_score and r.parent_full_score > 0 then r.parent_norm
      when r.student_full_score = r.best_score and r.student_full_score > 0 then r.name_norm
      when r.parent_token_score = r.best_score and r.parent_token_score > 0 then array_to_string(r.parent_meaningful_hits, ' ')
      when r.student_token_score = r.best_score and r.student_token_score > 0 then array_to_string(r.name_meaningful_hits, ' ')
      else array_to_string(array_cat(coalesce(r.name_hits, '{}'::text[]), coalesce(r.parent_hits, '{}'::text[])), ' ')
    end,
    case
      when r.parent_token_score = r.best_score and r.parent_token_score > 0 then r.parent_meaningful_hits
      when r.student_token_score = r.best_score and r.student_token_score > 0 then r.name_meaningful_hits
      else array_cat(coalesce(r.name_hits, '{}'::text[]), coalesce(r.parent_hits, '{}'::text[]))
    end
  from ranked r
  where r.best_score > 0
  order by r.best_score desc, r.name;
$$;

notify pgrst, 'reload schema';
