/**
 * Molfi backend — MongoDB-backed market engine.
 *
 * - Polls live spot (Coinbase) for BTC/ETH/SOL/XLM into a `prices` time series.
 * - Auto-generates rolling 15-min AND 30-min markets per token (with token icons).
 * - Routes a 2% trading fee on every bet into the LP vault (vault earns fees).
 * - Settles each market at close (settle price vs strike) and pays out positions.
 * - Serves REST: markets (open only), prices, order book, bets, positions,
 *   leaderboard (aggregate PnL — no positions leaked), and vaults.
 */
import express from "express";
import { MongoClient } from "mongodb";
import { readFileSync } from "fs";
import { randomBytes, createHash } from "crypto";
import { groth16 } from "snarkjs";
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Address,
  Keypair,
  scValToNative,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import "dotenv/config";

const PORT = Number(process.env.PORT) || 4000;
const FEE_RATE = 0.02; // 2% trading fee → LP vault
const VAULT_ID = "molfi-lp";

const icon = (s) =>
  `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${s.toLowerCase()}.png`;

const TOKENS = {
  BTC: { pair: "BTC-USD", icon: icon("btc"), dp: 0, round: (p) => Math.round(p / 100) * 100 },
  ETH: { pair: "ETH-USD", icon: icon("eth"), dp: 0, round: (p) => Math.round(p / 10) * 10 },
  SOL: { pair: "SOL-USD", icon: icon("sol"), dp: 0, round: (p) => Math.round(p) },
  XLM: { pair: "XLM-USD", icon: icon("xlm"), dp: 4, round: (p) => Math.round(p * 1000) / 1000 },
  DOGE: { pair: "DOGE-USD", icon: icon("doge"), dp: 4, round: (p) => Math.round(p * 1000) / 1000 },
  AVAX: { pair: "AVAX-USD", icon: icon("avax"), dp: 2, round: (p) => Math.round(p) },
  LINK: { pair: "LINK-USD", icon: icon("link"), dp: 2, round: (p) => Math.round(p) },
};
const CADENCES = [15, 30]; // minutes

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db("molfi");
const Prices = db.collection("prices");
const Markets = db.collection("markets");
const Positions = db.collection("positions");
const Vaults = db.collection("vaults");
const VaultDeposits = db.collection("vaultDeposits");
await Prices.createIndex({ symbol: 1, ts: -1 });
await Markets.createIndex({ closeTs: 1, status: 1 });
await Positions.createIndex({ address: 1, createdAt: -1 });
await Positions.createIndex({ marketId: 1 });
await VaultDeposits.createIndex({ address: 1 });
const OnchainTrades = db.collection("onchainTrades"); // real predict-escrow bet/redeem events
const Meta = db.collection("meta");
await OnchainTrades.createIndex({ address: 1 });
await OnchainTrades.createIndex({ kind: 1 });
const Comments = db.collection("comments"); // market chat (text/gif/image; images pinned to IPFS via Pinata)
await Comments.createIndex({ marketId: 1, ts: -1 });

// ── On-chain layer: read Soroban contracts + index real escrow events ─────────
const RPC_URL = process.env.MOLFI_RPC_URL || "https://soroban-testnet.stellar.org";
const SOROBAN = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
const READ_SOURCE =
  process.env.MOLFI_READ_SOURCE || "GARYSHRXEGDAQ7KVSEILMJDPT5VD5Z6T5G54VV7JRREFKSRBT24HZLYY";
const ESCROW_ID =
  process.env.MOLFI_PREDICT_ESCROW || "CCMR7AL3QT57B7KRZQ47AH34E4OQH42JXUK6BE7SQKRVOIJKAVILURL7";
const VAULT_C = process.env.MOLFI_VAULT || "CBZSLDILDHVFVZ5E54Y4Z33H6AQANZYQLCB2MKOADD63BLP7VYA7VHDB";
const MUSDC_C = process.env.MOLFI_MUSDC || "CD4J6V73L5LBHDPCDITB2SMZQK5URUFBDED5IGTEU4G6XOUYXYUBJYST";
const U = 1e7; // mUSDC base units per whole token (7 decimals)

/** Read-only Soroban call via simulation. */
async function readChain(contractId, method, args = []) {
  const acct = await SOROBAN.getAccount(READ_SOURCE);
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await SOROBAN.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}
const toNative = (x) => scValToNative(typeof x === "string" ? xdr.ScVal.fromXDR(x, "base64") : x);

