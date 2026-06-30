import { groth16 } from "snarkjs";
import { readFileSync } from "fs";
const CIRC = "../molfi-circuits/build/withdraw";
const seed = Date.now();
const input = { secret: String(seed), nullifier: String(seed+1), amount: "100000000", recipient: String(seed+2), pathElements:["1","2","3","4","5","6","7","8"], pathIndices:["0","1","0","1","0","0","1","0"] };
const { proof, publicSignals } = await groth16.fullProve(input, `${CIRC}/withdraw_js/withdraw.wasm`, `${CIRC}/final.zkey`);
const vkey = JSON.parse(readFileSync(`${CIRC}/vkey.json`));
const ok = await groth16.verify(vkey, publicSignals, proof);
console.log("off-chain verify:", ok, "| publicSignals:", publicSignals.length);
