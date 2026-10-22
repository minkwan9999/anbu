-- 사용 현황(개발자용)과 가격 질문
-- 앱을 연 날: 어르신 폰은 hyodo_touch, 보호자 폰은 hyodo_g_touch 가 하루 한 줄씩 남긴다
create table hyodo.visits (
  who text not null check (who in ('senior', 'guardian')),
  id uuid not null,
  day date not null,
  primary key (who, id, day)
);
alter table hyodo.visits enable row level security;

-- 가격 질문 답: 보호자당 하나 (다시 누르면 바뀐다)
create table hyodo.price_answers (
  guardian_id uuid primary key references hyodo.guardians(id),
  answer text not null check (answer in ('yes', 'no')),
  created_at timestamptz not null default now()
);
alter table hyodo.price_answers enable row level security;

create or replace function public.hyodo_touch(p_token text)
returns void language plpgsql security definer set search_path to '' as $$
declare a record;
begin
  select * into a from hyodo.auth(p_token, 'senior');
  update hyodo.households set last_active = now() where id = a.hid;
  insert into hyodo.visits values ('senior', a.hid, hyodo.local_now()::date) on conflict do nothing;
end $$;

create function public.hyodo_g_touch(p_token text)
returns void language plpgsql security definer set search_path to '' as $$
declare a record;
begin
  select * into a from hyodo.gauth(p_token, null);
  insert into hyodo.visits values ('guardian', a.gid, hyodo.local_now()::date) on conflict do nothing;
end $$;

-- 가격 질문을 띄울지: 아직 답하지 않았고, 실제(체험 아님) 어르신과 7일 넘게 연결된 보호자
create function public.hyodo_g_price_ask(p_token text)
returns boolean language plpgsql stable security definer set search_path to '' as $$
declare a record;
begin
  select * into a from hyodo.gauth(p_token, null);
  return not exists (select 1 from hyodo.price_answers where guardian_id = a.gid)
     and exists (select 1 from hyodo.guardian_links l join hyodo.households h on h.id = l.household_id
                  where l.guardian_id = a.gid and l.active and not h.demo
                    and l.created_at < now() - interval '7 days');
end $$;

create function public.hyodo_g_price(p_token text, p_answer text)
returns void language plpgsql security definer set search_path to '' as $$
declare a record;
begin
  select * into a from hyodo.gauth(p_token, null);
  if p_answer not in ('yes', 'no') then raise exception 'bad_answer'; end if;
  insert into hyodo.price_answers (guardian_id, answer) values (a.gid, p_answer)
    on conflict (guardian_id) do update set answer = excluded.answer, created_at = now();
end $$;

-- 개발자 키: Vault 에만 둔다
select vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hyodo_admin_key', '안부버튼 사용 현황 페이지 키');

-- 사용 현황: 실제(체험 아님) 어르신마다 최근 14일 사용 기록
create function public.hyodo_admin_stats(p_key text)
returns json language plpgsql stable security definer set search_path to '' as $$
declare v_today date := hyodo.local_now()::date;
begin
  if p_key is null or p_key <> (select decrypted_secret from vault.decrypted_secrets where name = 'hyodo_admin_key') then
    raise exception 'forbidden';
  end if;
  return json_build_object(
    'today', v_today,
    'price_yes', (select count(*) from hyodo.price_answers p where p.answer = 'yes'
                   and exists (select 1 from hyodo.guardian_links l join hyodo.households h on h.id = l.household_id where l.guardian_id = p.guardian_id and not h.demo)),
    'price_no', (select count(*) from hyodo.price_answers p where p.answer = 'no'
                   and exists (select 1 from hyodo.guardian_links l join hyodo.households h on h.id = l.household_id where l.guardian_id = p.guardian_id and not h.demo)),
    'households', coalesce((select json_agg(x order by x.created_at desc) from (
      select h.elder_name, h.created_at, h.last_active,
             (v_today - (h.created_at at time zone 'Asia/Seoul')::date) + 1 as age_days,
             (select g.name from hyodo.guardians g where g.id = h.owner_guardian_id) as owner,
             (select count(*) from hyodo.guardian_links l where l.household_id = h.id and l.active) as guardians,
             (select count(*) from hyodo.meds m where m.household_id = h.id and m.active) as meds,
             -- 어르신이 무언가 한 날 (앱 열기, 약 기록, 사진, 말로 하기, 전화)
             (select count(distinct d) from (
                select v.day as d from hyodo.visits v where v.who = 'senior' and v.id = h.id
                union select ml.day from hyodo.med_logs ml where ml.household_id = h.id
                union select (p.created_at at time zone 'Asia/Seoul')::date from hyodo.photos p where p.household_id = h.id
                union select (vl.created_at at time zone 'Asia/Seoul')::date from hyodo.voice_logs vl where vl.household_id = h.id
                union select (ac.created_at at time zone 'Asia/Seoul')::date from hyodo.activity ac where ac.household_id = h.id and ac.msg like '%전화를 거셨어요'
              ) s where d > v_today - 14) as senior_days,
             (select count(distinct v.day) from hyodo.visits v join hyodo.guardian_links l on l.guardian_id = v.id and l.household_id = h.id
               where v.who = 'guardian' and v.day > v_today - 14) as guardian_days,
             (select count(*) from hyodo.med_logs ml where ml.household_id = h.id and ml.undone_at is null and ml.day > v_today - 7) as took_7,
             (select count(*) from hyodo.meds m where m.household_id = h.id and m.active)
               * least(7, (v_today - (h.created_at at time zone 'Asia/Seoul')::date) + 1) as due_7,
             (select count(*) from hyodo.activity ac where ac.household_id = h.id and ac.msg like '%전화를 거셨어요'
               and ac.created_at > now() - interval '14 days') as calls,
             (select count(*) from hyodo.photos p where p.household_id = h.id and p.created_at > now() - interval '14 days') as photos,
             (select count(*) from hyodo.voice_logs vl where vl.household_id = h.id and vl.intent not like 'error:%'
               and vl.created_at > now() - interval '14 days') as voice,
             (select count(*) from hyodo.voice_logs vl where vl.household_id = h.id and vl.intent like 'error:%') as voice_errors
        from hyodo.households h where not h.demo
    ) x), '[]'::json)
  );
end $$;

revoke all on function public.hyodo_g_touch(text), public.hyodo_g_price_ask(text), public.hyodo_g_price(text, text), public.hyodo_admin_stats(text) from public;
grant execute on function public.hyodo_g_touch(text), public.hyodo_g_price_ask(text), public.hyodo_g_price(text, text), public.hyodo_admin_stats(text) to anon, authenticated;
