const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");
const T = require("../transfer-core");
const { validate } = require("../api/transfers");
const { sameOrigin } = require("../api/session");
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";
const id = () => crypto.randomUUID();
const body = (extra = {}) => ({ id:id(),bytes:4,sizes:[4],mode:"link",accessHash:"a".repeat(43),expires:new Date(Date.now()+864e5).toISOString(),grants:[],burn:false,...extra });

test("transactional ownership, quotas, lifecycle, discovery and RLS", async (t) => {
  const db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls; create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; insert into auth.users values('${A}'),('${B}'),('${C}');`);
  await db.exec(fs.readFileSync("migrations/001_transfers.sql","utf8"));
  const rpc = async (op,actor,input = {}) => (await db.query("select capsule_transfer_rpc($1,$2,$3) as value",[op,actor,JSON.stringify(input)])).rows[0].value;
  const create = async (extra = {}, actor = A) => { const value = body(extra); await rpc("create",actor,value); return value; };
  const complete = async (value) => {
    await rpc("part",A,{id:value.id,index:0,size:20,checksum:"c".repeat(43)});
    await rpc("confirm",A,{id:value.id,index:0,verified:true});
    await rpc("finalize",A,{id:value.id,manifest:{iv:"a".repeat(16),data:"b".repeat(30)}});
  };
  await t.test("A cannot mutate B's upload by substituting its id",async () => {
    const value = await create({},B);
    for (const op of ["resume","part","confirm","finalize","revoke","delete"]) await assert.rejects(rpc(op,A,{id:value.id,index:0}),/unavailable/);
  });
  await t.test("quota reservations are atomic and cannot be bypassed by uploading twice",async () => {
    await db.exec("update capsule_limits set storage_bytes = 10");
    const first = await create(); await rpc("create",A,first);
    await create(); await assert.rejects(create(),/quota/);
    await db.exec("update capsule_limits set storage_bytes = 50000000000");
  });
  await t.test("incomplete or substituted chunks cannot finalize",async () => {
    const value = await create();
    await assert.rejects(rpc("finalize",A,{id:value.id,manifest:{}}),/incomplete/);
    await rpc("part",A,{id:value.id,index:0,size:20,checksum:"c".repeat(43)});
    await assert.rejects(rpc("part",A,{id:value.id,index:0,size:20,checksum:"d".repeat(43)}),/does not match/);
    await assert.rejects(rpc("part",A,{id:value.id,index:1,size:20,checksum:"c".repeat(43)}),/Invalid chunk/);
  });
  await t.test("one-time lease is exclusive, resumable, and burns only after completion",async () => {
    const value = await create({burn:true}); await complete(value);
    const input = {id:value.id,accessHash:value.accessHash,leaseHash:"l".repeat(43)};
    await rpc("open",null,input); await rpc("open",null,input);
    await rpc("claim",null,input); await rpc("claim",null,input);
    await assert.rejects(rpc("claim",null,{...input,leaseHash:"m".repeat(43)}),/already been claimed/);
    await rpc("download",null,{...input,index:0});
    assert.equal((await rpc("open",null,input)).status,"claimed");
    await rpc("finish",null,input); await rpc("finish",null,input);
    await assert.rejects(rpc("download",null,{...input,index:0}),/completed/);
    await assert.rejects(rpc("open",null,input),/unavailable/);
  });
  await t.test("revoke blocks active download leases and delete is idempotent",async () => {
    const value = await create(); await complete(value);
    const input = {id:value.id,accessHash:value.accessHash,leaseHash:"l".repeat(43)};
    await rpc("claim",null,input); await rpc("revoke",A,{id:value.id});
    await assert.rejects(rpc("download",null,{...input,index:0}),/revoked/);
    await rpc("delete",A,{id:value.id}); await rpc("delete",A,{id:value.id});
    await assert.rejects(rpc("purged",null,{id:value.id}),/not due/);
    await db.query("update capsule_transfers set cleanup_after = now() - interval '1 second' where id = $1",[value.id]);
    assert.ok((await rpc("cleanup",null)).ids.includes(value.id));
    await rpc("purged",null,{id:value.id});
    assert.equal((await db.query("select count(*) as n from capsule_parts where transfer_id = $1",[value.id])).rows[0].n,0);
  });
  await t.test("expiry and scheduled unlock are server enforced",async () => {
    const value = await create({unlock:new Date(Date.now()+3600e3).toISOString()}); await complete(value);
    await assert.rejects(rpc("open",A,{id:value.id}),/not unlocked/);
    await db.query("update capsule_transfers set unlock_at = null,expires_at = now() - interval '1 second' where id = $1",[value.id]);
    await assert.rejects(rpc("open",A,{id:value.id}),/expired/);
  });
  await t.test("direct delivery exposes only an opted-in exact handle and its recipient grant",async () => {
    for (const [user,handle,discoverable] of [[A,"alice",false],[B,"bob",true],[C,"charlie",false]]) await rpc("profile-save",user,{handle,displayName:handle,discoverable,emailNotifications:true,publicKey:{kty:"RSA"},privateKey:{iv:"encrypted"}});
    await assert.rejects(rpc("discover",A,{handle:"charlie"}),/unavailable/);
    await assert.rejects(rpc("discover",A,{handle:"bo"}),/unavailable/);
    const found = await rpc("discover",A,{handle:"bob"}); assert.equal(found.userId,B); assert.equal(found.private_key,undefined);
    const value = await create({mode:"direct",accessHash:null,grants:[{userId:B,keyVersion:1,wrappedKey:"k".repeat(512)}]}); await complete(value);
    assert.equal((await rpc("open",B,{id:value.id})).wrappedKey,"k".repeat(512));
    await assert.rejects(rpc("open",C,{id:value.id}),/unavailable/);
    await assert.rejects(rpc("open",null,{id:value.id}),/unavailable/);
    assert.equal((await rpc("list",B,{folder:"received"})).items.length,1);
    assert.equal((await rpc("list",C,{folder:"received"})).items.length,0);
    const queue = await rpc("notifications-claim",null);
    assert.equal(queue.items.length,1); assert.equal(queue.items[0].user_id,B);
    assert.equal((await rpc("notifications-claim",null)).items.length,0,"claimed email is not immediately delivered twice");
    await rpc("notification-done",null,{notificationId:queue.items[0].id});
  });
  await t.test("public roles cannot execute the service RPC or read private tables",async () => {
    await db.exec("set role authenticated");
    await assert.rejects(db.query("select * from capsule_profiles"),/permission denied/);
    await assert.rejects(rpc("list",A,{folder:"sent"}),/permission denied/);
    await db.exec("reset role; set role anon");
    await assert.rejects(db.query("select * from capsule_parts"),/permission denied/);
    await db.exec("reset role");
  });
  await db.close();
});

test("chunked upload retries, refresh recovery, reconstruction and corruption detection",async () => {
  const originalFetch = global.fetch;
  const objects = new Map(), confirmed = new Set(); let failures = 1, manifestBox, writes = 0, reads = 0, peakRead = 0;
  const bytes = new Uint8Array(T.CHUNK_SIZE + 23); bytes.fill(77);
  const file = new File([bytes],"test.bin");
  const source = {name:file.name,type:file.type,size:file.size,slice:(a,b) => { reads++; peakRead = Math.max(peakRead,b-a); return file.slice(a,b); }};
  const session = await T.prepare([source]);
  const api = async (action,input) => {
    if (action === "resume") return {parts:[...confirmed].map((index) => ({index,confirmed:true}))};
    if (action === "part" || action === "download") return {url:`https://test.invalid/${input.index}`,headers:{}};
    if (action === "confirm") { confirmed.add(input.index); return {}; }
    if (action === "finalize") manifestBox = input.manifest;
    return {};
  };
  global.fetch = async (url,options = {}) => {
    const index = Number(new URL(url).pathname.slice(1));
    if (options.method === "PUT") { if (failures-- > 0) throw new TypeError("network disconnected"); objects.set(index,options.body.slice(0)); return new Response(""); }
    return new Response(objects.get(index));
  };
  try {
    await T.upload([source],session,{api,save:async () => { writes++; }});
    assert.equal(objects.size,2); assert.ok(writes >= 2); assert.ok(reads >= 4); assert.ok(peakRead <= T.CHUNK_SIZE);
    const restored = JSON.parse(JSON.stringify(session)); await T.validateFiles([source],restored);
    const count = reads; await T.upload([source],restored,{api,save:async () => {}}); assert.equal(reads,count,"confirmed parts are not uploaded again");
    const key = await T.importKey(T.decode(session.key)), manifest = await T.readManifest(key,manifestBox,session.id), out = [];
    await T.download(manifest,key,{api,sinks:[{write:async (p) => out.push(new Uint8Array(p)),close:async () => {}}]});
    assert.deepEqual(new Uint8Array(await new Blob(out).arrayBuffer()),bytes);
    const corrupt = new Uint8Array(objects.get(0)); corrupt[0] ^= 1; objects.set(0,corrupt);
    const controller = new AbortController(); let aborted = false;
    // Integrity failures are permanent: retry helper is separately tested with no real waits.
    const broken = structuredClone(manifest); broken.parts[0].cipherHash = "x".repeat(43);
    setTimeout(() => controller.abort(),50);
    await assert.rejects(T.download(broken,key,{api,signal:controller.signal,sinks:[{write:async () => assert.fail("corrupt data written"),abort:async () => {aborted=true;}}]}));
    assert.equal(aborted,true);
    await assert.rejects(T.validateFiles([new File([new Uint8Array(file.size)],file.name)],session),/changed/);
  } finally { global.fetch = originalFetch; }
});
test("5 GB limit, bounded slices, invalid manifest and cancellation",async () => {
  await assert.rejects(T.prepare([{size:5e9+1}]),/5 GB/);
  await assert.rejects(T.prepare([]),/1 and 64/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(T.prepare([new File(["data"],"a")],{signal:controller.signal}),{name:"AbortError"});
  const s = await T.prepare([new File([""],"empty")]); assert.equal(s.parts.length,1); assert.equal(s.parts[0].size,0);
  assert.throws(() => T.validateManifest({version:1,id:s.id,files:[],parts:[]},s.id),/Invalid/);
});
test("recipient key wrapping and password/vault isolation",async () => {
  const a = await T.createVault("correct horse battery"), b = await T.createVault("another vault password");
  const raw = T.random(32), wrapped = await T.wrap(raw,a.publicKey);
  const key = await T.unwrap(wrapped,await T.unlockVault(a.privateKey,"correct horse battery"));
  const encrypted = await T.seal(await T.importKey(raw),{secret:"private"},"test");
  assert.deepEqual(await T.unseal(key,encrypted,"test"),{secret:"private"});
  await assert.rejects(T.unwrap(wrapped,await T.unlockVault(b.privateKey,"another vault password")));
  await assert.rejects(T.unlockVault(a.privateKey,"incorrect password"));
  const box = await T.protectKey(raw,"a link password here");
  assert.deepEqual(await T.recoverKey(box,"a link password here"),raw);
  await assert.rejects(T.recoverKey(box,"wrong link password"));
});
test("transfer API strips privileged flags, rejects unsafe keys, and session requires same origin",() => {
  const identifier = id();
  assert.deepEqual(validate("confirm",{id:identifier,index:0,verified:true}),{id:identifier,index:0});
  assert.throws(() => validate("create",{...body(),access:"a".repeat(43),bytes:5e9+1}),/5 GB/);
  assert.throws(() => validate("profile-save",{handle:"valid",displayName:"A",discoverable:true,publicKey:{kty:"RSA",d:"private"}}),/public key/);
  const saved = process.env.PUBLIC_APP_URL; process.env.PUBLIC_APP_URL = "https://capsule.example";
  assert.equal(sameOrigin({headers:{origin:"https://attacker.example"}}),false);
  assert.equal(sameOrigin({headers:{origin:"https://capsule.example"}}),true);
  if (saved === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = saved;
});
test("retry backoff is bounded and authorization failures are not retried",async () => {
  let tries = 0, waits = 0;
  await T.retry(async () => { if (++tries < 3) throw new Error("offline"); },null,async () => { waits++; });
  assert.equal(tries,3); assert.equal(waits,2);
  tries = 0;
  await assert.rejects(T.retry(async () => { tries++; throw Object.assign(new Error("denied"),{status:403}); },null,async () => {}),/denied/);
  assert.equal(tries,1);
});
