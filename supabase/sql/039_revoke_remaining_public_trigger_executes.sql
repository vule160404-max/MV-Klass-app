-- 039 - Revoke remaining direct executes for trigger-only helpers.

do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.dashboard_set_updated_at()'
  ] loop
    if to_regprocedure(sig) is not null then
      execute 'revoke execute on function ' || sig || ' from anon';
      execute 'revoke execute on function ' || sig || ' from authenticated';
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
