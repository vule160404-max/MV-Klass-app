-- =============================================================================
-- 080 - Fix Portal Premium ref code generation on Supabase
-- =============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

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
    v_ref := 'PM' || upper(encode(extensions.gen_random_bytes(5), 'hex'));
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