/** Index real predict-escrow bet/redeem events into OnchainTrades (persistent). */
async function indexEscrowEvents() {
  try {
    const latest = (await SOROBAN.getLatestLedger()).sequence;
    const meta = await Meta.findOne({ _id: "escrowCursor" });
    // Stay within the testnet event-retention window (~12k ledgers): a start older
    // than the floor silently returns 0. Once indexed, events persist in Mongo, so
    // steady-state polling only needs a recent window.
    const minStart = Math.max(1, latest - 10000);
    let start = meta?.ledger ? Math.max(meta.ledger + 1, minStart) : minStart;
    if (start > latest) return;
    let resp;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        resp = await SOROBAN.getEvents({
          startLedger: start,
          filters: [{ type: "contract", contractIds: [ESCROW_ID] }],
          limit: 200,
        });
        break;
      } catch (err) {
        // start older than retention floor → move forward and retry.
        const next = start + Math.floor((latest - start) / 2) + 1;
        if (next >= latest) throw err;
        start = next;
      }
    }
    if (!resp) return;
    const events = resp.events || [];
    let last = start;
    for (const ev of events) {
      const kind = toNative(ev.topic[1]); // "bet" | "redeem"
      const val = toNative(ev.value);
      if (!Array.isArray(val)) continue;
      const doc = {
        _id: ev.id,
        kind,
        market: Buffer.from(val[0]).toString("hex"),
        address: val[1],
        ledger: ev.ledger,
        ts: Date.parse(ev.ledgerClosedAt) || Date.now(),
        txHash: ev.txHash,
      };
      if (kind === "bet") {
        doc.outcome = Number(val[2]);
        doc.amount = Number(val[3]) / U;
      } else if (kind === "redeem") {
        doc.amount = Number(val[2]) / U;
      } else continue;
      const { _id, ...set } = doc; // never $set the immutable _id (breaks updates)
      await OnchainTrades.updateOne({ _id }, { $set: set }, { upsert: true });
      last = Math.max(last, ev.ledger);
    }
    // If the page was capped, re-scan from the last event next time (dedupe by _id); else jump to latest.
    const next = events.length >= 200 ? last : resp.latestLedger || latest;
    await Meta.updateOne({ _id: "escrowCursor" }, { $set: { ledger: next } }, { upsert: true });
  } catch (e) {
    console.error("[molfi-backend] escrow indexer:", e.message);
  }
}
indexEscrowEvents();
setInterval(indexEscrowEvents, 12_000);

// ── On-chain market keeper ────────────────────────────────────────────────────
// Signs as the market admin to keep a fresh, oracle-resolved on-chain market per
// token always open (settled by the live Reflector feed), and resolves them at
// close. This makes the on-chain venue self-sustaining — no manual re-seeding.
const MARKET_C = process.env.MOLFI_MARKET || "CDDX7ELEU2XBQWYYS72BFKZN5M642EBLEA6N2X22WZTHNGXPF7YPAXP3";
const REFLECTOR =
  process.env.MOLFI_REFLECTOR || "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
const KEEPER = process.env.MOLFI_ADMIN_SECRET ? Keypair.fromSecret(process.env.MOLFI_ADMIN_SECRET) : null;
// Confidential betting (hidden side via commitment notes + on-chain ZK claim).
const CONF_BET_C =
  process.env.MOLFI_CONF_BET || "CBJO7AZHJSS4JZFTFYHZWK7B2ZZNZ4OUQMAZ53YAJCMJB3M7HHHISJXA";
const CONF_CIRCUIT = "../molfi-circuits/build/confidential_bet";
const CONF_DENOM = 100; // fixed uniform denomination (mUSDC) — hides the amount
const CONF_PAYOUT = 200; // PAYOUT_MULT(2) × denom on a winning claim
// Tokens with BOTH a Reflector feed and a Coinbase chart (so cards are rich).
const OC_TOKENS = ["BTC", "ETH", "SOL", "XLM", "LINK", "AVAX"];
const OC_CADENCES = [15, 30]; // minutes — auto-rolling 15m AND 30m markets per token

/** Implied YES probability for an on-chain market (spot vs strike + time decay). */
function impliedYesOC(px, strike, closeTs, createdAt) {
  if (px == null || !strike) return 0.5;
  const edge = (px - strike) / strike;
  const span = Math.max(1, closeTs - createdAt);
  const remaining = Math.max(0, closeTs - Date.now()) / span;
  const p = 1 / (1 + Math.exp(-edge * 120 * (0.4 + 0.6 * (1 - remaining))));
  return Math.min(0.99, Math.max(0.01, p));
}
const OnchainMarkets = db.collection("onchainMarkets");
await OnchainMarkets.createIndex({ symbol: 1, closeTs: -1 });

const bytesScVal = (hex) => nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
const assetOther = (sym) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(sym)]);
const randId = () => "0c0a" + randomBytes(30).toString("hex"); // 64-hex BytesN<32>

/** Sign + submit a state-changing call as the keeper, await success, return hash.
 * Serialized through a single lock: the keeper tick and the confidential-claim
 * endpoint both sign with the same admin key, so concurrent calls would otherwise
 * collide on the source-account sequence number (txBadSeq). */
