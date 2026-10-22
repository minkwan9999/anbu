-- 어르신 폰 약 알림 푸시: 앱이 닫혀 있거나 화면이 꺼져 있어도 약 시간에 알림을 보낸다
-- (public.hyodo_save_push 는 예전 가구 단위 푸시에 이미 쓰인 이름이라 hyodo_senior_save_push 로 둔다)
create table hyodo.senior_push (
  id bigserial primary key,
  household_id uuid not null references hyodo.households(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  last_ok timestamptz
);
create index on hyodo.senior_push (household_id);
alter table hyodo.senior_push enable row level security;

-- 보낸 기록: 약마다 하루에 '정각(due)' 한 번, '10분 뒤 다시(remind)' 한 번
create table hyodo.senior_push_sent (
  med_id bigint not null,
  day date not null,
  kind text not null check (kind in ('due', 'remind')),
  sent_at timestamptz not null default now(),
  primary key (med_id, day, kind)
);
alter table hyodo.senior_push_sent enable row level security;

create function public.hyodo_senior_save_push(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path to '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token, 'senior');
  if p_endpoint not like 'https://%' then raise exception 'bad_endpoint' using errcode = 'P0001'; end if;
  insert into hyodo.senior_push (household_id, endpoint, p256dh, auth)
  values (a.hid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set household_id = excluded.household_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;
revoke all on function public.hyodo_senior_save_push(text, text, text, text) from public;
grant execute on function public.hyodo_senior_save_push(text, text, text, text) to anon, authenticated;

-- 지금 어르신 폰에 보낼 약 알림을 고르고 보냄 표시를 한다. 같은 시간 약은 한 알림으로 묶는다
create function hyodo.claim_due_meds()
returns table(household_id uuid, labels text, med_time text, kind text)
language plpgsql set search_path to '' as $$
declare v_now timestamp := hyodo.local_now();
begin
  return query
  with cand as (
    select m.id, m.household_id, m.label, m.time,
           case when v_now < v_now::date + m.time + interval '10 minutes' then 'due' else 'remind' end as kind
      from hyodo.meds m
     where m.active
       and v_now >= v_now::date + m.time
       and v_now < v_now::date + m.time + interval '25 minutes'
       and (m.created_at at time zone 'Asia/Seoul') < v_now::date + m.time
       and not exists (select 1 from hyodo.med_logs ml where ml.med_id = m.id and ml.day = v_now::date and ml.undone_at is null)
       and exists (select 1 from hyodo.senior_push sp where sp.household_id = m.household_id)
  ), due as (
    select c.* from cand c
     where not exists (select 1 from hyodo.senior_push_sent s where s.med_id = c.id and s.day = v_now::date and s.kind = c.kind)
  ), ins as (
    insert into hyodo.senior_push_sent (med_id, day, kind)
    select d.id, v_now::date, d.kind from due d
    on conflict do nothing
    returning hyodo.senior_push_sent.med_id
  )
  select d.household_id, string_agg(d.label, ', ' order by d.id), to_char(d.time, 'HH24:MI'), d.kind
    from due d
   where d.id in (select ins.med_id from ins)
   group by d.household_id, d.time, d.kind;
end $$;

-- 약 시간 정각에 맞추려고 1분마다 돈다 (보호자 미응답 알림은 보냄 기록이 있어 중복되지 않는다)
select cron.alter_job((select jobid from cron.job where jobname = 'hyodo-missed-meds'), schedule := '* * * * *');
