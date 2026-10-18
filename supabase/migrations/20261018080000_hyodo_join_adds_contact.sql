-- 보호자 연결 때 전화번호를 받아 어르신 연락처(3칸)에 자동으로 넣는다
alter table hyodo.guardians add column phone text not null default '';
alter table hyodo.guardians add column rel text not null default '';   -- 어르신 화면 연락처용 호칭 (딸·아들·선생님…)

-- 보호자를 어르신 연락처 빈 칸에 넣는다. 같은 번호가 있으면 넣지 않는다. 결과: added / exists / full / no_phone
create function hyodo.add_guardian_contact(p_hid uuid, p_name text, p_rel text, p_phone text)
returns text language plpgsql volatile set search_path = '' as $$
declare digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'); free int;
begin
  if length(digits) < 8 then return 'no_phone'; end if;
  if exists (select 1 from hyodo.contacts c where c.household_id = p_hid and c.name <> ''
               and regexp_replace(c.phone, '[^0-9]', '', 'g') = digits) then return 'exists'; end if;
  select s into free from generate_series(0, 2) s
   where not exists (select 1 from hyodo.contacts c where c.household_id = p_hid and c.slot = s and c.name <> '')
   order by s limit 1;
  if free is null then return 'full'; end if;
  insert into hyodo.contacts (household_id, slot, name, rel, phone, photo)
  values (p_hid, free, left(p_name, 12), left(coalesce(p_rel, ''), 10), left(p_phone, 20), null)
  on conflict (household_id, slot) do update set name = excluded.name, rel = excluded.rel, phone = excluded.phone, photo = null;
  perform hyodo.log(p_hid, left(p_name, 12) || ' 님이 어르신 연락처에 들어갔어요');
  return 'added';
end $$;
revoke all on function hyodo.add_guardian_contact(uuid, text, text, text) from public, anon, authenticated;

-- 보호자 연결 + 연락처 자동 추가. p_rel·p_phone 이 비어 있으면 보호자 계정에 기억된 값을 쓴다 (어르신 추가 때)
create function public.hyodo_g_join(p_code text, p_token text, p_name text, p_demo boolean, p_rel text, p_phone text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare r json; g hyodo.guardians; res text;
begin
  r := public.hyodo_g_join(p_code, p_token, p_name, p_demo);
  select * into g from hyodo.guardians where token = r->>'token';
  if coalesce(p_phone, '') <> '' then
    update hyodo.guardians set phone = left(trim(p_phone), 20), rel = left(coalesce(p_rel, ''), 10) where id = g.id
    returning * into g;
  end if;
  res := hyodo.add_guardian_contact((r->>'hid')::uuid, g.name, g.rel, g.phone);
  return (r::jsonb || jsonb_build_object('contact', res))::json;
end $$;
