-- 087 - Explicit student portal presence status
-- Allows the portal to mark a student offline immediately on page close instead
-- of waiting for the last_seen_at timeout window.

alter table public.profiles
  add column if not exists portal_presence_status text not null default 'offline';

alter table public.profiles
  drop constraint if exists profiles_portal_presence_status_chk;

alter table public.profiles
  add constraint profiles_portal_presence_status_chk
  check (portal_presence_status in ('online', 'offline'));

create index if not exists profiles_role_presence_idx
  on public.profiles(role, portal_presence_status, last_seen_at desc);

notify pgrst, 'reload schema';

