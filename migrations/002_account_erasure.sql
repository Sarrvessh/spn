begin;
create table public.capsule_erasure_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  claimed_until timestamptz,
  attempts integer not null default 0
);
alter table public.capsule_erasure_requests enable row level security;
revoke all on public.capsule_erasure_requests from public, anon, authenticated;
grant all on public.capsule_erasure_requests to service_role;

create function public.capsule_guard_erasure() returns trigger language plpgsql security invoker set search_path = public as $$
declare subject uuid;
begin
  if tg_table_name = 'capsule_profiles' then subject := new.user_id; else subject := new.owner_id; end if;
  perform pg_advisory_xact_lock(hashtextextended(subject::text,0));
  if exists(select 1 from capsule_erasure_requests where user_id = subject) then raise exception 'Account deletion is pending.'; end if;
  return new;
end $$;
create trigger capsule_no_erased_transfer before insert on public.capsule_transfers for each row execute function public.capsule_guard_erasure();
create trigger capsule_no_erased_profile before insert or update on public.capsule_profiles for each row execute function public.capsule_guard_erasure();
revoke all on function public.capsule_guard_erasure() from public, anon, authenticated;
grant execute on function public.capsule_guard_erasure() to service_role;

create function public.capsule_account_rpc(op text, actor uuid) returns jsonb language plpgsql security invoker set search_path = public as $$
declare result jsonb;
begin
  if op = 'claim' then
    with candidates as (
      select e.user_id from capsule_erasure_requests e
      where (e.claimed_until is null or e.claimed_until <= now())
        and not exists(select 1 from capsule_transfers t where t.owner_id = e.user_id and t.purged_at is null)
      order by e.requested_at limit 20 for update skip locked
    ), claimed as (
      update capsule_erasure_requests e set claimed_until = now() + interval '5 minutes', attempts = attempts + 1
      from candidates c where e.user_id = c.user_id returning e.user_id
    ) select coalesce(jsonb_agg(user_id),'[]'::jsonb) into result from claimed;
    return jsonb_build_object('users', result);
  end if;
  if actor is null then raise exception 'Account authorization required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  if op = 'status' then
    return jsonb_build_object('pending', exists(select 1 from capsule_erasure_requests where user_id = actor));
  elsif op = 'request' then
    if not exists(select 1 from capsule_erasure_requests where user_id = actor) then
      update capsule_profiles set discoverable = false, email_notifications = false where user_id = actor;
      insert into capsule_erasure_requests(user_id) values(actor);
    end if;
    update capsule_transfers set status = 'deleted', cleanup_after = coalesce(cleanup_after, now() + interval '10 minutes') where owner_id = actor and purged_at is null;
    delete from capsule_recipients where user_id = actor;
    return jsonb_build_object('pending', true);
  elsif op = 'prepare' then
    if not exists(select 1 from capsule_erasure_requests where user_id = actor) then raise exception 'Deletion has not been requested.'; end if;
    if exists(select 1 from capsule_transfers where owner_id = actor and purged_at is null) then raise exception 'Hosted cleanup is incomplete.'; end if;
    delete from capsule_transfers where owner_id = actor;
    return jsonb_build_object('ready', true);
  end if;
  raise exception 'Invalid account operation.';
end $$;
revoke all on function public.capsule_account_rpc(text,uuid) from public, anon, authenticated;
grant execute on function public.capsule_account_rpc(text,uuid) to service_role;
commit;
