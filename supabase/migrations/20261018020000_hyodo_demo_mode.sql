-- 체험(테스트) 가구 구분: 실제 사용 데이터와 섞이지 않게 표시해 둔다
alter table hyodo.households add column demo boolean not null default false;

-- 폰 하나로 체험하기: 어르신·보호자 토큰을 한 번에 돌려준다 (연결 코드 단계 없음)
create function public.hyodo_create_demo()
returns json language plpgsql volatile security definer set search_path = '' as $$
declare h hyodo.households;
begin
  insert into hyodo.households (senior_token, guardian_token, channel, pair_code, elder_name, demo)
  values (hyodo.rand_token(), hyodo.rand_token(), hyodo.rand_token(), hyodo.new_pair_code(), '체험 어르신', true)
  returning * into h;
  update hyodo.households set pair_expires = now() where id = h.id;   -- 체험 가구는 다른 폰과 연결하지 않는다
  perform hyodo.log(h.id, '체험을 시작했어요');
  return json_build_object('senior', h.senior_token, 'guardian', h.guardian_token);
end $$;

-- 알람에서 '먹었어요': 알람이 알려 준 그 시간의 안 먹은 약을 모두 기록한다
create function public.hyodo_take_med_at(p_token text, p_time text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare a record; v_now timestamp := hyodo.local_now(); t time := p_time::time; ids bigint[]; labels text;
begin
  select * into a from hyodo.auth(p_token, 'senior');
  update hyodo.households set last_active = now() where id = a.hid;
  with ins as (
    insert into hyodo.med_logs (household_id, med_id, day)
    select a.hid, md.id, v_now::date from hyodo.meds md
     where md.household_id = a.hid and md.active and md.time = t
       and not exists (select 1 from hyodo.med_logs ml where ml.med_id = md.id and ml.day = v_now::date and ml.undone_at is null)
    returning id, med_id
  )
  select array_agg(ins.id order by ins.id), string_agg(m.label, ', ' order by m.id) into ids, labels
    from ins join hyodo.meds m on m.id = ins.med_id;
  if ids is null then return json_build_object('none', true); end if;
  perform hyodo.log(a.hid, labels || ' 드셨어요');
  return json_build_object('log_id', ids[1], 'log_ids', ids, 'label', labels, 'time', to_char(t, 'HH24:MI'));
end $$;
