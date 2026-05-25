-- 072 - Preserve parent-name token "Dung" in bank auto-match.
--
-- The previous cleaner removed both "noi" and "dung" as generic banking words.
-- That broke real parent names such as "Le Dung". Remove the phrase "noi dung"
-- before tokenization, but do not treat "dung" alone as a stopword.

create or replace function public.bank_match_clean_transfer_text(p_content text)
returns text
language sql
immutable
as $$
  with raw as (
    select regexp_replace(public.normalize_lookup_text(p_content), '\mnoi\s+dung\M', ' ', 'g') as n
  ),
  toks as (
    select t
    from raw, regexp_split_to_table(raw.n, '\s+') as t
    where t <> ''
      and t not in (
        'bankapinotify', 'bankapi', 'notify', 'ibft', 'trace', 'gd',
        'giao', 'dich', 'ma', 'ref', 'id', 'noi',
        'chuyen', 'tien', 'ck', 'bank', 'banking',
        'mbbank', 'vietcombank', 'bidv', 'techcombank', 'tpbank',
        'hoc', 'phi', 'hocphi', 'nop', 'dong', 'thanh', 'toan',
        'cho', 'be', 'ban', 'con', 'em', 'hs', 'hocvien', 'hoc', 'sinh',
        'phu', 'huynh', 'ph', 'vnd', 'vn'
      )
      and t !~ '^[0-9]+$'
  )
  select coalesce(string_agg(t, ' '), '') from toks;
$$;

notify pgrst, 'reload schema';
