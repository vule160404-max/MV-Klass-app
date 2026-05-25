-- =============================================================================
-- 067 - Enforce premium/free access on student portal saved activity
-- =============================================================================

drop policy if exists student_exam_activity_insert_own_published on public.student_exam_activity;
create policy student_exam_activity_insert_own_published
on public.student_exam_activity
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.can_access_exam_file(exam_file_id)
);

drop policy if exists student_exam_activity_update_own_published on public.student_exam_activity;
create policy student_exam_activity_update_own_published
on public.student_exam_activity
for update
to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and public.can_access_exam_file(exam_file_id)
);

notify pgrst, 'reload schema';
