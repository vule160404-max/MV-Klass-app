-- =============================================================================
-- 017 -- Multi-device FCM tokens per user
-- =============================================================================

create table if not exists public.user_fcm_tokens (
  user_id uuid not null references public.profiles(id) on delete cascade,
  fcm_token text not null,
  device_platform text,
  device_user_agent text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, fcm_token)
);

create index if not exists idx_user_fcm_tokens_user_active
  on public.user_fcm_tokens(user_id, is_active);

create unique index if not exists idx_user_fcm_tokens_token_unique
  on public.user_fcm_tokens(fcm_token);

create or replace function public.tg_user_fcm_tokens_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.last_seen_at is null then
    new.last_seen_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_user_fcm_tokens_updated_at on public.user_fcm_tokens;
create trigger trg_user_fcm_tokens_updated_at
before update on public.user_fcm_tokens
for each row execute procedure public.tg_user_fcm_tokens_updated_at();

alter table public.user_fcm_tokens enable row level security;

drop policy if exists user_fcm_tokens_select_own on public.user_fcm_tokens;
create policy user_fcm_tokens_select_own
  on public.user_fcm_tokens for select to authenticated
  using (user_id = auth.uid());

drop policy if exists user_fcm_tokens_insert_own on public.user_fcm_tokens;
create policy user_fcm_tokens_insert_own
  on public.user_fcm_tokens for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists user_fcm_tokens_update_own on public.user_fcm_tokens;
create policy user_fcm_tokens_update_own
  on public.user_fcm_tokens for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists user_fcm_tokens_delete_own on public.user_fcm_tokens;
create policy user_fcm_tokens_delete_own
  on public.user_fcm_tokens for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on table public.user_fcm_tokens to authenticated;
grant select, insert, update, delete on table public.user_fcm_tokens to service_role;

notify pgrst, 'reload schema';
