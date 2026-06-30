// End-to-end CONFIDENTIAL bet on Stellar testnet — the side + owner stay hidden.
//
// Honest temporal order (a bet placed while the market is OPEN, claimed after it
// resolves — never the other way round):
//   1. create a market (mock oracle, closes in ~75s)
//   2. a FRESH bettor wallet faucets mUSDC and commits TWO hidden notes
//      (uniform denom escrow; the side + owner are never revealed on-chain)
//   3. admin checkpoints the off-chain Merkle root
//   4. market closes -> oracle resolves YES (outcome 0)
//   5. the bettor CLAIMS with a ZK proof: the verifier checks ON-CHAIN that a
//      note in the tree backs the *resolved winning outcome* (the contract injects
//      the winner as a public input, so a losing note can't prove), burns the
//      nullifier, and pays out — unlinkable to the deposit.
//
// Re-runnable with the backend keeper LIVE: the bettor uses its own keypair (no
// seq race), and the 4 admin txns retry on txBadSeq. Run from molfi-backend
// (has snarkjs + stellar-sdk + .env with MOLFI_ADMIN_SECRET).
import { rpc, Contract, TransactionBuilder, BASE_FEE, Networks, Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { groth16 } from "snarkjs";
import { readFileSync } from "fs";

const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const tenv = Object.fromEntries(readFileSync("../molfi-contracts/deploy/testnet.env", "utf8").split("\n").filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const S = new rpc.Server("https://soroban-testnet.stellar.org");
const ADMIN = Keypair.fromSecret(env.MOLFI_ADMIN_SECRET);   // deploys/creates/resolves (admin-gated)
const BETTOR = Keypair.random();                            // hidden bettor — its own seq, no keeper race
const { CONF_BET, MARKET, MOCK_ORACLE, MUSDC } = tenv;
const CIRC = "../molfi-circuits/build/confidential_bet";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = (hex) => nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
const hexBE = (d, n) => { let h = BigInt(d).toString(16); if (h.length % 2) h = "0" + h; return h.padStart(n * 2, "0"); };
const g1 = (p) => hexBE(p[0], 48) + hexBE(p[1], 48);
const fp2 = (a) => hexBE(a[1], 48) + hexBE(a[0], 48);
const g2 = (p) => fp2(p[0]) + fp2(p[1]);
const fr = (s) => hexBE(s, 32);
const assetOther = (s) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(s)]);

// Submit + confirm a contract call, retrying on sequence collisions (so the demo
// survives the backend keeper signing with the same admin key concurrently).
async function send(c, m, args, signer = ADMIN) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const a = await S.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(a, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }).addOperation(new Contract(c).call(m, ...args)).setTimeout(60).build();
      const p = await S.prepareTransaction(tx); p.sign(signer);
      const s = await S.sendTransaction(p);
      if (s.status === "ERROR") {
        const e = JSON.stringify(s.errorResult);
        if (/badSeq|bad_seq|tryAgain|TRY_AGAIN/i.test(e) && attempt < 5) { await sleep(1500 + attempt * 700); continue; }
        throw new Error(m + " submit: " + e);
      }
      let g = await S.getTransaction(s.hash);
      for (let i = 0; i < 40 && g.status === "NOT_FOUND"; i++) { await sleep(1000); g = await S.getTransaction(s.hash); }
      if (g.status !== "SUCCESS") {
        const x = g.resultXdr?.toXDR?.("base64") || "";
        if (/badSeq/i.test(x) && attempt < 5) { await sleep(1500 + attempt * 700); continue; }
        throw new Error(m + " tx " + g.status + " " + x);
      }
      return s.hash;
    } catch (err) {
      lastErr = err;
      if (/badSeq|bad_seq|tryAgain|try_again/i.test(String(err.message)) && attempt < 5) { await sleep(1500 + attempt * 700); continue; }
      throw err;
    }
  }
  throw lastErr;
}

