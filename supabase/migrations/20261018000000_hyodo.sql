-- 효도비서 DB (Supabase 프로젝트 doit-english 안의 hyodo 스키마)
-- 실제로는 hyodo_tables, hyodo_helpers, hyodo_api_pairing_state, hyodo_api_senior,
-- hyodo_api_guardian, hyodo_active_filters 순서로 적용했고, 이 파일은 그 최종 상태를 한데 모은 것이다.
--
-- 구조: 테이블은 API에 노출되지 않는 hyodo 스키마에 두고,
-- 앱은 기기 토큰(어르신용 / 보호자용)을 확인하는 public.hyodo_* 함수로만 접근한다.

create schema if not exists hyodo;
revoke all on schema hyodo from public, anon, authenticated;

create table hyodo.households (
  id uuid primary key default gen_random_uuid(),
  senior_token text not null unique,
  guardian_token text not null unique,
  channel text not null unique,               -- 실시간 알림 채널 이름 (추측 불가)
  pair_code text not null unique,             -- 보호자 연결용 6자리
  pair_expires timestamptz not null default now() + interval '30 minutes',
  elder_name text not null default '어르신',
  scale numeric not null default 1,           -- 어르신 화면 글자 크기
  last_active timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table hyodo.contacts (
  household_id uuid not null references hyodo.households on delete cascade,
  slot int not null check (slot between 0 and 2),
  name text not null,                         -- 빈 이름 = 빈 칸
  rel text not null default '',
  phone text not null default '',
  photo text,                                 -- 256px JPEG data URL
  primary key (household_id, slot)
);

create table hyodo.meds (
  id bigint generated always as identity primary key,
  household_id uuid not null references hyodo.households on delete cascade,
  time time not null,
  label text not null,
  active boolean not null default true        -- 지우지 않고 숨긴다 (복용 기록 보존)
);
create index on hyodo.meds (household_id);

create table hyodo.med_logs (
  id bigint generated always as identity primary key,
  household_id uuid not null references hyodo.households on delete cascade,
  med_id bigint not null references hyodo.meds on delete cascade,
  day date not null,                          -- 한국 날짜
  taken_at timestamptz not null default now(),
  undone_at timestamptz                       -- "잘못 눌렀어요"
);
create index on hyodo.med_logs (med_id, day);
create index on hyodo.med_logs (household_id);

create table hyodo.photos (
  id bigint generated always as identity primary key,
  household_id uuid not null references hyodo.households on delete cascade,
  to_name text not null,
  data text not null,                         -- JPEG data URL (최대 1.5MB)
  created_at timestamptz not null default now()
);
create index on hyodo.photos (household_id, id desc);

create table hyodo.activity (
  id bigint generated always as identity primary key,
  household_id uuid not null references hyodo.households on delete cascade,
  msg text not null,
  created_at timestamptz not null default now()
);
create index on hyodo.activity (household_id, id desc);

-- 음성 인식 현장 테스트용: 들린 문장과 해석 결과
create table hyodo.voice_logs (
  id bigint generated always as identity primary key,
  household_id uuid not null references hyodo.households on delete cascade,
  heard text not null,
  intent text not null,
  created_at timestamptz not null default now()
);
create index on hyodo.voice_logs (household_id);

alter table hyodo.households enable row level security;
alter table hyodo.contacts enable row level security;
alter table hyodo.meds enable row level security;
alter table hyodo.med_logs enable row level security;
alter table hyodo.photos enable row level security;
alter table hyodo.activity enable row level security;
alter table hyodo.voice_logs enable row level security;

-- ---------- 내부 도우미 ----------
create function hyodo.rand_token() returns text language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

create function hyodo.new_pair_code() returns text language plpgsql volatile set search_path = '' as $$
declare c text;
begin
  loop
    c := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from hyodo.households where pair_code = c and pair_expires > now());
  end loop;
  -- 만료된 같은 코드는 비워 둔다 (unique 제약)
  update hyodo.households set pair_code = hyodo.rand_token() where pair_code = c;
  return c;
end $$;

