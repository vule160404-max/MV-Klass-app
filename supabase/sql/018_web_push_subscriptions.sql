-- =============================================================================
-- 018 -- Web Push subscriptions (iOS Safari/PWA compatible)
-- =============================================================================

create table if not exists public.user_web_push_subscriptions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  content_encoding text,
  device_platform text,
  device_user_agent text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, endpoint)
);

create index if not exists idx_user_web_push_subscriptions_user_active
  on public.user_web_push_subscriptions(user_id, is_active);

alter table public.user_web_push_subscriptions enable row level security;

create or replace function public.tg_user_web_push_subscriptions_updated_at()
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

drop trigger if exists trg_user_web_push_subscriptions_updated_at on public.user_web_push_subscriptions;
create trigger trg_user_web_push_subscriptions_updated_at
before update on public.user_web_push_subscriptions
for each row execute procedure public.tg_user_web_push_subscriptions_updated_at();

drop policy if exists user_web_push_subscriptions_select_own on public.user_web_push_subscriptions;
create policy user_web_push_subscriptions_select_own
  on public.user_web_push_subscriptions for select to authenticated
  using (user_id = auth.uid());

drop policy if exists user_web_push_subscriptions_insert_own on public.user_web_push_subscriptions;
create policy user_web_push_subscriptions_insert_own
  on public.user_web_push_subscriptions for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists user_web_push_subscriptions_update_own on public.user_web_push_subscriptions;
create policy user_web_push_subscriptions_update_own
  on public.user_web_push_subscriptions for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists user_web_push_subscriptions_delete_own on public.user_web_push_subscriptions;
create policy user_web_push_subscriptions_delete_own
  on public.user_web_push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on table public.user_web_push_subscriptions to authenticated;
grant select, insert, update, delete on table public.user_web_push_subscriptions to service_role;

notify pgrst, 'reload schema';
