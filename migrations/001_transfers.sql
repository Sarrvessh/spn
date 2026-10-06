-- Run as the Supabase database owner. No client role can execute the service RPC.
begin;
create table public.capsule_limits (
  singleton boolean primary key default true check (singleton),
  capsule_bytes bigint not null default 5000000000 check (capsule_bytes between 1 and 5000000000),
  storage_bytes bigint not null default 50000000000 check (storage_bytes > 0),
  daily_download_bytes bigint not null default 100000000000 check (daily_download_bytes > 0),
  retention_days integer not null default 30 check (retention_days between 1 and 30)
);
insert into public.capsule_limits default values;
create table public.capsule_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  handle text unique not null check (handle ~ '^[a-z][a-z0-9_]{2,29}$'),
  display_name text not null check (length(display_name) between 1 and 80),
  discoverable boolean not null default false,
  email_notifications boolean not null default false,
  public_key jsonb not null,
  private_key jsonb not null,
  key_version integer not null default 1 check (key_version = 1),
  created_at timestamptz not null default now()
);
create table public.capsule_transfers (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'uploading' check (status in ('uploading','available','claimed','burned','expired','revoked','deleted')),
  bytes bigint not null check (bytes between 0 and 5000000000),
  part_count integer not null check (part_count between 1 and 661),
  mode text not null check (mode in ('link','direct')),
  access_hash text check (access_hash ~ '^[A-Za-z0-9_-]{43}$'),
  password_box jsonb,
  manifest jsonb,
  burn boolean not null default false,
  expires_at timestamptz not null,
  unlock_at timestamptz,
  upload_until timestamptz not null default now() + interval '24 hours',
  created_at timestamptz not null default now(),
  cleanup_after timestamptz,
  purged_at timestamptz,
  check (unlock_at is null or unlock_at < expires_at),
  check ((mode = 'link' and access_hash is not null) or (mode = 'direct' and access_hash is null))
);
create index capsule_transfers_owner on public.capsule_transfers(owner_id,created_at desc,id);
create index capsule_transfers_cleanup on public.capsule_transfers(cleanup_after) where purged_at is null;
create index capsule_transfers_expiry on public.capsule_transfers(expires_at) where purged_at is null;
create table public.capsule_parts (
  transfer_id uuid not null references public.capsule_transfers(id) on delete cascade,
  index integer not null check (index between 0 and 660),
  size integer not null check (size between 16 and 8388624),
  checksum text check (checksum ~ '^[A-Za-z0-9_-]{43}$'),
  confirmed boolean not null default false,
  primary key (transfer_id,index)
);
create table public.capsule_recipients (
  transfer_id uuid not null references public.capsule_transfers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  wrapped_key text not null check (length(wrapped_key) = 512 and wrapped_key ~ '^[A-Za-z0-9_-]+$'),
  key_version integer not null default 1 check (key_version = 1),
  primary key (transfer_id,user_id)
);
create index capsule_recipients_inbox on public.capsule_recipients(user_id,transfer_id);
create table public.capsule_leases (
  transfer_id uuid not null references public.capsule_transfers(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz not null,
  complete boolean not null default false,
  primary key (transfer_id,token_hash)
);
create table public.capsule_egress (
  owner_id uuid not null references auth.users(id) on delete cascade,
  day date not null default current_date,
  bytes bigint not null default 0,
  primary key (owner_id,day)
);
create table public.capsule_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.capsule_transfers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempts integer not null default 0,
  next_at timestamptz not null default now(),
  done_at timestamptz,
  unique (transfer_id,user_id)
);
create index capsule_notification_due on public.capsule_notification_outbox(next_at) where done_at is null;
alter table public.capsule_notification_outbox enable row level security;
revoke all on public.capsule_notification_outbox from anon,authenticated;
grant all on public.capsule_notification_outbox to service_role;

alter table public.capsule_limits enable row level security;
alter table public.capsule_profiles enable row level security;
alter table public.capsule_transfers enable row level security;
alter table public.capsule_parts enable row level security;
alter table public.capsule_recipients enable row level security;
alter table public.capsule_leases enable row level security;
alter table public.capsule_egress enable row level security;
-- Defense in depth: direct table access is not part of the public API.
create policy profile_owner on public.capsule_profiles for select to authenticated using (user_id = auth.uid());
create policy transfer_owner on public.capsule_transfers for select to authenticated using (owner_id = auth.uid());
create policy recipient_self on public.capsule_recipients for select to authenticated using (user_id = auth.uid());
revoke all on public.capsule_limits, public.capsule_profiles, public.capsule_transfers, public.capsule_parts, public.capsule_recipients, public.capsule_leases, public.capsule_egress from anon, authenticated;
grant all on public.capsule_limits, public.capsule_profiles, public.capsule_transfers, public.capsule_parts, public.capsule_recipients, public.capsule_leases, public.capsule_egress to service_role;

