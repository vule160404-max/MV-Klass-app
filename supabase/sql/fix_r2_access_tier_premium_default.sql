-- Fix R2 exams that were auto-marked as free by the old sync default.
-- Keep an exam free only when it is explicitly curated as free or its object key says "free".
update public.exam_files
set access_tier = 'premium'
where storage_provider = 'r2'
  and coalesce(access_tier, '') = 'free'
  and coalesce(category, '') <> 'topic'
  and coalesce(group_free_rank, free_rank, 0) <= 0
  and lower(coalesce(object_key, '')) not like '%free%';
