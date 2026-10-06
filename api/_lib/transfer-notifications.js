const { rpc } = require("./transfer-db");
async function deliver() {
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFICATION_FROM || !process.env.PUBLIC_APP_URL) return { sent:0,failed:0 };
  const queue = await rpc("notifications-claim",null);
  let sent = 0, failed = 0;
  for (const item of queue.items) {
    try {
      const identity = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/,"")}/auth/v1/admin/users/${item.user_id}`, { signal:AbortSignal.timeout(8000), headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`} });
      if (!identity.ok) throw new Error("Identity unavailable");
      const user = await identity.json();
      if (!user.email || !user.email_confirmed_at) { await rpc("notification-done",null,{notificationId:item.id}); continue; }
      const response = await fetch("https://api.resend.com/emails", {method:"POST",signal:AbortSignal.timeout(8000),headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":`capsule-received-${item.id}`},body:JSON.stringify({from:process.env.NOTIFICATION_FROM,to:[user.email],subject:"You received a Capsule",text:`A private capsule is waiting in your inbox.\n\nOpen Capsule: ${new URL('/workspace',process.env.PUBLIC_APP_URL).href}\n\nYou can turn off these emails in your Capsule identity settings.`})});
      if (!response.ok) throw new Error("Delivery unavailable");
      await rpc("notification-done",null,{notificationId:item.id}); sent++;
    } catch { failed++; }
  }
  return {sent,failed};
}
module.exports = { deliver };
