# Molfi Predict Backend

> **The market engine, on-chain keeper, and zero-knowledge proof service behind Molfi — a crypto prediction market on Stellar/Soroban.**

## Overview

Molfi is a prediction market where users bet on whether a token (BTC, ETH, SOL, XLM, and more) will be above its price at a rolling close. This repository is the backend that keeps it running: a single Node.js service that polls live spot prices, auto-generates short-cadence markets, settles them at close, and exposes a REST API for the app.

Beyond the off-chain engine, it drives the on-chain side of the product. An always-on keeper signs as the market admin to create and oracle-resolve real Soroban markets (via the Reflector price feed), indexes escrow `bet`/`redeem` events into MongoDB, and runs a Groth16 (BLS12-381) proof service that powers both anonymous bets and fully confidential betting — where the side and the owner of a position stay hidden and payouts are proven in zero knowledge on-chain.

## Features

- **Live price engine** — polls Coinbase spot for BTC, ETH, SOL, XLM, DOGE, AVAX, and LINK into a time-series collection every 10s.
- **Auto-rolling markets** — generates fresh 15-minute and 30-minute "above the strike?" markets per token, then settles each at close against the settle price.
- **On-chain market keeper** — signs as admin to keep a live Reflector-resolved Soroban market open per token/cadence and resolves due markets from the oracle, so the on-chain venue is self-sustaining.
- **Escrow event indexer** — reads real `predict-escrow` `bet`/`redeem` contract events (with tx hashes) from Soroban and persists them, staying within the testnet event-retention window.
- **ZK proof service** — generates a fresh Groth16 / BLS12-381 proof (Circom `withdraw` circuit) per bet, encoded for the on-chain verifier that burns a single-use nullifier.
- **Confidential betting** — prepares hidden commitment notes with a uniform denomination and builds the ZK claim proof; the contract injects the resolved winner as a public input, so a losing note can't produce a verifiable claim.
- **LP vault accounting** — routes a 2% trading fee into a liquidity vault and reports TVL, share price, fees, and APR read live from the on-chain vault + mUSDC contracts.
- **On-chain leaderboard** — ranks wallets purely from indexed escrow events (PnL = redeemed − staked), leaking no individual positions.
- **Market chat** — per-market comments, replies, and likes supporting text, GIFs, and images pinned to IPFS via Pinata.

## Tech Stack

- **Runtime:** Node.js (ESM)
- **API:** Express 5
- **Database:** MongoDB (`mongodb` v7 driver)
- **Blockchain:** Stellar / Soroban via `@stellar/stellar-sdk` v16 (Reflector oracle, mUSDC, vault, predict-escrow, and confidential-bet contracts on testnet)
- **Zero-knowledge:** `snarkjs` (Groth16 over BLS12-381)
- **Config:** `dotenv`
- **External:** Coinbase spot API, Pinata (IPFS pinning)

> Note: the ZK endpoints load pre-built circuit artifacts from a sibling `molfi-circuits` repo, and the demo scripts read deployed contract addresses from a sibling `molfi-contracts` repo.

## Getting Started

### Prerequisites

- Node.js (ESM support)
- A MongoDB connection string
- Optional: a Stellar admin secret to enable the on-chain keeper, and a Pinata JWT for image uploads

### Install & run

```bash
git clone https://github.com/nickthelegend/molfi-predict-backend.git
cd molfi-predict-backend

npm install
npm run start   # node server.js — API on http://localhost:4000
```

### Environment

Create a `.env` file (only `MONGODB_URI` is strictly required to boot):

```bash
MONGODB_URI=mongodb+srv://...        # required
PORT=4000                            # optional (default 4000)

# On-chain keeper (optional — disabled if unset)
MOLFI_ADMIN_SECRET=S...              # enables market creation/resolution + confidential pool
MOLFI_RPC_URL=https://soroban-testnet.stellar.org
MOLFI_READ_SOURCE=G...               # account used for read-only simulation

# Contract IDs (sensible testnet defaults are baked in)
MOLFI_PREDICT_ESCROW=C...
MOLFI_MARKET=C...
MOLFI_REFLECTOR=C...
MOLFI_VAULT=C...
MOLFI_MUSDC=C...
MOLFI_CONF_BET=C...

# Market chat image uploads (optional)
PINATA_JWT=...
PINATA_GATEWAY=https://gateway.pinata.cloud
```

### Helper scripts

```bash
node test-connect.mjs            # verify the MongoDB connection
node zktest.mjs                  # off-chain Groth16 proof + verify sanity check
node confidential_bet_demo.mjs   # end-to-end confidential bet on testnet
```

## Project Structure

```
molfi-predict-backend/
├── server.js                 # the whole backend: price engine, keeper, ZK service, REST API
├── onchain_markets.json      # fallback seed of on-chain markets when the keeper hasn't run
├── confidential_bet_demo.mjs # end-to-end confidential-bet walkthrough on testnet
├── zktest.mjs                # off-chain proof/verify sanity check
├── test-connect.mjs          # MongoDB connectivity check
├── package.json
└── package-lock.json
```

## API surface (selected)

- `GET  /api/health` — status + latest prices
- `GET  /api/markets` — open markets (`?status=closed` for resolved)
- `GET  /api/markets/:id` · `/api/markets/:id/orderbook` · `/api/markets/:id/comments`
- `GET  /api/prices/:symbol` — price history
- `POST /api/bet` — place a bet (accrues the 2% vault fee)
- `GET  /api/onchain/markets` · `/api/onchain/positions/:address`
- `GET  /api/zk/proof` — a fresh proof for an anonymous bet
- `POST /api/confidential/prepare-commit` · `/api/confidential/prepare-claim`
- `GET  /api/vaults` · `/api/vaults/history` · `/api/vaults/activity` · `POST /api/vaults/deposit`
- `GET  /api/leaderboard`

---

Built by [nickthelegend](https://github.com/nickthelegend) · [nickthelegend.tech](https://nickthelegend.tech)
