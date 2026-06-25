const WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1516474263266398280/EysYSuovGzrOae0FSnsIwU_xWgQW52VGMJLSTa1QUAc1dtwwERb0nQoFNSufQfAGfUvP";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      res.status(502).json({ message: `Discord rejected order: ${text}` });
      return;
    }

    res.status(200).json({ message: "Order sent" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
