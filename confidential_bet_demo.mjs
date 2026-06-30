// End-to-end CONFIDENTIAL bet on Stellar testnet — the side + owner stay hidden.
//   1. generate a commitment note (secret, nullifier, outcome=YES) + a ZK proof
//   2. create + oracle-resolve a market YES
//   3. commit 2 hidden notes (escrow mUSDC; sides never revealed on-chain)
//   4. register the Merkle root checkpoint
//   5. claim with the ZK proof — the verifier checks ON-CHAIN that a note in the
//      tree backs the winning outcome, burns the nullifier, pays out
// Run from molfi-backend (has snarkjs + stellar-sdk + .env). Keeper should be off
// to avoid molfi tx-seq races: stop the backend server first.
import { rpc, Contract, TransactionBuilder, BASE_FEE, Networks, Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { groth16 } from "snarkjs";
import { readFileSync } from "fs";

const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const tenv = Object.fromEntries(readFileSync("../molfi-contracts/deploy/testnet.env", "utf8").split("\n").filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const S = new rpc.Server("https://soroban-testnet.stellar.org");
const KP = Keypair.fromSecret(env.MOLFI_ADMIN_SECRET);
const { CONF_BET, MARKET, MOCK_ORACLE, MUSDC } = tenv;
const CIRC = "../molfi-circuits/build/confidential_bet";

const bytes = (hex) => nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
const hexBE = (d, n) => { let h = BigInt(d).toString(16); if (h.length % 2) h = "0" + h; return h.padStart(n * 2, "0"); };
const g1 = (p) => hexBE(p[0], 48) + hexBE(p[1], 48);
const fp2 = (a) => hexBE(a[1], 48) + hexBE(a[0], 48);
const g2 = (p) => fp2(p[0]) + fp2(p[1]);
const fr = (s) => hexBE(s, 32);
const assetOther = (s) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(s)]);
async function send(c, m, args) {
  const a = await S.getAccount(KP.publicKey());
  const tx = new TransactionBuilder(a, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }).addOperation(new Contract(c).call(m, ...args)).setTimeout(60).build();
  const p = await S.prepareTransaction(tx); p.sign(KP);
  const s = await S.sendTransaction(p);
  if (s.status === "ERROR") throw new Error(m + " submit: " + JSON.stringify(s.errorResult));
  let g = await S.getTransaction(s.hash);
  for (let i = 0; i < 40 && g.status === "NOT_FOUND"; i++) { await new Promise((r) => setTimeout(r, 1000)); g = await S.getTransaction(s.hash); }
  if (g.status !== "SUCCESS") throw new Error(m + " tx " + g.status + " " + (g.resultXdr?.toXDR?.("base64") || ""));
  return s.hash;
}

// 1. Confidential note (outcome 0 = YES) + ZK proof.
const seed = Date.now();
const input = { secret: String(seed), nullifier: String(seed + 1), outcome: "0", recipient: String(seed + 2), pathElements: ["1","2","3","4","5","6","7","8"], pathIndices: ["0","1","0","1","0","0","1","0"] };
const { proof, publicSignals } = await groth16.fullProve(input, `${CIRC}/confidential_bet_js/confidential_bet.wasm`, `${CIRC}/final.zkey`);
const proofScVal = xdr.ScVal.scvMap([["a", g1(proof.pi_a)], ["b", g2(proof.pi_b)], ["c", g1(proof.pi_c)]].map(([k, h]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: bytes(h) })));
const root = fr(publicSignals[0]), nullHash = fr(publicSignals[1]), recipientField = fr(publicSignals[3]);
console.log("note: outcome=YES (hidden) | root", root.slice(0, 12), "| nullifierHash", nullHash.slice(0, 12));

// 2. Create + resolve a YES market via the mock oracle (deterministic).
const now = Math.floor(Date.now() / 1000), close = now + 75;
const MKT = "cf01" + Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString("hex");
await send(MOCK_ORACLE, "set_price", [nativeToScVal(7000000000000000000n, { type: "i128" })]);
const txCreate = await send(MARKET, "create_price_market", [bytes(MKT), nativeToScVal("Confidential: will BTC be >= 60000?", { type: "string" }), nativeToScVal(BigInt(close), { type: "u64" }), new Address(MOCK_ORACLE).toScVal(), assetOther("BTC"), nativeToScVal(6000000000000000000n, { type: "i128" }), nativeToScVal(0, { type: "u32" }), nativeToScVal(3600n, { type: "u64" })]);
while (Math.floor(Date.now() / 1000) <= close) await new Promise((r) => setTimeout(r, 2000));
const txResolve = await send(MARKET, "resolve_from_oracle", [bytes(MKT)]);
console.log("market resolved YES (outcome 0) | create", txCreate.slice(0, 10), "resolve", txResolve.slice(0, 10));

// 3. Commit two hidden notes (escrow 2×denom so the pot covers the payout).
await send(MUSDC, "faucet", [new Address(KP.publicKey()).toScVal()]).catch(() => {});
const c1 = await send(CONF_BET, "commit", [new Address(KP.publicKey()).toScVal(), bytes(nullHash)]);
const c2 = await send(CONF_BET, "commit", [new Address(KP.publicKey()).toScVal(), bytes(fr(String(seed + 9)))]);
console.log("committed 2 hidden notes | tx", c1.slice(0, 10), c2.slice(0, 10));

// 4. Register the off-chain Merkle root.
const txRoot = await send(CONF_BET, "register_root", [bytes(root)]);

// 5. Claim with the ZK proof — side proven == winner, on-chain, without revealing it.
const txClaim = await send(CONF_BET, "claim", [bytes(MKT), proofScVal, bytes(nullHash), new Address(KP.publicKey()).toScVal(), bytes(recipientField), bytes(root)]);
console.log("\n✅ CONFIDENTIAL CLAIM SUCCESS — winning side proven on-chain, never revealed.");
console.log("  TX_CONF_CREATE  =", txCreate);
console.log("  TX_CONF_RESOLVE =", txResolve);
console.log("  TX_CONF_COMMIT  =", c1);
console.log("  TX_CONF_ROOT    =", txRoot);
console.log("  TX_CONF_CLAIM   =", txClaim);