create function public.capsule_transfer_rpc(op text, actor uuid, input jsonb) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  t public.capsule_transfers; p public.capsule_profiles; part public.capsule_parts;
  lim public.capsule_limits; item jsonb; result jsonb; total bigint; idx integer;
  lease public.capsule_leases; member boolean; target uuid; n integer;
begin
  select * into lim from public.capsule_limits where singleton;
  if op = 'profile' then
    if actor is null then raise exception 'Sign in first.'; end if;
    select * into p from public.capsule_profiles where user_id = actor;
    return coalesce(to_jsonb(p), '{}'::jsonb);
  elsif op = 'profile-save' then
    if actor is null then raise exception 'Sign in first.'; end if;
    insert into public.capsule_profiles(user_id,handle,display_name,discoverable,email_notifications,public_key,private_key)
    values(actor,input->>'handle',input->>'displayName',coalesce((input->>'discoverable')::boolean,false),coalesce((input->>'emailNotifications')::boolean,false),input->'publicKey',input->'privateKey')
    on conflict(user_id) do update set handle = excluded.handle, display_name = excluded.display_name, discoverable = excluded.discoverable,email_notifications = excluded.email_notifications;
    return jsonb_build_object('saved',true);
  elsif op = 'discover' then
    if actor is null then raise exception 'Sign in first.'; end if;
    select * into p from public.capsule_profiles where handle = input->>'handle' and discoverable;
    if not found then raise exception 'Recipient unavailable.'; end if;
    return jsonb_build_object('userId',p.user_id,'handle',p.handle,'displayName',p.display_name,'publicKey',p.public_key,'keyVersion',p.key_version);
  elsif op = 'list' then
    if actor is null then raise exception 'Sign in first.'; end if;
    select coalesce(jsonb_agg(row_to_json(q)), '[]'::jsonb) into result from (
      select x.id,x.status,x.bytes,x.mode,x.created_at,x.expires_at,x.unlock_at,x.burn,x.purged_at,
        pr.handle as sender, (x.owner_id = actor) as owned
      from public.capsule_transfers x left join public.capsule_profiles pr on pr.user_id = x.owner_id
      where ((input->>'folder' = 'received' and x.owner_id <> actor and x.status <> 'uploading' and exists (select 1 from public.capsule_recipients r where r.transfer_id = x.id and r.user_id = actor))
        or (input->>'folder' = 'sent' and x.owner_id = actor and x.status <> 'uploading')
        or (input->>'folder' = 'drafts' and x.owner_id = actor and x.status = 'uploading'))
        and (input->>'before' is null or (x.created_at,x.id) < ((input->>'before')::timestamptz,(input->>'beforeId')::uuid))
      order by x.created_at desc,x.id desc limit 30
    ) q;
    return jsonb_build_object('items',result);
  elsif op = 'create' then
    if actor is null then raise exception 'Sign in first.'; end if;
    perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
    select * into t from public.capsule_transfers where id = (input->>'id')::uuid;
    if found then
      if t.owner_id <> actor or t.bytes <> (input->>'bytes')::bigint or t.access_hash is distinct from input->>'accessHash' then raise exception 'Transfer unavailable.'; end if;
      return jsonb_build_object('id',t.id);
    end if;
    select coalesce(sum(bytes),0) into total from public.capsule_transfers where owner_id = actor and purged_at is null;
    if (input->>'bytes')::bigint > lim.capsule_bytes or total + (input->>'bytes')::bigint > lim.storage_bytes then raise exception 'Storage quota exceeded.'; end if;
    select count(*) into n from public.capsule_transfers where owner_id = actor and created_at > now() - interval '1 day';
    if n >= 100 then raise exception 'Daily transfer limit reached.'; end if;
    if (input->>'expires')::timestamptz <= now() or (input->>'expires')::timestamptz > now() + make_interval(days => lim.retention_days) then raise exception 'Invalid expiry.'; end if;
    insert into public.capsule_transfers(id,owner_id,bytes,part_count,mode,access_hash,password_box,burn,expires_at,unlock_at)
    values ((input->>'id')::uuid,actor,(input->>'bytes')::bigint,jsonb_array_length(input->'sizes'),input->>'mode',input->>'accessHash',input->'passwordBox',coalesce((input->>'burn')::boolean,false),(input->>'expires')::timestamptz,(input->>'unlock')::timestamptz) returning * into t;
    total := 0; idx := 0;
    for item in select * from jsonb_array_elements(input->'sizes') loop
      insert into public.capsule_parts(transfer_id,index,size) values(t.id,idx,(item::text)::integer + 16);
      total := total + (item::text)::integer; idx := idx + 1;
    end loop;
    if total <> t.bytes then raise exception 'Invalid chunk sizes.'; end if;
    for item in select * from jsonb_array_elements(input->'grants') loop
      target := (item->>'userId')::uuid;
      if not exists (select 1 from public.capsule_profiles where user_id = target and (user_id = actor or discoverable) and key_version = (item->>'keyVersion')::integer) then raise exception 'Recipient unavailable.'; end if;
      insert into public.capsule_recipients(transfer_id,user_id,wrapped_key,key_version) values(t.id,target,item->>'wrappedKey',(item->>'keyVersion')::integer);
    end loop;
    if t.mode = 'direct' and not exists (select 1 from public.capsule_recipients where transfer_id = t.id and user_id <> actor) then raise exception 'Choose a recipient.'; end if;
    return jsonb_build_object('id',t.id);
  elsif op = 'notifications-claim' then
    update public.capsule_notification_outbox o set done_at = now() where done_at is null and (
      not exists(select 1 from public.capsule_profiles np where np.user_id = o.user_id and np.email_notifications)
      or not exists(select 1 from public.capsule_transfers x where x.id = o.transfer_id and x.status in ('available','claimed') and x.expires_at > now()));
    with due as (select id from public.capsule_notification_outbox where done_at is null and attempts < 6 and next_at <= now() order by next_at limit 20 for update skip locked),
      claimed as (update public.capsule_notification_outbox o set attempts = attempts + 1,next_at = now() + interval '1 hour' from due where o.id = due.id returning o.id,o.user_id)
      select coalesce(jsonb_agg(row_to_json(claimed)),'[]'::jsonb) into result from claimed;
    return jsonb_build_object('items',result);
  elsif op = 'notification-done' then
    update public.capsule_notification_outbox set done_at = now() where id = (input->>'notificationId')::uuid;
    return jsonb_build_object('saved',true);
  elsif op = 'cleanup' then
    update public.capsule_transfers set status = 'expired', cleanup_after = now() + interval '10 minutes'
      where purged_at is null and cleanup_after is null and (expires_at <= now() or (status = 'uploading' and upload_until <= now()) or (status = 'claimed' and not exists(select 1 from public.capsule_leases l where l.transfer_id = capsule_transfers.id and l.expires_at > now() and not l.complete)));
    delete from public.capsule_egress where day < current_date - 7;
    select coalesce(jsonb_agg(q.id),'[]'::jsonb) into result from (select id from public.capsule_transfers where purged_at is null and cleanup_after <= now() order by cleanup_after limit 20) q;
    return jsonb_build_object('ids',result);
  end if;

  select * into t from public.capsule_transfers where id = (input->>'id')::uuid for update;
  if not found then raise exception 'Transfer unavailable.'; end if;
  if op = 'purged' then
    if t.cleanup_after is null or t.cleanup_after > now() then raise exception 'Cleanup is not due.'; end if;
    update public.capsule_transfers set purged_at = now(), manifest = null, password_box = null, access_hash = case when mode = 'link' then repeat('x',43) else null end where id = t.id;
    delete from public.capsule_parts where transfer_id = t.id;
    delete from public.capsule_leases where transfer_id = t.id;
    delete from public.capsule_recipients where transfer_id = t.id;
    return jsonb_build_object('purged',true);
  end if;
  if op in ('resume','part','confirm','finalize','revoke','delete') then
    if actor is null or actor <> t.owner_id then raise exception 'Transfer unavailable.'; end if;
    if op in ('revoke','delete') then
      if t.status <> 'deleted' then update public.capsule_transfers set status = case when op = 'delete' then 'deleted' else 'revoked' end,cleanup_after = coalesce(cleanup_after,now() + interval '10 minutes') where id = t.id; end if;
      return jsonb_build_object('status',case when t.status = 'deleted' or op = 'delete' then 'deleted' else 'revoked' end);
    end if;
    if op = 'finalize' and t.status = 'available' then return jsonb_build_object('status','available'); end if;
    if op = 'resume' and t.status = 'available' and t.expires_at > now() then return jsonb_build_object('ready',true); end if;
    if t.status <> 'uploading' or t.upload_until <= now() or t.expires_at <= now() then raise exception 'Upload session unavailable or expired.'; end if;
    if op = 'resume' then
      select jsonb_agg(jsonb_build_object('index',index,'confirmed',confirmed,'checksum',checksum) order by index) into result from public.capsule_parts where transfer_id = t.id;
      return jsonb_build_object('parts',result,'uploadUntil',t.upload_until);
    elsif op = 'finalize' then
      if exists(select 1 from public.capsule_parts where transfer_id = t.id and not confirmed) then raise exception 'Upload is incomplete.'; end if;
      update public.capsule_transfers set manifest = input->'manifest', status = 'available' where id = t.id;
      insert into public.capsule_notification_outbox(transfer_id,user_id)
        select t.id,r.user_id from public.capsule_recipients r join public.capsule_profiles np on np.user_id = r.user_id
        where r.transfer_id = t.id and r.user_id <> t.owner_id and np.email_notifications on conflict do nothing;
      return jsonb_build_object('status','available');
    end if;
    select * into part from public.capsule_parts where transfer_id = t.id and index = (input->>'index')::integer;
    if not found then raise exception 'Invalid chunk.'; end if;
    if op = 'part' then
      if part.size <> (input->>'size')::integer or (part.checksum is not null and part.checksum <> input->>'checksum') then raise exception 'Chunk does not match this upload.'; end if;
      update public.capsule_parts set checksum = input->>'checksum' where transfer_id = t.id and index = part.index;
      part.checksum := input->>'checksum';
    elsif op = 'confirm' then
      if part.checksum is null then raise exception 'Chunk has not been reserved.'; end if;
      if coalesce((input->>'verified')::boolean,false) then update public.capsule_parts set confirmed = true where transfer_id = t.id and index = part.index; end if;
    end if;
    return to_jsonb(part);
  end if;

  -- A lease is a capability issued only after account/link authorization. It is
  -- rechecked on every URL request, and all one-time claims share this row lock.
  if op in ('download','finish') then
    select * into lease from public.capsule_leases where transfer_id = t.id and token_hash = input->>'leaseHash';
    if not found or lease.expires_at <= now() or t.expires_at <= now() or t.status not in ('available','claimed','burned') then raise exception 'Download access expired or was revoked.'; end if;
    if op = 'finish' and lease.complete then return jsonb_build_object('complete',true); end if;
    if lease.complete or t.status = 'burned' then raise exception 'Download already completed.'; end if;
    if op = 'finish' then
      update public.capsule_leases set complete = true where transfer_id = t.id and token_hash = lease.token_hash;
      if t.burn then update public.capsule_transfers set status = 'burned',cleanup_after = now() + interval '10 minutes' where id = t.id; end if;
      return jsonb_build_object('complete',true);
    end if;
    select * into part from public.capsule_parts where transfer_id = t.id and index = (input->>'index')::integer and confirmed;
    if not found then raise exception 'Chunk unavailable.'; end if;
    insert into public.capsule_egress(owner_id,bytes) values(t.owner_id,part.size) on conflict(owner_id,day) do update set bytes = capsule_egress.bytes + excluded.bytes returning bytes into total;
    if total > lim.daily_download_bytes then raise exception 'Daily download quota reached.'; end if;
    return to_jsonb(part);
  end if;
  member := actor is not null and (actor = t.owner_id or exists(select 1 from public.capsule_recipients where transfer_id = t.id and user_id = actor));
  if not member and not (t.mode = 'link' and t.access_hash = coalesce(input->>'accessHash','')) then raise exception 'Transfer unavailable.'; end if;
  if t.expires_at <= now() or t.status not in ('available','claimed') then raise exception 'Transfer expired or unavailable.'; end if;
  if t.unlock_at > now() then raise exception 'This transfer is not unlocked yet.'; end if;
  if op = 'open' then
    select wrapped_key into result from (select to_jsonb(wrapped_key) as wrapped_key from public.capsule_recipients where transfer_id = t.id and user_id = actor) q;
    return jsonb_build_object('manifest',t.manifest,'passwordBox',t.password_box,'wrappedKey',result,'burn',t.burn,'bytes',t.bytes,'status',t.status);
  elsif op = 'claim' then
    select * into lease from public.capsule_leases where transfer_id = t.id and token_hash = input->>'leaseHash';
    if found and not lease.complete and lease.expires_at > now() then return jsonb_build_object('expires',lease.expires_at); end if;
    if t.status = 'claimed' then raise exception 'This one-time transfer has already been claimed.'; end if;
    insert into public.capsule_leases(transfer_id,token_hash,expires_at) values(t.id,input->>'leaseHash',least(t.expires_at,now() + interval '24 hours')) returning * into lease;
    if t.burn then update public.capsule_transfers set status = 'claimed' where id = t.id; end if;
    return jsonb_build_object('expires',lease.expires_at);
  end if;
  raise exception 'Unknown transfer operation.';
end;
$$;
revoke all on function public.capsule_transfer_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.capsule_transfer_rpc(text,uuid,jsonb) to service_role;
commit;
