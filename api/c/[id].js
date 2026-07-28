const { kv } = require("@vercel/kv");
const { isValidId } = require("../_lib/capsule");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(503).json({ error: "KV storage is not configured." });
  }

  const id = req.query.id;
  if (!isValidId(id)) {
    return res.status(400).json({ error: "Invalid capsule id." });
  }

  const record = await kv.get(`capsule:${id}`);
  if (!record?.envelope) {
    return res.status(404).json({ error: "Capsule not found or expired." });
  }

  if (record.burnAfterRead) {
    await kv.del(`capsule:${id}`);
  }

  return res.status(200).json({ envelope: record.envelope });
};