-- 토큰으로 가구와 역할을 찾는다. 없거나 역할이 다르면 오류.
create function hyodo.auth(p_token text, p_need text default null, out hid uuid, out role text)
language plpgsql stable set search_path = '' as $$
begin
  select h.id, case when h.senior_token = p_token then 'senior' else 'guardian' end
    into hid, role
    from hyodo.households h
   where p_token is not null and (h.senior_token = p_token or h.guardian_token = p_token);
  if hid is null then raise exception 'invalid_token' using errcode = 'P0001'; end if;
  if p_need is not null and role <> p_need then raise exception 'forbidden' using errcode = 'P0001'; end if;
end $$;

create function hyodo.log(p_hid uuid, p_msg text) returns void language sql volatile set search_path = '' as $$
  insert into hyodo.activity (household_id, msg) values (p_hid, left(p_msg, 200));
$$;

create function hyodo.local_now() returns timestamp language sql stable set search_path = '' as $$
  select now() at time zone 'Asia/Seoul'
$$;

revoke all on all functions in schema hyodo from public, anon, authenticated;

-- ---------- 연결 · 상태 ----------

-- 어르신 폰에서 처음 시작
create function public.hyodo_create_household(p_elder_name text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare h hyodo.households;
begin
  insert into hyodo.households (senior_token, guardian_token, channel, pair_code, elder_name)
  values (hyodo.rand_token(), hyodo.rand_token(), hyodo.rand_token(), hyodo.new_pair_code(),
          coalesce(nullif(trim(left(p_elder_name, 20)), ''), '어르신'))
  returning * into h;
  perform hyodo.log(h.id, '어르신 폰이 시작됐어요');
  return json_build_object('token', h.senior_token, 'role', 'senior');
end $$;

-- 보호자 폰: 6자리 코드로 연결
create function public.hyodo_pair(p_code text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare h hyodo.households;
begin
  select * into h from hyodo.households where pair_code = trim(p_code) and pair_expires > now();
  if h.id is null then raise exception 'bad_code' using errcode = 'P0001'; end if;
  perform hyodo.log(h.id, '보호자 폰이 연결됐어요');
  return json_build_object('token', h.guardian_token, 'role', 'guardian');
end $$;

-- 연결 코드 새로 받기 (30분 유효)
create function public.hyodo_refresh_pair_code(p_token text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare a record; c text;
begin
  select * into a from hyodo.auth(p_token);
  c := hyodo.new_pair_code();
  update hyodo.households set pair_code = c, pair_expires = now() + interval '30 minutes' where id = a.hid;
  return json_build_object('pair_code', c);
end $$;

-- 화면 전체 상태. 약 상태: ok(드심) / due(시간 됨) / miss(30분 넘게 안 드심) / wait
create function public.hyodo_state(p_token text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare a record; h hyodo.households; v_now timestamp := hyodo.local_now(); senior boolean;
begin
  select * into a from hyodo.auth(p_token);
  select * into h from hyodo.households where id = a.hid;
  senior := a.role = 'senior';
  return json_build_object(
    'role', a.role,
    'channel', h.channel,
    'elder_name', h.elder_name,
    'scale', h.scale,
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
    'photos', case when senior then '[]'::json else
              coalesce((select json_agg(p) from (select ph.id, ph.to_name, to_char(ph.created_at at time zone 'Asia/Seoul', 'MM/DD HH24:MI') as t
                                                   from hyodo.photos ph where ph.household_id = h.id order by ph.id desc limit 12) p), '[]'::json) end,
    'activity', case when senior then '[]'::json else
              coalesce((select json_agg(x) from (select ac.msg, to_char(ac.created_at at time zone 'Asia/Seoul', 'MM/DD HH24:MI') as t
                                                   from hyodo.activity ac where ac.household_id = h.id order by ac.id desc limit 15) x), '[]'::json) end
  );
end $$;

create function public.hyodo_photo(p_token text, p_id bigint)
returns text language plpgsql stable security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token);
  return (select data from hyodo.photos where id = p_id and household_id = a.hid);
end $$;

-- ---------- 어르신 폰 ----------

create function public.hyodo_touch(p_token text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token, 'senior');
  update hyodo.households set last_active = now() where id = a.hid;
end $$;

-- 약 먹었어: 1시간 안에 먹을 약 중 가장 이른 것을 기록한다.
create function public.hyodo_take_med(p_token text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare a record; v_now timestamp := hyodo.local_now(); m hyodo.meds; lid bigint;
begin
  select * into a from hyodo.auth(p_token, 'senior');
  update hyodo.households set last_active = now() where id = a.hid;
  select md.* into m from hyodo.meds md
   where md.household_id = a.hid and md.active
     and v_now::date + md.time <= v_now + interval '1 hour'
     and not exists (select 1 from hyodo.med_logs ml where ml.med_id = md.id and ml.day = v_now::date and ml.undone_at is null)
   order by md.time limit 1;
  if m.id is null then return json_build_object('none', true); end if;
  insert into hyodo.med_logs (household_id, med_id, day) values (a.hid, m.id, v_now::date) returning id into lid;
  perform hyodo.log(a.hid, m.label || ' 드셨어요');
  return json_build_object('log_id', lid, 'label', m.label);
end $$;

create function public.hyodo_undo_med(p_token text, p_log_id bigint)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record; lbl text;
begin
  select * into a from hyodo.auth(p_token, 'senior');
  update hyodo.med_logs ml set undone_at = now()
    from hyodo.meds m
   where ml.id = p_log_id and ml.household_id = a.hid and ml.undone_at is null and m.id = ml.med_id
  returning m.label into lbl;
  if lbl is not null then perform hyodo.log(a.hid, lbl || ' "먹었어"를 잘못 눌러 취소하셨어요'); end if;
end $$;

create function public.hyodo_send_photo(p_token text, p_to text, p_data text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token, 'senior');
  if p_data is null or p_data not like 'data:image/%' or length(p_data) > 1500000 then
    raise exception 'bad_photo' using errcode = 'P0001';
  end if;
  insert into hyodo.photos (household_id, to_name, data) values (a.hid, left(p_to, 30), p_data);
  update hyodo.households set last_active = now() where id = a.hid;
  perform hyodo.log(a.hid, left(p_to, 30) || '에게 사진을 보내셨어요');
end $$;

-- 전화 걸기 같은 일반 활동 기록
create function public.hyodo_log(p_token text, p_msg text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token);
  if a.role = 'senior' then update hyodo.households set last_active = now() where id = a.hid; end if;
  perform hyodo.log(a.hid, p_msg);
end $$;

-- 음성 인식 현장 테스트 기록
create function public.hyodo_voice_log(p_token text, p_heard text, p_intent text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token, 'senior');
  insert into hyodo.voice_logs (household_id, heard, intent) values (a.hid, left(p_heard, 200), left(p_intent, 40));
end $$;

-- ---------- 보호자 폰 ----------

create function public.hyodo_save_settings(p_token text, p_elder_name text, p_scale numeric)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token, 'guardian');
  update hyodo.households
     set elder_name = coalesce(nullif(trim(left(p_elder_name, 20)), ''), elder_name),
         scale = least(greatest(coalesce(p_scale, scale), 1), 1.4)
   where id = a.hid;
end $$;

-- 이름을 비우면 그 칸은 빈 연락처로 취급한다. p_photo 가 null 이면 기존 사진 유지.
create function public.hyodo_save_contact(p_token text, p_slot int, p_name text, p_rel text, p_phone text, p_photo text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token, 'guardian');
  if p_photo is not null and (p_photo not like 'data:image/%' or length(p_photo) > 300000) then
    raise exception 'bad_photo' using errcode = 'P0001';
  end if;
  insert into hyodo.contacts (household_id, slot, name, rel, phone, photo)
  values (a.hid, p_slot, left(trim(coalesce(p_name, '')), 12), left(coalesce(p_rel, ''), 10), left(coalesce(p_phone, ''), 20), p_photo)
  on conflict (household_id, slot) do update
    set name = excluded.name, rel = excluded.rel, phone = excluded.phone,
        photo = coalesce(excluded.photo, hyodo.contacts.photo);
end $$;

create function public.hyodo_save_med(p_token text, p_id bigint, p_time text, p_label text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token, 'guardian');
  if p_id is null then
    if (select count(*) from hyodo.meds where household_id = a.hid and active) >= 8 then raise exception 'too_many' using errcode = 'P0001'; end if;
    insert into hyodo.meds (household_id, time, label) values (a.hid, p_time::time, left(trim(p_label), 30));
  else
    update hyodo.meds set time = p_time::time, label = left(trim(p_label), 30) where id = p_id and household_id = a.hid;
  end if;
end $$;

create function public.hyodo_remove_med(p_token text, p_id bigint)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token, 'guardian');
  update hyodo.meds set active = false where id = p_id and household_id = a.hid;
end $$;