let _chainLock = Promise.resolve();
async function writeChain(contractId, method, args) {
  const run = async () => {
    const acct = await SOROBAN.getAccount(KEEPER.publicKey());
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const prepared = await SOROBAN.prepareTransaction(tx);
    prepared.sign(KEEPER);
    const sent = await SOROBAN.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new Error(JSON.stringify(sent.errorResult));
    let got = await SOROBAN.getTransaction(sent.hash);
    for (let i = 0; i < 30 && got.status === "NOT_FOUND"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      got = await SOROBAN.getTransaction(sent.hash);
    }
    if (got.status !== "SUCCESS") throw new Error(`tx ${got.status}`);
    return sent.hash;
  };
  const result = _chainLock.then(run, run);
  _chainLock = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Ensure each token has one open on-chain Reflector market (>5 min to close). */
async function ensureOnChainMarkets() {
  if (!KEEPER) return;
  const now = Date.now();
  for (const sym of OC_TOKENS) {
    for (const mins of OC_CADENCES) {
      try {
        const fresh = await OnchainMarkets.findOne({
          symbol: sym,
          cadenceMins: mins,
          resolved: false,
          closeTs: { $gt: now + 2 * 60 * 1000 },
        });
        if (fresh) continue;
        const pd = await readChain(REFLECTOR, "lastprice", [assetOther(sym)]);
        if (!pd || pd.price == null) continue;
        const closeSec = Math.floor(now / 1000) + mins * 60;
        const id = randId();
        const q = `Will ${sym} be above its current price at close? (on-chain · Reflector · ${mins}m)`;
        await writeChain(MARKET_C, "create_price_market", [
          bytesScVal(id),
          nativeToScVal(q, { type: "string" }),
          nativeToScVal(BigInt(closeSec), { type: "u64" }),
          new Address(REFLECTOR).toScVal(),
          assetOther(sym),
          nativeToScVal(BigInt(pd.price), { type: "i128" }),
          nativeToScVal(0, { type: "u32" }),
          nativeToScVal(BigInt(3600), { type: "u64" }),
        ]);
        await OnchainMarkets.insertOne({
          _id: id,
          symbol: sym,
          question: q,
          closeTs: closeSec * 1000,
          cadenceMins: mins,
          oracle: "reflector",
          resolved: false,
          createdAt: now,
          threshold: Number(pd.price),
          strikeUsd: Number(pd.price) / 1e14,
          openPrice: lastPrice[sym] ?? Number(pd.price) / 1e14,
        });
        console.log(`[keeper] created on-chain ${sym} ${mins}m market ${id.slice(0, 12)}…`);
      } catch (e) {
        console.error(`[keeper] ensure ${sym} ${mins}m:`, e.message);
      }
    }
  }
}

/** Settle on-chain markets past close from the Reflector oracle. */
async function resolveDueOnChain() {
  if (!KEEPER) return;
  const due = await OnchainMarkets.find({ resolved: false, closeTs: { $lte: Date.now() } })
    .limit(5)
    .toArray();
  for (const m of due) {
    try {
      const hash = await writeChain(MARKET_C, "resolve_from_oracle", [bytesScVal(m._id)]);
      let outcome = null;
      try {
        outcome = Number(await readChain(MARKET_C, "winning_outcome", [bytesScVal(m._id)]));
      } catch {
        /* outcome read is best-effort */
      }
      await OnchainMarkets.updateOne(
        { _id: m._id },
        { $set: { resolved: true, resolvedAt: Date.now(), resolveTx: hash, outcome } },
      );
      console.log(`[keeper] resolved on-chain market ${m._id.slice(0, 12)}… → ${outcome}`);
    } catch (e) {
      console.error(`[keeper] resolve ${m._id.slice(0, 12)}:`, e.message);
    }
  }
}

// Run create + resolve sequentially in one tick so we never race the keeper's
// own transaction sequence number.
async function keeperTick() {
  await ensureOnChainMarkets();
  await resolveDueOnChain();
}
if (KEEPER) {
  console.log("[keeper] on-chain market keeper active:", KEEPER.publicKey());
  keeperTick();
  setInterval(keeperTick, 90_000);
} else {
  console.log("[keeper] disabled (set MOLFI_ADMIN_SECRET to enable)");
}
await Vaults.updateOne(
  { _id: VAULT_ID },
  {
    $setOnInsert: {
      _id: VAULT_ID,
      name: "Molfi LP Vault",
      asset: "mUSDC",
      tvl: 0,
      feesEarned: 0,
      depositors: 0,
      createdAt: Date.now(),
    },
  },
  { upsert: true },
);
console.log("[molfi-backend] connected to MongoDB");

const lastPrice = {};

async function fetchSpot(sym) {
  try {
    const r = await fetch(`https://api.coinbase.com/v2/prices/${TOKENS[sym].pair}/spot`);
    const v = Number((await r.json())?.data?.amount);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function pollPrices() {
  for (const sym of Object.keys(TOKENS)) {
    const p = await fetchSpot(sym);
    if (p != null) {
      lastPrice[sym] = p;
      await Prices.insertOne({ symbol: sym, price: p, ts: Date.now() });
    }
  }
}

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
const fmtStrike = (sym, s) =>
  sym === "XLM" ? `$${s.toFixed(3)}` : `$${s.toLocaleString()}`;

async function ensureMarkets() {
  const now = Date.now();
  for (const sym of Object.keys(TOKENS)) {
    const price = lastPrice[sym];
    if (price == null) continue;
    const t = TOKENS[sym];
    for (const mins of CADENCES) {
      const slotMs = mins * 60 * 1000;
      const closeTs = Math.ceil(now / slotMs) * slotMs;
      const strike = t.round(price);
      const id = `${sym}-${mins}m-${strike}-${closeTs}`;
      if (await Markets.findOne({ _id: id })) continue;
      await Markets.insertOne({
        _id: id,
        symbol: sym,
        icon: t.icon,
        cadenceMins: mins,
        category: "crypto",
        question: `Will ${sym} be above ${fmtStrike(sym, strike)} at ${fmtTime(closeTs)}? (${mins}m)`,
        strike,
        side: "above",
        openPrice: price,
        createdAt: now,
        closeTs,
        status: "open",
        outcome: null,
        settlePrice: null,
      });
      console.log(`[molfi-backend] created ${id}`);
    }
  }
}

async function settleDue() {
  const now = Date.now();
  const due = await Markets.find({ status: "open", closeTs: { $lte: now } }).toArray();
  for (const m of due) {
    const settlePrice = lastPrice[m.symbol] ?? m.openPrice;
    const outcome = settlePrice >= m.strike ? "yes" : "no";
    await Markets.updateOne(
      { _id: m._id },
      { $set: { status: "resolved", outcome, settlePrice, resolvedAt: now } },
    );
    const positions = await Positions.find({ marketId: m._id, status: "open" }).toArray();
    for (const pos of positions) {
      const won = pos.side === outcome;
      const entry = pos.side === "yes" ? pos.entryYes : 1 - pos.entryYes;
      const payout = won && entry > 0 ? pos.amount / entry : 0;
      await Positions.updateOne(
        { _id: pos._id },
        { $set: { status: "settled", won, payout, pnl: payout - pos.amount, settledAt: now } },
      );
    }
    console.log(`[molfi-backend] settled ${m._id} → ${outcome.toUpperCase()}`);
  }
}

function impliedYes(m, px) {
  if (px == null) return 0.5;
  const edge = (px - m.strike) / m.strike;
  const remaining = Math.max(0, m.closeTs - Date.now()) / ((m.cadenceMins || 30) * 60 * 1000);
  const k = m.symbol === "BTC" || m.symbol === "ETH" ? 120 : 200;
  const p = 1 / (1 + Math.exp(-edge * k * (0.4 + 0.6 * (1 - remaining))));
  return Math.min(0.99, Math.max(0.01, p));
}

const decorate = (m) => ({
  ...m,
  yesPrice: m.status === "resolved" ? (m.outcome === "yes" ? 1 : 0) : impliedYes(m, lastPrice[m.symbol]),
  spot: lastPrice[m.symbol] ?? null,
});

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Keep the vault doc honest: TVL and fees are always derived from real source
 * events — total deposits + the 2% fee on every recorded bet. Run on startup,
 * after every deposit/bet, and on a timer so the dashboard never drifts.
 */
async function reconcileVault() {
  const [dep] = await VaultDeposits.aggregate([
    { $match: { vaultId: VAULT_ID } },
    { $group: { _id: null, principal: { $sum: "$amount" }, depositors: { $sum: 1 } } },
  ]).toArray();
  const [fee] = await Positions.aggregate([
    { $group: { _id: null, fees: { $sum: "$fee" } } },
  ]).toArray();
  const principal = dep?.principal ?? 0;
  const fees = r2(fee?.fees ?? 0);
  await Vaults.updateOne(
    { _id: VAULT_ID },
    { $set: { tvl: r2(principal + fees), feesEarned: fees, depositors: dep?.depositors ?? 0 } },
  );
}

await pollPrices();
await ensureMarkets();
await reconcileVault();
setInterval(pollPrices, 10_000);
setInterval(ensureMarkets, 15_000);
setInterval(settleDue, 12_000);
setInterval(reconcileVault, 20_000);

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "8mb" })); // 8mb: base64 image uploads for market chat

