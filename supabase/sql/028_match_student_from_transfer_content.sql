-- =============================================================================
-- 028 — Khớp học sinh từ nội dung CK (bank / đối soát tự động), bản siết điểm
--
-- Ghi đè định nghĩa trong 009. Trước đây gộp trong 027 (đã tách; fn_apply prepaid nằm 031).
-- Chạy sau 009. Không phụ thuộc 031.
-- =============================================================================

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
          when length(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')) >= 9
            and position(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') in v.content_digits) > 0
          then 100 else 0
        end
        +
        case
          when public.normalize_lookup_text(s.name) <> ''
            and length(replace(public.normalize_lookup_text(s.name), ' ', '')) >= 8
            and position(public.normalize_lookup_text(s.name) in v.content_norm) > 0
          then 65 else 0
        end
        +
        case
          when replace(public.normalize_lookup_text(s.name), ' ', '') <> ''
            and length(replace(public.normalize_lookup_text(s.name), ' ', '')) >= 8
            and position(replace(public.normalize_lookup_text(s.name), ' ', '') in v.content_compact) > 0
          then 55 else 0
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
      and score >= 65
  ),
  near_best as (
    select s.*
    from scored s
    cross join top_score_cte t
    where t.top_score >= 65
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
