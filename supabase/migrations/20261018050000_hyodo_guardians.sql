-- 보호자 계정: 한 보호자가 여러 어르신(가구)을 맡을 수 있다 (요양보호사 등)
-- 실제로는 hyodo_guardians_tables, hyodo_guardian_api 두 번에 나눠 적용했다.
-- 기존 가구의 보호자 토큰은 그대로 보호자 계정 토큰이 되어, 이미 연결된 보호자 폰은 다시 연결할 필요가 없다.

create table hyodo.guardians (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  name text not null default '보호자',
  created_at timestamptz not null default now()
);

create table hyodo.guardian_links (
  guardian_id uuid not null references hyodo.guardians on delete cascade,
  household_id uuid not null references hyodo.households on delete cascade,
  active boolean not null default true,           -- 연결 끊기 = false (기록은 남긴다)
  created_at timestamptz not null default now(),
  primary key (guardian_id, household_id)
);
create index on hyodo.guardian_links (household_id);

-- 웹 푸시는 이제 보호자 폰 단위: 그 보호자에게 연결된 모든 어르신의 알림을 받는다
create table hyodo.guardian_push (
  id bigint generated always as identity primary key,
  guardian_id uuid not null references hyodo.guardians on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  last_ok timestamptz
);
create index on hyodo.guardian_push (guardian_id);

alter table hyodo.guardians enable row level security;
alter table hyodo.guardian_links enable row level security;
alter table hyodo.guardian_push enable row level security;

-- 기존 보호자 이전
insert into hyodo.guardians (token, name)
select h.guardian_token, '보호자' from hyodo.households h;

insert into hyodo.guardian_links (guardian_id, household_id)
select g.id, h.id from hyodo.households h join hyodo.guardians g on g.token = h.guardian_token;

insert into hyodo.guardian_push (guardian_id, endpoint, p256dh, auth, created_at, last_ok)
select g.id, s.endpoint, s.p256dh, s.auth, s.created_at, s.last_ok
  from hyodo.push_subs s
  join hyodo.households h on h.id = s.household_id
  join hyodo.guardians g on g.token = h.guardian_token
on conflict (endpoint) do nothing;

-- 보호자 확인: 토큰이 맞는지, (가구를 주면) 그 가구에 연결돼 있는지
create function hyodo.gauth(p_token text, p_hid uuid, out gid uuid, out gname text)
language plpgsql stable set search_path = '' as $$
begin
  select g.id, g.name into gid, gname from hyodo.guardians g where p_token is not null and g.token = p_token;
  if gid is null then raise exception 'invalid_token' using errcode = 'P0001'; end if;
  if p_hid is not null and not exists (
    select 1 from hyodo.guardian_links l where l.guardian_id = gid and l.household_id = p_hid and l.active
  ) then raise exception 'forbidden' using errcode = 'P0001'; end if;
end $$;

-- 화면 상태 JSON (어르신·보호자 공통)
create function hyodo.state_json(p_hid uuid, p_senior boolean)
returns json language plpgsql stable set search_path = '' as $$
declare h hyodo.households; v_now timestamp := hyodo.local_now();
begin
  select * into h from hyodo.households where id = p_hid;
  return json_build_object(
    'hid', h.id,
    'role', case when p_senior then 'senior' else 'guardian' end,
    'channel', h.channel,
    'elder_name', h.elder_name,
    'scale', h.scale,
    'demo', h.demo,
    'last_active', h.last_active,
    'pair_code', case when h.pair_expires > now() then h.pair_code end,
    'pair_expires', h.pair_expires,
    'contacts', coalesce((select json_agg(json_build_object('slot', c.slot, 'name', c.name, 'rel', c.rel, 'phone', c.phone, 'photo', c.photo) order by c.slot)
                          from hyodo.contacts c where c.household_id = h.id and c.name <> ''), '[]'::json),
    'meds', coalesce((select json_agg(json_build_object(
                'id', m.id, 'time', to_char(m.time, 'HH24:MI'), 'label', m.label,
                'log_id', l.id, 'at', to_char(l.taken_at at time zone 'Asia/Seoul', 'HH24:MI'),
                'status', case when l.id is not null then 'ok'
                               when v_now > v_now::date + m.time + interval '30 minutes' then 'miss'
                               when v_now >= v_now::date + m.time then 'due'
                               else 'wait' end) order by m.time)
              from hyodo.meds m
              left join lateral (select ml.id, ml.taken_at from hyodo.med_logs ml
                                  where ml.med_id = m.id and ml.day = v_now::date and ml.undone_at is null
                                  order by ml.id desc limit 1) l on true
             where m.household_id = h.id and m.active), '[]'::json),
    'photos', case when p_senior then '[]'::json else
              coalesce((select json_agg(p) from (select ph.id, ph.to_name, to_char(ph.created_at at time zone 'Asia/Seoul', 'MM/DD HH24:MI') as t
                                                   from hyodo.photos ph where ph.household_id = h.id order by ph.id desc limit 12) p), '[]'::json) end,
    'activity', case when p_senior then '[]'::json else
              coalesce((select json_agg(x) from (select ac.msg, to_char(ac.created_at at time zone 'Asia/Seoul', 'MM/DD HH24:MI') as t
                                                   from hyodo.activity ac where ac.household_id = h.id order by ac.id desc limit 15) x), '[]'::json) end
  );
