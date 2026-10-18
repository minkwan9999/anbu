-- 보호자 웹 푸시: 약을 30분 넘게 안 드시면 보호자 폰으로 알림 (앱이 닫혀 있어도)
-- 흐름: pg_cron(5분마다) → Edge Function hyodo-push {action:"cron"} → hyodo.claim_missed_alerts() → 웹 푸시 발송
-- VAPID 키(hyodo_vapid)는 Edge Function 이 처음 실행될 때 만들어 Vault 에 저장한다.
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- 보호자 폰의 웹 푸시 등록 정보
create table hyodo.push_subs (
  id bigint generated always as identity primary key,
  household_id uuid not null references hyodo.households on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  last_ok timestamptz
);
create index on hyodo.push_subs (household_id);

-- 같은 약 미응답 알림을 하루에 한 번만 보내도록 기록
create table hyodo.push_sent (
  household_id uuid not null references hyodo.households on delete cascade,
  med_id bigint not null references hyodo.meds on delete cascade,
  day date not null,
  sent_at timestamptz not null default now(),
  primary key (med_id, day)
);

alter table hyodo.push_subs enable row level security;
alter table hyodo.push_sent enable row level security;

-- 약을 추가한 시각: 이미 지난 시간의 약을 새로 넣었을 때 바로 '안 드셨어요' 알림이 가지 않게
alter table hyodo.meds add column created_at timestamptz not null default now();

-- 보호자 폰: 푸시 등록 (같은 폰이면 덮어쓴다)
create function public.hyodo_save_push(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token, 'guardian');
  if p_endpoint not like 'https://%' then raise exception 'bad_endpoint' using errcode = 'P0001'; end if;
  insert into hyodo.push_subs (household_id, endpoint, p256dh, auth)
  values (a.hid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set household_id = excluded.household_id, p256dh = excluded.p256dh, auth = excluded.auth;
  perform hyodo.log(a.hid, '보호자 폰 알림을 켰어요');
end $$;

-- 보낼 미응답 알림을 골라 '보냄'으로 표시하고 돌려준다 (Edge Function이 5분마다 호출)
-- 조건: 약 시간 + 30분이 지났고 3시간은 안 지남, 오늘 안 드심, 아직 안 보냄, 약 시간 전에 넣은 약, 받을 보호자 폰이 있음
create function hyodo.claim_missed_alerts()
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
       and exists (select 1 from hyodo.push_subs s where s.household_id = m.household_id)
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
revoke all on function hyodo.claim_missed_alerts() from public, anon, authenticated;

-- 5분마다 Edge Function을 부를 때 쓰는 비밀값 (Vault에만 저장)
select vault.create_secret(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hyodo_cron_secret', '효도비서 미응답 알림 예약 작업용');

-- 5분마다 약 미응답 알림 확인·발송
select cron.schedule(
  'hyodo-missed-meds',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://fpmtbxfjmjwpexktbnfm.supabase.co/functions/v1/hyodo-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'hyodo_cron_secret')),
    body := '{"action":"cron"}'::jsonb
  )
  $job$
);