// ── 1. Confidential note (outcome 0 = YES) + its ZK proof ──────────────────────
const seed = Date.now();
const input = { secret: String(seed), nullifier: String(seed + 1), outcome: "0", recipient: String(seed + 2), pathElements: ["1", "2", "3", "4", "5", "6", "7", "8"], pathIndices: ["0", "1", "0", "1", "0", "0", "1", "0"] };
const { proof, publicSignals } = await groth16.fullProve(input, `${CIRC}/confidential_bet_js/confidential_bet.wasm`, `${CIRC}/final.zkey`);
const proofScVal = xdr.ScVal.scvMap([["a", g1(proof.pi_a)], ["b", g2(proof.pi_b)], ["c", g1(proof.pi_c)]].map(([k, h]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: bytes(h) })));
const root = fr(publicSignals[0]), nullHash = fr(publicSignals[1]), recipientField = fr(publicSignals[3]);
console.log("note: outcome=YES (hidden) | root", root.slice(0, 12), "| nullifierHash", nullHash.slice(0, 12));

// ── Fund the fresh bettor (friendbot XLM) ──────────────────────────────────────
console.log("bettor:", BETTOR.publicKey());
const fb = await fetch(`https://friendbot.stellar.org/?addr=${BETTOR.publicKey()}`);
if (!fb.ok && fb.status !== 400) throw new Error("friendbot " + fb.status);
for (let i = 0; i < 20; i++) { try { await S.getAccount(BETTOR.publicKey()); break; } catch { await sleep(1000); } }

// ── 2. Create a market that closes in ~75s ─────────────────────────────────────
const now = Math.floor(Date.now() / 1000), close = now + 75;
const MKT = "cf01" + Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString("hex");
const txCreate = await send(MARKET, "create_price_market", [bytes(MKT), nativeToScVal("Confidential: will BTC be >= 60000?", { type: "string" }), nativeToScVal(BigInt(close), { type: "u64" }), new Address(MOCK_ORACLE).toScVal(), assetOther("BTC"), nativeToScVal(6000000000000000000n, { type: "i128" }), nativeToScVal(0, { type: "u32" }), nativeToScVal(3600n, { type: "u64" })]);
console.log("market created (open) | create", txCreate.slice(0, 10));

// ── 3. Bettor faucets + commits TWO hidden notes while the market is OPEN ──────
await send(MUSDC, "faucet", [new Address(BETTOR.publicKey()).toScVal()], BETTOR);
const c1 = await send(CONF_BET, "commit", [new Address(BETTOR.publicKey()).toScVal(), bytes(nullHash)], BETTOR);
const c2 = await send(CONF_BET, "commit", [new Address(BETTOR.publicKey()).toScVal(), bytes(fr(String(seed + 9)))], BETTOR);
console.log("committed 2 hidden notes | tx", c1.slice(0, 10), c2.slice(0, 10));

// ── 4. Admin checkpoints the off-chain Merkle root ─────────────────────────────
const txRoot = await send(CONF_BET, "register_root", [bytes(root)]);

// ── 5. Market closes -> oracle resolves YES (outcome 0) ────────────────────────
while (Math.floor(Date.now() / 1000) <= close) await sleep(2000);
await send(MOCK_ORACLE, "set_price", [nativeToScVal(7000000000000000000n, { type: "i128" })]);
const txResolve = await send(MARKET, "resolve_from_oracle", [bytes(MKT)]);
console.log("market resolved YES (outcome 0) | resolve", txResolve.slice(0, 10));

// ── 6. Bettor CLAIMS with the ZK proof — winning side proven on-chain, never revealed ──
const txClaim = await send(CONF_BET, "claim", [bytes(MKT), proofScVal, bytes(nullHash), new Address(BETTOR.publicKey()).toScVal(), bytes(recipientField), bytes(root)], BETTOR);
console.log("\n✅ CONFIDENTIAL CLAIM SUCCESS — winning side proven on-chain, never revealed.");
console.log("  CONF_MARKET     =", MKT);
console.log("  CONF_BETTOR     =", BETTOR.publicKey());
console.log("  TX_CONF_CREATE  =", txCreate);
console.log("  TX_CONF_COMMIT  =", c1);
console.log("  TX_CONF_COMMIT2 =", c2);
console.log("  TX_CONF_ROOT    =", txRoot);
console.log("  TX_CONF_RESOLVE =", txResolve);
console.log("  TX_CONF_CLAIM   =", txClaim);
