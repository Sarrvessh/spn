const configured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
async function call(name, body) {
  const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.code === "P0001") throw Object.assign(new Error(data.message), { status: 409 });
    if (data.code === "23505" && body.op === "profile-save") throw Object.assign(new Error("That handle is unavailable."), { status: 409 });
    throw new Error("Transfer database is unavailable.");
  }
  return data;
}
const rpc = (op, actor, input = {}) => call("capsule_transfer_rpc", { op, actor: actor || null, input });
const accountRpc = (op, actor) => call("capsule_account_rpc", { op, actor: actor || null });
module.exports = { rpc, accountRpc, configured };
