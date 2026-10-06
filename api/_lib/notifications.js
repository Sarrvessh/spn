const { getKv, withRedisLock } = require("./kv");
async function enqueueNotification(record, receiptId) {
  if (!record.notificationEmail) return;
  const kv = getKv();
  const id = require("crypto").createHash("sha256").update(`${record.tokenHash}:${receiptId}`).digest("hex");
  await kv.set(`notification:${id}`, { to: record.notificationEmail, attempts: 0 }, { ex: 7 * 86400 });
  await kv.zadd("notification-queue", { score: Date.now(), member: id });
}
async function deliverNotifications() {
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFICATION_FROM) return 0;
  const kv = getKv(); let sent = 0;
  const ids = await kv.zrange("notification-queue", 0, Date.now(), { byScore: true, count: 20, offset: 0 });
  for (const id of ids || []) {
    await withRedisLock(kv, `lock:notification:${id}`, async () => {
      const item = await kv.get(`notification:${id}`);
      if (!item) { await kv.zrem("notification-queue", id); return; }
      try {
        const response = await fetch("https://api.resend.com/emails", { signal: AbortSignal.timeout(8000), method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `capsule-response/${id}` }, body: JSON.stringify({ from: process.env.NOTIFICATION_FROM, to: [item.to], subject: "A private reply arrived in Capsule", text: "A new encrypted response is available. Open your Capsule workspace to review it. This email contains no response content or private links." }) });
        if (!response.ok) throw new Error("Delivery failed");
        await kv.del(`notification:${id}`); await kv.zrem("notification-queue", id); sent++;
      } catch {
        item.attempts++;
        if (item.attempts >= 5) { await kv.del(`notification:${id}`); await kv.zrem("notification-queue", id); }
        else { await kv.set(`notification:${id}`, item, { ex: 7 * 86400 }); await kv.zadd("notification-queue", { score: Date.now() + 300000, member: id }); }
      }
    });
  }
  return sent;
}
module.exports = { enqueueNotification, deliverNotifications };