end $$;

revoke all on function hyodo.gauth(text, uuid) from public, anon, authenticated;
revoke all on function hyodo.state_json(uuid, boolean) from public, anon, authenticated;

-- 어르신 폰 상태도 같은 JSON 을 쓴다
create or replace function public.hyodo_state(p_token text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token);
  return hyodo.state_json(a.hid, a.role = 'senior');
end $$;

-- ---------- 보호자 함수 ----------

-- 보호자 연결: 처음이면 보호자 계정을 만들고, 이미 있으면 어르신만 목록에 추가
create function public.hyodo_g_pair(p_code text, p_token text, p_name text)
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
  perform hyodo.log(h.id, gname || ' 님이 보호자로 연결됐어요');
  return json_build_object('token', gtok, 'hid', h.id);
end $$;

-- 보호자 첫 화면: 맡은 어르신 목록과 오늘 약 요약
create function public.hyodo_g_list(p_token text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare a record; v_now timestamp := hyodo.local_now();
begin
  select * into a from hyodo.gauth(p_token, null);
  return json_build_object(
    'name', a.gname,
    'households', coalesce((
      select json_agg(x order by x.created_at) from (
        select h.id as hid, h.elder_name, h.last_active, h.demo, h.channel, l.created_at,
               count(m.id) as total,
               count(m.id) filter (where t.id is not null) as ok,
               count(m.id) filter (where t.id is null and v_now > v_now::date + m.time + interval '30 minutes') as miss,
               count(m.id) filter (where t.id is null and v_now >= v_now::date + m.time and v_now <= v_now::date + m.time + interval '30 minutes') as due,
               to_char(min(m.time) filter (where t.id is null and v_now < v_now::date + m.time), 'HH24:MI') as next_time
          from hyodo.guardian_links l
          join hyodo.households h on h.id = l.household_id
          left join hyodo.meds m on m.household_id = h.id and m.active
          left join lateral (select ml.id from hyodo.med_logs ml
                              where ml.med_id = m.id and ml.day = v_now::date and ml.undone_at is null limit 1) t on true
         where l.guardian_id = a.gid and l.active
         group by h.id, l.created_at
      ) x), '[]'::json)
  );
end $$;

create function public.hyodo_g_state(p_token text, p_hid uuid)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  perform hyodo.gauth(p_token, p_hid);
  return hyodo.state_json(p_hid, false);
end $$;

create function public.hyodo_g_photo(p_token text, p_hid uuid, p_id bigint)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform hyodo.gauth(p_token, p_hid);
  return (select data from hyodo.photos where id = p_id and household_id = p_hid);
end $$;

create function public.hyodo_g_set_name(p_token text, p_name text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.gauth(p_token, null);
  update hyodo.guardians set name = coalesce(nullif(trim(left(p_name, 20)), ''), name) where id = a.gid;
end $$;

create function public.hyodo_g_save_settings(p_token text, p_hid uuid, p_elder_name text, p_scale numeric)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform hyodo.gauth(p_token, p_hid);
  update hyodo.households
     set elder_name = coalesce(nullif(trim(left(p_elder_name, 20)), ''), elder_name),
         scale = least(greatest(coalesce(p_scale, scale), 1), 1.4)
   where id = p_hid;
end $$;

create function public.hyodo_g_save_contact(p_token text, p_hid uuid, p_slot int, p_name text, p_rel text, p_phone text, p_photo text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.gauth(p_token, p_hid);
  if p_photo is not null and (p_photo not like 'data:image/%' or length(p_photo) > 300000) then
    raise exception 'bad_photo' using errcode = 'P0001';
  end if;
  insert into hyodo.contacts (household_id, slot, name, rel, phone, photo)
  values (p_hid, p_slot, left(trim(coalesce(p_name, '')), 12), left(coalesce(p_rel, ''), 10), left(coalesce(p_phone, ''), 20), p_photo)
  on conflict (household_id, slot) do update
    set name = excluded.name, rel = excluded.rel, phone = excluded.phone,
        photo = coalesce(excluded.photo, hyodo.contacts.photo);
  perform hyodo.log(p_hid, a.gname || ' 님이 연락처를 바꿨어요');
end $$;

create function public.hyodo_g_save_med(p_token text, p_hid uuid, p_id bigint, p_time text, p_label text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record; lbl text := left(trim(p_label), 30);
begin
  select * into a from hyodo.gauth(p_token, p_hid);
  if p_id is null then
    if (select count(*) from hyodo.meds where household_id = p_hid and active) >= 8 then raise exception 'too_many' using errcode = 'P0001'; end if;
    insert into hyodo.meds (household_id, time, label) values (p_hid, p_time::time, lbl);
    perform hyodo.log(p_hid, a.gname || ' 님이 ' || lbl || '을 추가했어요');
  else
    update hyodo.meds set time = p_time::time, label = lbl where id = p_id and household_id = p_hid;
    perform hyodo.log(p_hid, a.gname || ' 님이 ' || lbl || ' 정보를 바꿨어요');
  end if;
end $$;

create function public.hyodo_g_remove_med(p_token text, p_hid uuid, p_id bigint)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record; lbl text;
begin
  select * into a from hyodo.gauth(p_token, p_hid);
  update hyodo.meds set active = false where id = p_id and household_id = p_hid returning label into lbl;
  if lbl is not null then perform hyodo.log(p_hid, a.gname || ' 님이 ' || lbl || '을 뺐어요'); end if;
end $$;

create function public.hyodo_g_refresh_pair_code(p_token text, p_hid uuid)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare c text;
begin
  perform hyodo.gauth(p_token, p_hid);
  c := hyodo.new_pair_code();
  update hyodo.households set pair_code = c, pair_expires = now() + interval '30 minutes' where id = p_hid;
  return json_build_object('pair_code', c);
end $$;

-- 이 어르신과 연결 끊기 (목록에서 빠진다. 다시 연결하면 되살아난다)
create function public.hyodo_g_unlink(p_token text, p_hid uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.gauth(p_token, p_hid);
  update hyodo.guardian_links set active = false where guardian_id = a.gid and household_id = p_hid;
  perform hyodo.log(p_hid, a.gname || ' 님이 연결을 끊었어요');
end $$;

create function public.hyodo_g_save_push(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.gauth(p_token, null);
  if p_endpoint not like 'https://%' then raise exception 'bad_endpoint' using errcode = 'P0001'; end if;
  insert into hyodo.guardian_push (guardian_id, endpoint, p256dh, auth)
  values (a.gid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set guardian_id = excluded.guardian_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

-- 체험: 이미 보호자 계정이 있으면 그 목록에 체험 어르신을 붙인다 (요양보호사 테스터의 실제 목록을 지우지 않게)
create function public.hyodo_g_create_demo(p_token text)
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
  perform hyodo.log(h.id, '체험을 시작했어요');
  return json_build_object('senior', h.senior_token, 'guardian', gtok, 'hid', h.id, 'new_guardian', is_new);
end $$;

-- 미응답 알림: 알림 받을 보호자 폰이 있는 가구만 (보호자 계정 기준)
create or replace function hyodo.claim_missed_alerts()
returns table (household_id uuid, elder_name text, labels text, med_time text)
language plpgsql volatile set search_path = '' as $$
declare v_now timestamp := hyodo.local_now();
begin
  return query
  with due as (
    select m.id, m.household_id, m.label, m.time from hyodo.meds m
     where m.active
       and v_now > v_now::date + m.time + interval '30 minutes'
       and v_now < v_now::date + m.time + interval '3 hours'
       and (m.created_at at time zone 'Asia/Seoul') < v_now::date + m.time
       and not exists (select 1 from hyodo.med_logs ml where ml.med_id = m.id and ml.day = v_now::date and ml.undone_at is null)
       and not exists (select 1 from hyodo.push_sent ps where ps.med_id = m.id and ps.day = v_now::date)
       and exists (select 1 from hyodo.guardian_links l join hyodo.guardian_push gp on gp.guardian_id = l.guardian_id
                    where l.household_id = m.household_id and l.active)
  ), ins as (
    insert into hyodo.push_sent (household_id, med_id, day)
    select d.household_id, d.id, v_now::date from due d
    returning hyodo.push_sent.med_id
  )
  select d.household_id, h.elder_name, string_agg(d.label, ', ' order by d.id), to_char(d.time, 'HH24:MI')
    from due d join hyodo.households h on h.id = d.household_id
   where d.id in (select ins.med_id from ins)
   group by d.household_id, h.elder_name, d.time;
end $$;
