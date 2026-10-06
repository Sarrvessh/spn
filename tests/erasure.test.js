const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
test("account erasure endpoint requires same origin, a fresh password and verified actor ownership", async () => {
  const modules = ["../api/_lib/account", "../api/_lib/kv", "../api/_lib/transfer-db", "../api/_lib/transfer-storage", "../api/session", "../api/erase-account"].map(require.resolve);
  const previous = modules.map((name) => require.cache[name]), origin = process.env.PUBLIC_APP_URL, cron = process.env.CRON_SECRET;
  process.env.PUBLIC_APP_URL = "https://capsule.example"; process.env.CRON_SECRET = "test-cron";
  const calls = [];
  require.cache[modules[0]] = {exports:{configured:()=>true,user:async (req)=> { if (!req.headers.authorization) throw Object.assign(new Error("Sign in first"),{status:401}); return {id:A,email:"a@example.test"}; },auth:async (path,body)=> { if (path.startsWith("token") && body.password !== "correct password") throw Object.assign(new Error("wrong"),{status:401}); return {access_token:"fresh",user:{id:A}}; }}};
  require.cache[modules[1]] = {exports:{isKvConfigured:()=>true,getKv:()=>({eval:async()=>1})}};
  require.cache[modules[2]] = {exports:{configured:()=>true,accountRpc:async (op,actor)=> { calls.push({op,actor}); return {pending:true}; }}};
  require.cache[modules[3]] = {exports:{configured:()=>true}};
  delete require.cache[modules[4]]; delete require.cache[modules[5]];
  const handler = require("../api/erase-account");
  const invoke = async (body,headers={}) => { const res = {statusCode:200,headers:{},setHeader(name,value){this.headers[name]=value;},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}}; await handler({method:"POST",headers:{origin:"https://capsule.example",authorization:"Bearer access",...headers},body},res); return res; };
  try {
    const body = {action:"request",password:"correct password",confirmation:"DELETE",userId:B};
    assert.equal((await invoke(body,{origin:"https://evil.example"})).statusCode,403);
    assert.equal((await invoke({...body,password:"wrong"})).statusCode,401); assert.equal(calls.length,0);
    assert.equal((await invoke({...body,confirmation:"yes"})).statusCode,400);
    assert.equal((await invoke(body,{authorization:""})).statusCode,401);
    const accepted = await invoke(body); assert.equal(accepted.statusCode,202); assert.deepEqual(calls,[{op:"request",actor:A}]); assert.match(accepted.headers["Set-Cookie"],/HttpOnly/); assert.equal(accepted.body.access_token,undefined);
  } finally { modules.forEach((name,index)=> { if(previous[index]) require.cache[name]=previous[index]; else delete require.cache[name]; }); if(origin===undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL=origin; if(cron===undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET=cron; }
});
test("account erasure revokes immediately, waits for purge, prevents new writes, and isolates other owners", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls; create function auth.uid() returns uuid language sql stable as $$select null::uuid$$; insert into auth.users values('${A}'),('${B}');`);
    await db.exec(fs.readFileSync("migrations/001_transfers.sql", "utf8"));
    await db.exec(fs.readFileSync("migrations/002_account_erasure.sql", "utf8"));
    const rpc = async (op, actor, input = {}) => (await db.query("select capsule_transfer_rpc($1,$2,$3) as value", [op, actor, JSON.stringify(input)])).rows[0].value;
    const erase = async (op, actor = A) => (await db.query("select capsule_account_rpc($1,$2) as value", [op, actor])).rows[0].value;
    const create = async (owner) => { const id = crypto.randomUUID(); await rpc("create", owner, {id,bytes:4,sizes:[4],mode:"link",accessHash:"a".repeat(43),expires:new Date(Date.now()+864e5).toISOString(),grants:[],burn:false}); return id; };
    const a = await create(A), b = await create(B);
    await rpc("profile-save", A, { handle:"private_person", displayName:"Private person", discoverable:true, emailNotifications:true, publicKey:{n:"key"}, privateKey:{data:"encrypted"} });
    await db.exec("set role service_role");
    assert.equal((await erase("status")).pending, false);
    assert.equal((await erase("request")).pending, true); await erase("request");
    assert.equal((await rpc("profile",A)).discoverable,false);
    await assert.rejects(rpc("profile-save",A,{handle:"new_handle",displayName:"New name",publicKey:{},privateKey:{}}),/deletion is pending/);
    assert.equal((await db.query("select status from capsule_transfers where id=$1",[a])).rows[0].status, "deleted");
    assert.equal((await db.query("select status from capsule_transfers where id=$1",[b])).rows[0].status, "uploading");
    await assert.rejects(create(A), /deletion is pending/);
    await create(B);
    await assert.rejects(erase("prepare"), /incomplete/);
    assert.deepEqual((await erase("claim",null)).users, []);
    await db.exec(`update capsule_transfers set cleanup_after=now()-interval '1 minute' where id='${a}'`);
    await rpc("purged",null,{id:a});
    assert.deepEqual((await erase("claim",null)).users,[A]);
    assert.deepEqual((await erase("claim",null)).users,[],"worker claim excludes another active worker");
    await erase("prepare");
    await db.exec("reset role");
    await db.exec(`delete from auth.users where id='${A}'`);
    assert.equal((await db.query("select count(*)::int as count from capsule_erasure_requests")).rows[0].count,0);
    assert.equal((await db.query("select count(*)::int as count from capsule_transfers where owner_id=$1",[B])).rows[0].count,2);
    await db.exec("set role anon");
    await assert.rejects(erase("request",B),/permission denied/);
    await assert.rejects(db.query("select * from capsule_erasure_requests"),/permission denied/);
  } finally { await db.close(); }
});