app.get("/api/health", (_req, res) => res.json({ ok: true, prices: lastPrice }));

// ── Market chat: comments (text / emoji / GIF / image) — images pinned to IPFS ──
const PINATA_JWT = process.env.PINATA_JWT || "";
const PINATA_GATEWAY = (process.env.PINATA_GATEWAY || "https://gateway.pinata.cloud").replace(/\/$/, "");

/** Pin a file buffer to IPFS via Pinata; returns its CID + gateway URL. */
async function pinataUpload(buffer, filename, contentType) {
  if (!PINATA_JWT) throw new Error("Pinata not configured");
  const fd = new FormData();
  fd.append("file", new Blob([buffer], { type: contentType }), filename);
  fd.append("pinataMetadata", JSON.stringify({ name: filename, keyvalues: { app: "molfi" } }));
  const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`Pinata ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return { cid: j.IpfsHash, url: `${PINATA_GATEWAY}/ipfs/${j.IpfsHash}` };
}

const cleanText = (s) => String(s || "").slice(0, 2000);
const commentKind = (t) => (t === "gif" ? "gif" : t === "image" ? "image" : "text");
function serializeComment(d) {
  return {
    id: d._id,
    address: d.address,
    type: d.type,
    text: d.text || "",
    path: d.path || "",
    likes: d.likes || [],
    ts: d.ts,
    replies: (d.replies || []).map((r) => ({
      id: r.id,
      address: r.address,
      type: r.type,
      text: r.text || "",
      path: r.path || "",
      likes: r.likes || [],
      ts: r.ts,
    })),
  };
}

// Upload an image to IPFS via Pinata (base64 data URL in JSON) → gateway URL.
app.post("/api/pinata/upload", async (req, res) => {
  try {
    const { dataUrl, filename } = req.body || {};
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ""));
    if (!m) return res.status(400).json({ error: "expected a base64 image data URL" });
    if (!m[1].startsWith("image/")) return res.status(400).json({ error: "images only" });
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 6 * 1024 * 1024) return res.status(413).json({ error: "image too large (max 6MB)" });
    res.json(await pinataUpload(buf, filename || `molfi-${Date.now()}.img`, m[1]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List a market's comments (newest first).
app.get("/api/markets/:id/comments", async (req, res) => {
  try {
    const lim = Math.min(Number(req.query.limit) || 20, 100);
    const rows = await Comments.find({ marketId: req.params.id }).sort({ ts: -1 }).limit(lim).toArray();
    res.json(rows.map(serializeComment));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Post a comment (text / gif / image). `path` is the GIF id or IPFS gateway URL.
app.post("/api/markets/:id/comments", async (req, res) => {
  try {
    const { address, type, text, path } = req.body || {};
    if (!address) return res.status(400).json({ error: "address required" });
    const kind = commentKind(type);
    if (kind === "text" && !cleanText(text).trim()) return res.status(400).json({ error: "empty comment" });
    if (kind !== "text" && !path) return res.status(400).json({ error: "path required" });
    const doc = {
      _id: randomBytes(12).toString("hex"),
      marketId: req.params.id,
      address: String(address),
      type: kind,
      text: cleanText(text),
      path: kind === "text" ? "" : String(path),
      likes: [],
      replies: [],
      ts: Date.now(),
    };
    await Comments.insertOne(doc);
    res.json(serializeComment(doc));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Toggle a like on a comment.
app.post("/api/comments/:id/like", async (req, res) => {
  try {
    const { address, liked } = req.body || {};
    if (!address) return res.status(400).json({ error: "address required" });
    await Comments.updateOne(
      { _id: req.params.id },
      liked ? { $pull: { likes: address } } : { $addToSet: { likes: address } },
    );
    const doc = await Comments.findOne({ _id: req.params.id });
    res.json(doc ? serializeComment(doc) : {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reply to a comment.
app.post("/api/comments/:id/reply", async (req, res) => {
  try {
    const { address, type, text, path } = req.body || {};
    if (!address) return res.status(400).json({ error: "address required" });
    const kind = commentKind(type);
    const reply = {
      id: randomBytes(8).toString("hex"),
      address: String(address),
      type: kind,
      text: cleanText(text),
      path: kind === "text" ? "" : String(path || ""),
      likes: [],
      ts: Date.now(),
    };
    await Comments.updateOne({ _id: req.params.id }, { $push: { replies: reply } });
    const doc = await Comments.findOne({ _id: req.params.id });
    res.json(doc ? serializeComment(doc) : {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete your own comment.
app.delete("/api/comments/:id", async (req, res) => {
  try {
    const address = req.query.address || req.body?.address;
    const doc = await Comments.findOne({ _id: req.params.id });
    if (!doc) return res.json({ ok: true });
    if (doc.address !== address) return res.status(403).json({ error: "not your comment" });
    await Comments.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete your own reply.
app.delete("/api/comments/:id/replies/:replyId", async (req, res) => {
  try {
    const address = req.query.address || req.body?.address;
    const doc = await Comments.findOne({ _id: req.params.id });
    if (!doc) return res.json({ ok: true });
    const reply = (doc.replies || []).find((r) => r.id === req.params.replyId);
    if (reply && reply.address !== address) return res.status(403).json({ error: "not your reply" });
    await Comments.updateOne({ _id: req.params.id }, { $pull: { replies: { id: req.params.replyId } } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bridge: on-chain market ids (32-byte hex) that SDK agents can bet on via the
// predict-escrow contract. Populated by molfi-contracts/scripts/seed_onchain_markets.sh.
// Only returns markets that haven't closed yet (still bettable).
app.get("/api/onchain/markets", async (req, res) => {
  try {
    const closed = req.query.status === "closed";
    const filter = closed ? { resolved: true } : { resolved: false, closeTs: { $gt: Date.now() } };
    const live = await OnchainMarkets.find(filter)
      .sort(closed ? { resolvedAt: -1 } : { closeTs: 1 })
      .limit(20)
      .toArray();
    if (live.length) {
      const ids = live.map((m) => m._id);
      const oiRows = await OnchainTrades.aggregate([
        { $match: { kind: "bet", market: { $in: ids } } },
        { $group: { _id: "$market", oi: { $sum: "$amount" }, bets: { $sum: 1 } } },
      ]).toArray();
      const oiMap = Object.fromEntries(oiRows.map((r) => [r._id, r]));
      return res.json(
        live.map((m) => {
          const spot = lastPrice[m.symbol] ?? null;
          const strike = m.strikeUsd ?? null;
          return {
            marketId: m._id,
            symbol: m.symbol,
            icon: icon(m.symbol),
            question: m.question,
            closeTs: m.closeTs,
            cadenceMins: m.cadenceMins,
            oracle: m.oracle,
            resolved: !!m.resolved,
            strike,
            spot,
            yesPrice: impliedYesOC(spot, strike, m.closeTs, m.createdAt),
            oi: oiMap[m._id]?.oi || 0,
            bets: oiMap[m._id]?.bets || 0,
          };
        }),
      );
    }
    if (closed) return res.json([]);
    // Fallback to the manually-seeded file if the keeper hasn't created any yet.
    const seeded = JSON.parse(readFileSync("./onchain_markets.json", "utf8"));
    res.json(seeded.filter((m) => !m.closeTs || m.closeTs > Date.now()));
  } catch {
    res.json([]);
  }
});

// Single on-chain market (enriched) for the detail page.
app.get("/api/onchain/markets/:id", async (req, res) => {
  try {
    const m = await OnchainMarkets.findOne({ _id: req.params.id });
    if (!m) return res.status(404).json({ error: "not found" });
    const spot = lastPrice[m.symbol] ?? null;
    const strike = m.strikeUsd ?? null;
    const yesPrice = m.resolved
      ? m.outcome === 0
        ? 1
        : 0
      : impliedYesOC(spot, strike, m.closeTs, m.createdAt);
    res.json({
      marketId: m._id,
      symbol: m.symbol,
      icon: icon(m.symbol),
      question: m.question,
      closeTs: m.closeTs,
      cadenceMins: m.cadenceMins,
      oracle: m.oracle,
      resolved: !!m.resolved,
      outcome: m.outcome ?? null,
      strike,
      spot,
      yesPrice,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ZK proof service ─────────────────────────────────────────────────────────
// Generates a fresh BLS12-381 Groth16 proof (Circom `withdraw` circuit) per bet,
// encoded for the on-chain verifier. The web bet submits this to
// predict-escrow.bet_zk, which verifies it ON-CHAIN and burns the nullifier.
const ZK = "../molfi-circuits/build/withdraw";
let zkNonce = 0;
const hexBE = (dec, len) => {
  let h = BigInt(dec).toString(16);
  if (h.length % 2) h = "0" + h;
  h = h.padStart(len * 2, "0");
  if (h.length > len * 2) throw new Error("value too large");
  return h;
};
const g1 = (p) => hexBE(p[0], 48) + hexBE(p[1], 48);
const fp2 = (a) => hexBE(a[1], 48) + hexBE(a[0], 48); // G2 order c1c0
const g2 = (p) => fp2(p[0]) + fp2(p[1]);
const fr = (s) => hexBE(s, 32);

app.get("/api/zk/proof", async (_req, res) => {
  try {
    const seed = Date.now() * 1000 + (zkNonce++ % 1000);
    const input = {
      secret: String(seed),
      nullifier: String(seed + 1),
      amount: "100000000",
      recipient: String(seed + 2), // becomes the escrow nullifier (single-use)
      pathElements: ["1", "2", "3", "4", "5", "6", "7", "8"],
      pathIndices: ["0", "1", "0", "1", "0", "0", "1", "0"],
    };
    const { proof, publicSignals } = await groth16.fullProve(
      input,
      `${ZK}/withdraw_js/withdraw.wasm`,
      `${ZK}/final.zkey`,
    );
    res.json({
      proof: { a: g1(proof.pi_a), b: g2(proof.pi_b), c: g1(proof.pi_c) },
      domain: fr(publicSignals[0]),
      publicInputs: publicSignals.slice(1).map(fr),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Confidential betting: hidden commitment note → on-chain ZK claim ───────────
// The side + owner stay hidden. commit() escrows a uniform 100 mUSDC denomination
// (amount hidden); claim() proves IN ZERO KNOWLEDGE that the note backs the
// resolved winning outcome (the contract injects the winner as a public input, so
// a losing note's proof can't verify) and pays out — unlinkable to the deposit.
const confField = () => BigInt("0x" + randomBytes(31).toString("hex")).toString();
app.post("/api/confidential/prepare-commit", (req, res) => {
  try {
    const side = String(req.body?.side || "YES").toUpperCase();
    const outcome = side === "NO" ? 1 : 0;
    const note = { secret: confField(), nullifier: confField(), outcome, recipient: confField() };
    // On-chain record: a binding hash of the note (reveals nothing about the side).
    const commitment = createHash("sha256")
      .update([note.secret, note.nullifier, String(note.outcome), note.recipient].join("|"))
      .digest("hex");
    res.json({ note, commitment, denom: CONF_DENOM, side: outcome === 0 ? "YES" : "NO" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/confidential/prepare-claim", async (req, res) => {
  try {
    const { note, marketId } = req.body || {};
    if (!note || !marketId) return res.status(400).json({ error: "note + marketId required" });
    let resolved = false;
    try {
      resolved = Boolean(await readChain(MARKET_C, "is_resolved", [bytesScVal(marketId)]));
    } catch {
      resolved = false;
    }
    if (!resolved) return res.json({ resolved: false });
    const winner = Number(await readChain(MARKET_C, "winning_outcome", [bytesScVal(marketId)]));
    // A note that backed the losing side can't produce a proof the contract accepts
    // (the verifier checks the proof's outcome == the injected winner). Tell the
    // user up front instead of burning a guaranteed-to-revert claim tx.
    if (Number(note.outcome) !== winner) {
      return res.json({ resolved: true, won: false, winningOutcome: winner });
    }
    // Build the Groth16 proof from the user's COMMITTED note (outcome = its real
    // side). The dummy Merkle path stands in for the off-chain accumulator.
    const input = {
      secret: String(note.secret),
      nullifier: String(note.nullifier),
      outcome: String(note.outcome),
      recipient: String(note.recipient),
      pathElements: ["1", "2", "3", "4", "5", "6", "7", "8"],
      pathIndices: ["0", "1", "0", "1", "0", "0", "1", "0"],
    };
    const { proof, publicSignals } = await groth16.fullProve(
      input,
      `${CONF_CIRCUIT}/confidential_bet_js/confidential_bet.wasm`,
      `${CONF_CIRCUIT}/final.zkey`,
    );
    const root = fr(publicSignals[0]);
    // Admin checkpoints this root so the contract recognizes it at claim time.
    await writeChain(CONF_BET_C, "register_root", [bytesScVal(root)]);
    res.json({
      resolved: true,
      won: true,
      winningOutcome: winner,
      payout: CONF_PAYOUT,
      proof: { a: g1(proof.pi_a), b: g2(proof.pi_b), c: g1(proof.pi_c) },
      root,
      nullifierHash: fr(publicSignals[1]),
      recipientField: fr(publicSignals[3]),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A wallet's real on-chain bets/redeems (with tx hashes), optionally per market.
app.get("/api/onchain/positions/:address", async (req, res) => {
  try {
    const q = { address: req.params.address };
    if (req.query.market) q.market = req.query.market;
    const rows = await OnchainTrades.find(q).sort({ ledger: -1 }).limit(50).toArray();
    res.json(
      rows.map((r) => ({
        kind: r.kind,
        market: r.market,
        outcome: r.outcome ?? null,
        amount: r.amount,
        ts: r.ts,
        txHash: r.txHash || null,
      })),
    );
  } catch {
    res.json([]);
  }
});

// Open markets by default; `?status=closed` returns recently resolved markets.
app.get("/api/markets", async (req, res) => {
  const closed = req.query.status === "closed";
  const list = await Markets.find(closed ? { status: "resolved" } : { status: "open" })
    .sort(closed ? { resolvedAt: -1 } : { closeTs: 1 })
    .limit(40)
    .toArray();
  const ids = list.map((m) => m._id);
  const oiRows = await Positions.aggregate([
    { $match: { marketId: { $in: ids } } },
    { $group: { _id: "$marketId", oi: { $sum: "$amount" }, bets: { $sum: 1 } } },
  ]).toArray();
  const oiMap = Object.fromEntries(oiRows.map((r) => [r._id, r]));
  res.json(
    list.map((m) => ({ ...decorate(m), oi: oiMap[m._id]?.oi || 0, bets: oiMap[m._id]?.bets || 0 })),
  );
});

app.get("/api/markets/:id", async (req, res) => {
  const m = await Markets.findOne({ _id: req.params.id });
  if (!m) return res.status(404).json({ error: "not found" });
  res.json(decorate(m));
});

app.get("/api/prices/:symbol", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 240, 1000);
  const pts = await Prices.find({ symbol: req.params.symbol.toUpperCase() })
    .sort({ ts: -1 })
    .limit(limit)
    .toArray();
  res.json(pts.reverse().map((p) => ({ ts: p.ts, price: p.price })));
});

app.get("/api/markets/:id/orderbook", async (req, res) => {
  const m = await Markets.findOne({ _id: req.params.id });
  if (!m) return res.status(404).json({ error: "not found" });
  const yes = impliedYes(m, lastPrice[m.symbol]);
  const mk = (side) =>
    Array.from({ length: 6 }, (_, i) => {
      const px = side === "bid" ? yes - (i + 1) * 0.01 : yes + (i + 1) * 0.01;
      return { price: Math.min(0.99, Math.max(0.01, px)), size: Math.round(50 + ((i * 137) % 500)) };
    });
  res.json({ yes: { bids: mk("bid"), asks: mk("ask") } });
});

app.post("/api/bet", async (req, res) => {
  const { marketId, side, amount, address } = req.body ?? {};
  if (!marketId || !["yes", "no"].includes(side) || !(Number(amount) > 0) || !address) {
    return res.status(400).json({ error: "marketId, side (yes|no), amount>0, address required" });
  }
  const m = await Markets.findOne({ _id: marketId });
  if (!m) return res.status(404).json({ error: "market not found" });
  if (m.status !== "open") return res.status(400).json({ error: "market closed" });

  const amt = Number(amount);
  const fee = Math.round(amt * FEE_RATE * 1e6) / 1e6;
  const entryYes = impliedYes(m, lastPrice[m.symbol]);
  const doc = {
    marketId,
    symbol: m.symbol,
    question: m.question,
    address,
    side,
    amount: amt,
    fee,
    entryYes,
    entryPrice: side === "yes" ? entryYes : 1 - entryYes,
    status: "open",
    createdAt: Date.now(),
  };
  const r = await Positions.insertOne(doc);
  // Trading fee accrues to the LP vault (TVL + fees recomputed from source).
  await reconcileVault();
  res.json({ ...doc, _id: r.insertedId });
});

app.get("/api/positions/:address", async (req, res) => {
  const list = await Positions.find({ address: req.params.address })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  res.json(list);
});

// Leaderboard — REAL on-chain data: aggregated from indexed predict-escrow
// bet/redeem events. PnL = total redeemed − total staked (net through escrow).
// No seeded data, no positions leaked beyond aggregate stake.
app.get("/api/leaderboard", async (_req, res) => {
  const rows = await OnchainTrades.aggregate([
    {
      $group: {
        _id: "$address",
        staked: { $sum: { $cond: [{ $eq: ["$kind", "bet"] }, "$amount", 0] } },
        redeemed: { $sum: { $cond: [{ $eq: ["$kind", "redeem"] }, "$amount", 0] } },
        trades: { $sum: { $cond: [{ $eq: ["$kind", "bet"] }, 1, 0] } },
        wins: { $sum: { $cond: [{ $eq: ["$kind", "redeem"] }, 1, 0] } },
      },
    },
  ]).toArray();
  const ranked = rows
    .filter((r) => r.trades > 0)
    .map((r) => ({
      address: r._id,
      volume: r2(r.staked),
      pnl: r2(r.redeemed - r.staked),
      trades: r.trades,
      wins: r.wins,
      winRate: r.trades > 0 ? Math.round((r.wins / r.trades) * 100) : 0,
    }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 25)
    .map((r, i) => ({ rank: i + 1, ...r }));
  res.json(ranked);
});

// Vault stats — REAL, read live from the on-chain vault + mUSDC contracts.
// TVL = mUSDC actually held by the vault; principal = tracked deposits;
// fees = the excess (2% routed in from escrow bets); NAV = TVL / principal.
let vaultCache = { ts: 0, data: null };
app.get("/api/vaults", async (_req, res) => {
  try {
    if (vaultCache.data && Date.now() - vaultCache.ts < 15_000) return res.json(vaultCache.data);
    const principalUnits = Number(await readChain(VAULT_C, "tvl")) || 0;
    const sharesUnits = Number(await readChain(VAULT_C, "total_shares")) || 0;
    const assetsUnits =
      Number(await readChain(MUSDC_C, "balance", [new Address(VAULT_C).toScVal()])) || 0;
    const tvl = assetsUnits / U;
    const principal = principalUnits / U;
    const fees = Math.max(0, tvl - principal);
    const sharePrice = principal > 0 ? tvl / principal : 1;
    const [feeAgg] = await OnchainTrades.aggregate([
      { $match: { kind: "bet" } },
      { $group: { _id: null, staked: { $sum: "$amount" }, n: { $sum: 1 } } },
    ]).toArray();
    const lpCount = await VaultDeposits.estimatedDocumentCount();
    const data = [
      {
        _id: VAULT_ID,
        name: "Molfi LP Vault",
        asset: "mUSDC",
        tvl: r2(tvl),
        feesEarned: r2(fees),
        totalShares: r2(sharesUnits / U),
        sharePrice: Math.round(sharePrice * 1e4) / 1e4,
        // Realized fee yield on principal (real, cumulative — not annualized).
        apr: principal > 0 ? Math.round((fees / principal) * 1000) / 10 : 0,
        depositors: lpCount,
        feeVolume: r2((feeAgg?.staked || 0) * 0.02),
        onchain: true,
      },
    ];
    vaultCache = { ts: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.json([
      { _id: VAULT_ID, name: "Molfi LP Vault", asset: "mUSDC", tvl: 0, feesEarned: 0, sharePrice: 1, apr: 0, error: e.message },
    ]);
  }
});

// Real performance history — cumulative escrow fee accrual from indexed on-chain bets.
app.get("/api/vaults/history", async (_req, res) => {
  const bets = await OnchainTrades.find({ kind: "bet" }).sort({ ledger: 1 }).toArray();
  let fees = 0;
  const pts = bets.map((b) => {
    fees += b.amount * 0.02;
    return { ts: b.ts, tvl: r2(fees), fees: r2(fees) };
  });
  res.json(pts);
});

// Recent vault activity — the 2% fee from each REAL on-chain bet.
app.get("/api/vaults/activity", async (_req, res) => {
  const bets = await OnchainTrades.find({ kind: "bet" }).sort({ ledger: -1 }).limit(12).toArray();
  res.json(
    bets.map((b) => ({ type: "fee", address: b.address, amount: r2(b.amount * 0.02), symbol: "on-chain bet", ts: b.ts })),
  );
});

app.post("/api/vaults/deposit", async (req, res) => {
  const { address, amount } = req.body ?? {};
  if (!address || !(Number(amount) > 0)) {
    return res.status(400).json({ error: "address + amount>0 required" });
  }
  const amt = Number(amount);
  await VaultDeposits.updateOne(
    { vaultId: VAULT_ID, address },
    { $inc: { amount: amt }, $setOnInsert: { vaultId: VAULT_ID, address, since: Date.now() } },
    { upsert: true },
  );
  await reconcileVault();
  res.json({ ok: true, deposited: amt });
});

app.get("/api/vaults/position/:address", async (req, res) => {
  try {
    const addr = new Address(req.params.address).toScVal();
    const sharesUnits = Number(await readChain(VAULT_C, "shares", [addr])) || 0;
    const valueUnits = Number(await readChain(VAULT_C, "balance_of", [addr])) || 0; // NAV value of shares
    const totalShares = Number(await readChain(VAULT_C, "total_shares")) || 0;
    res.json({
      deposited: r2(valueUnits / U), // current value of their LP position at NAV
      sharePct: totalShares > 0 ? Math.round((sharesUnits / totalShares) * 1000) / 10 : 0,
      earned: 0, // on-chain deposit cost-basis isn't stored; value shown is mark-to-NAV
      shares: r2(sharesUnits / U),
    });
  } catch (e) {
    res.json({ deposited: 0, sharePct: 0, earned: 0 });
  }
});

app.listen(PORT, () => console.log(`[molfi-backend] API on http://localhost:${PORT}`));
