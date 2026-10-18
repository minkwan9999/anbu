-- 시작 보호자: 어르신(가구)에 처음 연결한 보호자. 나중에 결제할 사람으로 본다.
-- 데이터 초기화: 시작 보호자만. 지우지 않고 숨기는 방식(약 비활성, 연락처 비움, reset_at 이전 사진·활동 숨김)이라
-- 서버에는 기록이 남아 테스트 분석에 쓸 수 있다. 어르신·보호자 연결은 그대로 둔다.
alter table hyodo.households add column owner_guardian_id uuid references hyodo.guardians on delete set null;
alter table hyodo.households add column reset_at timestamptz;

update hyodo.households h
   set owner_guardian_id = (select l.guardian_id from hyodo.guardian_links l
                             where l.household_id = h.id and l.active order by l.created_at limit 1);

-- 보호자 연결: 시작 보호자가 없으면 이 보호자가 시작 보호자
create or replace function public.hyodo_g_pair(p_code text, p_token text, p_name text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare h hyodo.households; gid uuid; gname text; gtok text;
begin
  select * into h from hyodo.households where pair_code = trim(p_code) and pair_expires > now();
  if h.id is null then raise exception 'bad_code' using errcode = 'P0001'; end if;
  if coalesce(p_token, '') = '' then
    gtok := hyodo.rand_token();
    insert into hyodo.guardians (token, name) values (gtok, coalesce(nullif(trim(left(p_name, 20)), ''), '보호자'))
    returning id, name into gid, gname;
  else
    select * into gid, gname from hyodo.gauth(p_token, null);
    gtok := p_token;
  end if;
  insert into hyodo.guardian_links (guardian_id, household_id) values (gid, h.id)
  on conflict (guardian_id, household_id) do update set active = true;
  update hyodo.households set owner_guardian_id = gid where id = h.id and owner_guardian_id is null;
  perform hyodo.log(h.id, gname || ' 님이 보호자로 연결됐어요');
  return json_build_object('token', gtok, 'hid', h.id);
end $$;

create or replace function public.hyodo_g_create_demo(p_token text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare h hyodo.households; gid uuid; gname text; gtok text; is_new boolean := false;
begin
  insert into hyodo.households (senior_token, guardian_token, channel, pair_code, elder_name, demo)
  values (hyodo.rand_token(), hyodo.rand_token(), hyodo.rand_token(), hyodo.new_pair_code(), '체험 어르신', true)
  returning * into h;
  update hyodo.households set pair_expires = now() where id = h.id;
  if coalesce(p_token, '') = '' then
    gtok := hyodo.rand_token(); is_new := true;
    insert into hyodo.guardians (token, name) values (gtok, '체험 보호자') returning id, name into gid, gname;
  else
    select * into gid, gname from hyodo.gauth(p_token, null);
    gtok := p_token;
  end if;
  insert into hyodo.guardian_links (guardian_id, household_id) values (gid, h.id);
  update hyodo.households set owner_guardian_id = gid where id = h.id;
  perform hyodo.log(h.id, '체험을 시작했어요');
  return json_build_object('senior', h.senior_token, 'guardian', gtok, 'hid', h.id, 'new_guardian', is_new);
end $$;

-- 보호자 화면 상태: 시작 보호자 이름, 내가 시작 보호자인지
create or replace function public.hyodo_g_state(p_token text, p_hid uuid)
returns json language plpgsql stable security definer set search_path = '' as $$
declare a record; oid uuid; oname text;
begin
  select * into a from hyodo.gauth(p_token, p_hid);
  select h.owner_guardian_id, g.name into oid, oname
    from hyodo.households h left join hyodo.guardians g on g.id = h.owner_guardian_id where h.id = p_hid;
  return (hyodo.state_json(p_hid, false)::jsonb
          || jsonb_build_object('is_owner', coalesce(oid = a.gid, false), 'owner_name', oname))::json;
end $$;

-- 연결 끊기: 시작 보호자가 끊으면 다음으로 먼저 연결된 보호자가 시작 보호자가 된다
create or replace function public.hyodo_g_unlink(p_token text, p_hid uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.gauth(p_token, p_hid);
  update hyodo.guardian_links set active = false where guardian_id = a.gid and household_id = p_hid;
  update hyodo.households h
     set owner_guardian_id = (select l.guardian_id from hyodo.guardian_links l
                               where l.household_id = h.id and l.active order by l.created_at limit 1)
   where h.id = p_hid and h.owner_guardian_id = a.gid;
  perform hyodo.log(p_hid, a.gname || ' 님이 연결을 끊었어요');
end $$;

-- 데이터 초기화 (시작 보호자만)
create function public.hyodo_g_reset(p_token text, p_hid uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.gauth(p_token, p_hid);
  if not exists (select 1 from hyodo.households where id = p_hid and owner_guardian_id = a.gid) then
    raise exception 'not_owner' using errcode = 'P0001';
  end if;
  update hyodo.meds set active = false where household_id = p_hid and active;
  update hyodo.contacts set name = '', rel = '', phone = '', photo = null where household_id = p_hid;
  update hyodo.households set scale = 1, reset_at = now() where id = p_hid;
  perform hyodo.log(p_hid, '시작 보호자 ' || a.gname || ' 님이 데이터를 초기화했어요');
end $$;

-- 화면 상태: 초기화 전 사진·활동 기록은 보이지 않게 (state_json 의 photos/activity 에 created_at > reset_at 조건 추가)
-- 전체 본문은 20261018050000_hyodo_guardians.sql 의 state_json 에 아래 두 조건과 since 변수를 더한 것과 같다:
--   since := coalesce(h.reset_at, '-infinity'::timestamptz);
--   photos:   ... where ph.household_id = h.id and ph.created_at > since ...
--   activity: ... where ac.household_id = h.id and ac.created_at >= since ...
