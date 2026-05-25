-- =============================================================================
-- 052 - Vietnamese display titles for ASCII-safe Storage filenames
-- Supabase Storage may reject Vietnamese accents in object names. Keep filenames
-- ASCII-safe, but display polished Vietnamese labels in the student portal.
-- =============================================================================

create or replace function public.exam_file_display_province(p_province text)
returns text
language plpgsql
immutable
as $$
declare
  s text;
  k text;
begin
  s := btrim(coalesce(p_province, ''));
  k := lower(regexp_replace(s, '\s+', ' ', 'g'));

  case k
    when '' then return null;
    when 'ha noi' then return 'Hà Nội';
    when 'tp hcm' then return 'TP HCM';
    when 'ho chi minh' then return 'TP HCM';
    when 'thanh hoa' then return 'Thanh Hóa';
    when 'nghe an' then return 'Nghệ An';
    when 'ha tinh' then return 'Hà Tĩnh';
    when 'da nang' then return 'Đà Nẵng';
    when 'hai phong' then return 'Hải Phòng';
    when 'quang ninh' then return 'Quảng Ninh';
    when 'bac ninh' then return 'Bắc Ninh';
    when 'bac giang' then return 'Bắc Giang';
    when 'nam dinh' then return 'Nam Định';
    when 'thai binh' then return 'Thái Bình';
    when 'ninh binh' then return 'Ninh Bình';
    when 'hai duong' then return 'Hải Dương';
    when 'hung yen' then return 'Hưng Yên';
    when 'vinh phuc' then return 'Vĩnh Phúc';
    when 'phu tho' then return 'Phú Thọ';
    when 'thai nguyen' then return 'Thái Nguyên';
    when 'tuyen quang' then return 'Tuyên Quang';
    when 'lao cai' then return 'Lào Cai';
    when 'yen bai' then return 'Yên Bái';
    when 'son la' then return 'Sơn La';
    when 'hoa binh' then return 'Hòa Bình';
    when 'quang binh' then return 'Quảng Bình';
    when 'quang tri' then return 'Quảng Trị';
    when 'thua thien hue' then return 'Thừa Thiên Huế';
    when 'quang nam' then return 'Quảng Nam';
    when 'quang ngai' then return 'Quảng Ngãi';
    when 'binh dinh' then return 'Bình Định';
    when 'phu yen' then return 'Phú Yên';
    when 'khanh hoa' then return 'Khánh Hòa';
    when 'ninh thuan' then return 'Ninh Thuận';
    when 'binh thuan' then return 'Bình Thuận';
    when 'kon tum' then return 'Kon Tum';
    when 'gia lai' then return 'Gia Lai';
    when 'dak lak' then return 'Đắk Lắk';
    when 'dak nong' then return 'Đắk Nông';
    when 'lam dong' then return 'Lâm Đồng';
    when 'binh phuoc' then return 'Bình Phước';
    when 'binh duong' then return 'Bình Dương';
    when 'dong nai' then return 'Đồng Nai';
    when 'ba ria vung tau' then return 'Bà Rịa - Vũng Tàu';
    when 'tay ninh' then return 'Tây Ninh';
    when 'long an' then return 'Long An';
    when 'tien giang' then return 'Tiền Giang';
    when 'ben tre' then return 'Bến Tre';
    when 'tra vinh' then return 'Trà Vinh';
    when 'vinh long' then return 'Vĩnh Long';
    when 'dong thap' then return 'Đồng Tháp';
    when 'an giang' then return 'An Giang';
    when 'kien giang' then return 'Kiên Giang';
    when 'can tho' then return 'Cần Thơ';
    when 'hau giang' then return 'Hậu Giang';
    when 'soc trang' then return 'Sóc Trăng';
    when 'bac lieu' then return 'Bạc Liêu';
    when 'ca mau' then return 'Cà Mau';
    else return initcap(s);
  end case;
end;
$$;

create or replace function public.exam_file_pretty_title(p_path text)
returns text
language plpgsql
immutable
as $$
declare
  code text;
  level text;
  province text;
  y integer;
begin
  code := public.exam_file_guess_code(p_path);
  level := public.exam_file_guess_level(p_path);
  province := public.exam_file_display_province(public.exam_file_guess_province(p_path));
  y := public.exam_file_guess_year(p_path);

  if code is not null then
    return 'Đề ' || code || ' ' ||
      case when level = 'university' then 'THPT' else 'Vào 10' end ||
      coalesce(' ' || province, '') ||
      coalesce(' ' || y::text, '');
  end if;

  return initcap(public.exam_file_core_name(p_path));
end;
$$;

update public.exam_files
set title = public.exam_file_pretty_title(storage_path),
    province = public.exam_file_display_province(public.exam_file_guess_province(storage_path))
where storage_path is not null
  and coalesce(public.exam_file_is_placeholder(storage_path), false) = false;

notify pgrst, 'reload schema';
