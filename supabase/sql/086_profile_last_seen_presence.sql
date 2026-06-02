-- 086 - Student portal presence heartbeat
-- Tracks the latest time a portal account touched the app so admin presence
-- indicators can reflect login/session activity, not only file opens/downloads.

alter table public.profiles
  add column if not exists last_seen_at timestamptz;

create index if not exists profiles_role_last_seen_idx
  on public.profiles(role, last_seen_at desc);

notify pgrst, 'reload schema';
