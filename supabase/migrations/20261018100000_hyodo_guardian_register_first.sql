-- 보호자 먼저 등록(어르신 연결 없이): 사진·관계·이름·전화번호만 받아 보호자 계정을 만든다.
-- 어르신은 나중에 '어르신 추가'(연결 코드)로 붙이고, 그때 이 정보가 어르신 연락처에 들어간다.
create function public.hyodo_g_register(p_name text, p_rel text, p_phone text, p_photo text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare gtok text := hyodo.rand_token();
begin
  if p_photo is not null and (p_photo not like 'data:image/%' or length(p_photo) > 300000) then
    raise exception 'bad_photo' using errcode = 'P0001';
  end if;
  insert into hyodo.guardians (token, name, rel, phone, photo)
  values (gtok, coalesce(nullif(trim(left(p_name, 20)), ''), '보호자'), left(coalesce(p_rel, ''), 10),
          left(trim(coalesce(p_phone, '')), 20), p_photo);
  return json_build_object('token', gtok);
end $$;

-- 화면 상태(state_json)에 'guardian_count'(연결된 보호자 수) 추가:
--   'guardian_count', (select count(*) from hyodo.guardian_links l where l.household_id = h.id and l.active),
-- 아무와도 연결 안 된 어르신 폰은 연결 코드 화면부터 보여 준다. (나머지 본문은 20261018070000 의 state_json 과 같다)
