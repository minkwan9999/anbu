-- 체험 모드와 실제 사용 구분
-- 폰 두 대 체험: 이 폰을 '체험용 어르신'으로 시작
create function public.hyodo_create_demo_household(p_elder_name text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare h hyodo.households;
begin
  insert into hyodo.households (senior_token, guardian_token, channel, pair_code, elder_name, demo)
  values (hyodo.rand_token(), hyodo.rand_token(), hyodo.rand_token(), hyodo.new_pair_code(),
          coalesce(nullif(trim(left(p_elder_name, 20)), ''), '체험 어르신'), true)
  returning * into h;
  perform hyodo.log(h.id, '체험용 어르신 폰이 시작됐어요');
  return json_build_object('token', h.senior_token, 'role', 'senior');
end $$;

-- 연결 코드가 체험용인지 실제용인지 (QR을 찍은 폰이 어느 모드로 들어갈지 정한다)
create function public.hyodo_code_info(p_code text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare h hyodo.households;
begin
  select * into h from hyodo.households where pair_code = trim(p_code) and pair_expires > now();
  if h.id is null then raise exception 'bad_code' using errcode = 'P0001'; end if;
  return json_build_object('demo', h.demo, 'elder_name', h.elder_name);
end $$;

-- 보호자 연결 (모드 확인): 체험 보호자는 체험 어르신만, 실제 보호자는 실제 어르신만
create function public.hyodo_g_join(p_code text, p_token text, p_name text, p_demo boolean)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare h hyodo.households;
begin
  select * into h from hyodo.households where pair_code = trim(p_code) and pair_expires > now();
  if h.id is null then raise exception 'bad_code' using errcode = 'P0001'; end if;
  if h.demo is distinct from coalesce(p_demo, false) then raise exception 'mode_mismatch' using errcode = 'P0001'; end if;
  return public.hyodo_g_pair(p_code, p_token, p_name);
end $$;
