-- 약 먹었어: 같은 시간에 먹는 약은 한 번에 모두 기록한다.
-- 1시간 안에 먹을 약 중 가장 이른 시간을 고르고, 그 시간의 안 먹은 약을 전부 기록.
create or replace function public.hyodo_take_med(p_token text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare a record; v_now timestamp := hyodo.local_now(); t time; ids bigint[]; labels text;
begin
  select * into a from hyodo.auth(p_token, 'senior');
  update hyodo.households set last_active = now() where id = a.hid;
  select min(md.time) into t from hyodo.meds md
   where md.household_id = a.hid and md.active
     and v_now::date + md.time <= v_now + interval '1 hour'
     and not exists (select 1 from hyodo.med_logs ml where ml.med_id = md.id and ml.day = v_now::date and ml.undone_at is null);
  if t is null then return json_build_object('none', true); end if;
  with ins as (
    insert into hyodo.med_logs (household_id, med_id, day)
    select a.hid, md.id, v_now::date from hyodo.meds md
     where md.household_id = a.hid and md.active and md.time = t
       and not exists (select 1 from hyodo.med_logs ml where ml.med_id = md.id and ml.day = v_now::date and ml.undone_at is null)
    returning id, med_id
  )
  select array_agg(ins.id order by ins.id), string_agg(m.label, ', ' order by m.id) into ids, labels
    from ins join hyodo.meds m on m.id = ins.med_id;
  perform hyodo.log(a.hid, labels || ' 드셨어요');
  return json_build_object('log_id', ids[1], 'log_ids', ids, 'label', labels, 'time', to_char(t, 'HH24:MI'));
end $$;

-- 잘못 눌렀어요: 한 번에 기록한 약을 함께 되돌린다
create function public.hyodo_undo_meds(p_token text, p_log_ids bigint[])
returns void language plpgsql volatile security definer set search_path = '' as $$
declare a record; lbl text;
begin
  select * into a from hyodo.auth(p_token, 'senior');
  with u as (
    update hyodo.med_logs ml set undone_at = now()
      from hyodo.meds m
     where ml.id = any(p_log_ids) and ml.household_id = a.hid and ml.undone_at is null and m.id = ml.med_id
    returning m.id, m.label
  )
  select string_agg(u.label, ', ' order by u.id) into lbl from u;
  if lbl is not null then perform hyodo.log(a.hid, lbl || ' "먹었어"를 잘못 눌러 취소하셨어요'); end if;
end $$;
