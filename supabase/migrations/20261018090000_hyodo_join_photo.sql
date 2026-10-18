-- 보호자 등록 때 얼굴 사진도 받아 어르신 연락처에 함께 넣는다
alter table hyodo.guardians add column photo text;

create function hyodo.add_guardian_contact(p_hid uuid, p_name text, p_rel text, p_phone text, p_photo text)
returns text language plpgsql volatile set search_path = '' as $$
declare digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'); res text;
begin
  res := hyodo.add_guardian_contact(p_hid, p_name, p_rel, p_phone);
  if p_photo is not null and res in ('added', 'exists') then
    update hyodo.contacts c set photo = p_photo
     where c.household_id = p_hid and c.name <> '' and regexp_replace(c.phone, '[^0-9]', '', 'g') = digits
       and (res = 'added' or c.photo is null);
  end if;
  return res;
end $$;
revoke all on function hyodo.add_guardian_contact(uuid, text, text, text, text) from public, anon, authenticated;

create function public.hyodo_g_join(p_code text, p_token text, p_name text, p_demo boolean, p_rel text, p_phone text, p_photo text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare r json; g hyodo.guardians; res text;
begin
  if p_photo is not null and (p_photo not like 'data:image/%' or length(p_photo) > 300000) then
    raise exception 'bad_photo' using errcode = 'P0001';
  end if;
  r := public.hyodo_g_join(p_code, p_token, p_name, p_demo);
  select * into g from hyodo.guardians where token = r->>'token';
  if coalesce(p_phone, '') <> '' then
    update hyodo.guardians set phone = left(trim(p_phone), 20), rel = left(coalesce(p_rel, ''), 10) where id = g.id returning * into g;
  end if;
  if p_photo is not null then
    update hyodo.guardians set photo = p_photo where id = g.id returning * into g;
  end if;
  res := hyodo.add_guardian_contact((r->>'hid')::uuid, g.name, g.rel, g.phone, g.photo);
  return (r::jsonb || jsonb_build_object('contact', res))::json;
end $$;
