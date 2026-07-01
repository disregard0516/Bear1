const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PAYMENTS_PATH = path.join(__dirname, "payments.json");
const MIN_WITHDRAWAL = 30;

let stripeClient = null;

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripeClient) {
    const Stripe = require("stripe");
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

function loadPayments() {
  try {
    const data = JSON.parse(fs.readFileSync(PAYMENTS_PATH, "utf8"));
    return {
      transactions: Array.isArray(data.transactions) ? data.transactions : [],
      withdrawals: Array.isArray(data.withdrawals) ? data.withdrawals : [],
    };
  } catch {
    return { transactions: [], withdrawals: [] };
  }
}

function savePayments(data) {
  fs.writeFileSync(PAYMENTS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function getCreatorBalance(username) {
  const store = loadPayments();
  const key = String(username || "").toLowerCase();

  const earned = store.transactions
    .filter((item) => item.creatorUsername === key && item.status === "completed")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const withdrawn = store.withdrawals
    .filter((item) => item.creatorUsername === key && item.status === "paid")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const pending = store.withdrawals
    .filter((item) => item.creatorUsername === key && (item.status === "pending" || item.status === "approved"))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const available = roundMoney(earned - withdrawn - pending);

  return {
    earned: roundMoney(earned),
    withdrawn: roundMoney(withdrawn),
    pending: roundMoney(pending),
    available: available < 0 ? 0 : available,
  };
}

function listCreatorTransactions(username, limit = 50) {
  const store = loadPayments();
  const key = String(username || "").toLowerCase();
  return store.transactions
    .filter((item) => item.creatorUsername === key)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

function listCreatorWithdrawals(username, limit = 50) {
  const store = loadPayments();
  const key = String(username || "").toLowerCase();
  return store.withdrawals
    .filter((item) => item.creatorUsername === key)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

function listAllWithdrawals(status) {
  const store = loadPayments();
  let rows = store.withdrawals.slice();
  if (status) rows = rows.filter((item) => item.status === status);
  return rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function findTransactionBySessionId(sessionId) {
  const store = loadPayments();
  return store.transactions.find((item) => item.stripeSessionId === sessionId) || null;
}

function recordCheckoutSession(session, profile) {
  const store = loadPayments();
  if (findTransactionBySessionId(session.id)) return store;

  const amount = roundMoney((session.amount_total || 0) / 100);
  store.transactions.push({
    id: newId("txn"),
    creatorUsername: profile.username,
    amount,
    currency: session.currency || "usd",
    coffeeCount: Number(session.metadata?.coffeeCount || 1),
    fanName: session.metadata?.fanName || "Supporter",
    message: session.metadata?.message || "",
    stripeSessionId: session.id,
    stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || "",
    status: "completed",
    createdAt: new Date().toISOString(),
  });
  savePayments(store);
  return store;
}

function applyRefund(paymentIntentId, amountCents) {
  const store = loadPayments();
  const amount = roundMoney(amountCents / 100);
  const match = store.transactions.find((item) => item.stripePaymentIntentId === paymentIntentId && item.status === "completed");
  if (!match) return store;

  match.status = "refunded";
  match.refundedAt = new Date().toISOString();
  store.transactions.push({
    id: newId("txn"),
    creatorUsername: match.creatorUsername,
    amount: -amount,
    currency: match.currency || "usd",
    coffeeCount: 0,
    fanName: "Refund",
    message: `Refund for ${paymentIntentId}`,
    stripeSessionId: "",
    stripePaymentIntentId: paymentIntentId,
    status: "completed",
    createdAt: new Date().toISOString(),
  });
  savePayments(store);
  return store;
}

function createWithdrawal(username, payload) {
  const key = String(username || "").toLowerCase();
  const amount = roundMoney(payload.amount);
  const balance = getCreatorBalance(key);

  if (amount < MIN_WITHDRAWAL) {
    throw new Error(`Minimum withdrawal is $${MIN_WITHDRAWAL}.`);
  }
  if (amount > balance.available) {
    throw new Error("Withdrawal amount is more than your available balance.");
  }

  const method = payload.method === "bank" ? "bank" : "paypal";
  const payoutDetails = method === "paypal"
    ? { paypalEmail: String(payload.paypalEmail || "").trim() }
    : {
        bankName: String(payload.bankName || "").trim(),
        accountName: String(payload.accountName || "").trim(),
        accountNumber: String(payload.accountNumber || "").trim(),
        routingNumber: String(payload.routingNumber || "").trim(),
      };

  if (method === "paypal" && !payoutDetails.paypalEmail) {
    throw new Error("PayPal email is required.");
  }
  if (method === "bank" && (!payoutDetails.bankName || !payoutDetails.accountName || !payoutDetails.accountNumber || !payoutDetails.routingNumber)) {
    throw new Error("Complete bank details are required.");
  }

  const store = loadPayments();
  const row = {
    id: newId("wd"),
    creatorUsername: key,
    amount,
    method,
    payoutDetails,
    status: "pending",
    adminNote: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paidAt: null,
  };
  store.withdrawals.push(row);
  savePayments(store);
  return row;
}

function updateWithdrawal(id, status, adminNote) {
  const store = loadPayments();
  const row = store.withdrawals.find((item) => item.id === id);
  if (!row) return null;

  row.status = status;
  row.adminNote = adminNote || row.adminNote || "";
  row.updatedAt = new Date().toISOString();
  if (status === "paid") row.paidAt = new Date().toISOString();
  savePayments(store);
  return row;
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3005";
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}`;
}

async function createCheckoutSession(req, profile, payload) {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripe is not configured.");

  const coffeePrice = Number(profile.coffeePrice) || 1;
  const coffeeCount = Math.max(1, Math.round(Number(payload.amount) / coffeePrice));
  const total = roundMoney(Number(payload.amount));
  if (total < coffeePrice) throw new Error("Amount is too low.");

  const baseUrl = getPublicBaseUrl(req);
  const fanName = String(payload.fanName || "").trim() || "Supporter";
  const message = String(payload.message || "").trim();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `Support ${profile.displayName}`,
            description: message || `Buy ${profile.displayName} a ${profile.coffeeLabel || "coffee"}`,
          },
          unit_amount: Math.round(total * 100),
        },
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}/${profile.username}?payment=success`,
    cancel_url: `${baseUrl}/${profile.username}?payment=cancelled`,
    metadata: {
      creatorUsername: profile.username,
      fanName: fanName.slice(0, 120),
      message: message.slice(0, 500),
      coffeeCount: String(coffeeCount),
    },
  });

  return { url: session.url, sessionId: session.id };
}

async function handleStripeWebhook(rawBody, signature) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) throw new Error("Stripe webhook is not configured.");

  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const username = String(session.metadata?.creatorUsername || "").toLowerCase();
    if (!username) return { handled: true, type: event.type };

    const profiles = JSON.parse(fs.readFileSync(path.join(__dirname, "profiles.json"), "utf8"));
    const profile = profiles[username];
    if (!profile) return { handled: true, type: event.type };

    recordCheckoutSession(session, profile);
  }

  if (event.type === "charge.refunded") {
    const charge = event.data.object;
    const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    if (paymentIntentId) applyRefund(paymentIntentId, charge.amount_refunded || charge.amount || 0);
  }

  return { handled: true, type: event.type };
}

module.exports = {
  MIN_WITHDRAWAL,
  getStripe,
  loadPayments,
  getCreatorBalance,
  listCreatorTransactions,
  listCreatorWithdrawals,
  listAllWithdrawals,
  createWithdrawal,
  updateWithdrawal,
  createCheckoutSession,
  handleStripeWebhook,
};
