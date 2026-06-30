# Polymarket Trading Reference (`trading-info`)

> **Purpose:** Accurate, code-grounded reference for building automated trading (e.g. BTC 5-minute up/down bots) on Polymarket using patterns from this repo.
>
> **Source of truth:** Live code under `apps/web/src/lib/`, `apps/api/`, `packages/shared/`.  
> **Not authoritative:** `POLYMARKET_INTEGRATION.md` at repo root — it describes an older/different project layout.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Bot infrastructure (headless prerequisites)](#2-bot-infrastructure-headless-prerequisites)
3. [Wallet architecture](#3-wallet-architecture)
4. [Source file map](#4-source-file-map)
5. [NPM packages](#5-npm-packages)
6. [Environment variables](#6-environment-variables)
7. [External APIs & proxies](#7-external-apis--proxies)
8. [On-chain contracts](#8-on-chain-contracts)
9. [Deposits](#9-deposits)
10. [Withdrawals](#10-withdrawals)
11. [Opening trades (buy)](#11-opening-trades-buy)
12. [Closing trades (sell / exit)](#12-closing-trades-sell--exit)
13. [Positions & balances](#13-positions--balances)
14. [CLOB authentication](#14-clob-authentication)
15. [Relayer & builder signing](#15-relayer--builder-signing)
16. [Limit orders at exact prices](#16-limit-orders-at-exact-prices)
17. [Stop losses](#17-stop-losses)
18. [Order cancellation](#18-order-cancellation)
19. [Market discovery (Gamma API)](#19-market-discovery-gamma-api)
20. [Production gotchas](#20-production-gotchas)
21. [Adapting for a BTC 5-minute bot](#21-adapting-for-a-btc-5-minute-bot)
22. [End-to-end bot checklist](#22-end-to-end-bot-checklist)

---

## 1. Executive summary

This app trades on Polymarket via three layers:

| Layer | Role |
|-------|------|
| **EOA** | Signs EIP-712 (relayer batches, CLOB L1 API key derivation) |
| **Polymarket Safe (Gnosis)** | Receives bridge deposits, holds pUSD/USDC.e, wrap/unwrap/withdraw |
| **Deposit wallet** | **Actual CLOB trading wallet** — `POLY_1271` signature type |

**Critical rule (current code):** All bets and exits use the **deposit wallet**, not the Safe directly.

```
Bridge / wrap → Safe (pUSD)
Enable betting → move pUSD Safe → deposit wallet + approve exchanges
Trade → CLOB market order (FAK) from deposit wallet
Exit → sell outcome tokens from deposit wallet
Withdraw → unwrap pUSD in Safe → USDC.e to任意 address
```

**What this repo implements:**

| Feature | Status |
|---------|--------|
| Bridge deposit (multi-chain) | ✅ UI copy-address flow |
| Wrap USDC.e → pUSD | ✅ |
| Enable betting (deposit wallet deploy + approve) | ✅ |
| Market buy (FAK) | ✅ `placeMarketOrder` |
| Market sell / exit (FAK) | ✅ `placeExitOrder` |
| **Limit buy/sell at exact price (GTC/GTD)** | ❌ not in repo — [§16](#16-limit-orders-at-exact-prices) |
| **Stop loss at exact trigger price** | ❌ not native — [§17](#17-stop-losses) (monitor + submit) |
| Cancel limit orders | ❌ not in repo — [§18](#18-order-cancellation) |
| Read open limit orders | ✅ `fetchOpenLimitOrders()` |
| Redeem resolved positions on-chain | ❌ not implemented — [§12.4](#124-resolved-positions), [§2.8](#28-btc-5m-bot--honest-gaps) |

**Market scope today:** FIFA World Cup 2026 (`tag_id=102232`, slugs `fifwc-*`). **No BTC 5-minute market code exists yet** — [§21](#21-adapting-for-a-btc-5-minute-bot) explains how to add it.

**Headless bot?** Start with [§2 Bot infrastructure](#2-bot-infrastructure-headless-prerequisites) — wallet model, contracts, auth, relayer, Data API, proxy gotcha, and gaps to build.

---

## 2. Bot infrastructure (headless prerequisites)

Single reference for everything a **headless BTC / automated bot** needs beyond strategy logic. Deeper dives live in later sections (linked inline).

### 2.1 Wallet model: EOA → Safe → deposit wallet (`POLY_1271`)

Polymarket trading in this repo uses **three on-chain identities** derived from one Polygon EOA:

```
EOA (private key)
  ├─ deriveSafe()           → Polymarket Gnosis Safe     (bridge, wrap, withdraw)
  └─ deriveDepositWallet()  → Deposit wallet (CREATE2)   (CLOB trading funder)
```

| Wallet | Role | CLOB `SignatureTypeV2` |
|--------|------|------------------------|
| **EOA** | Signs EIP-712 for relayer batches + CLOB L1 API key derivation | `EOA` (not used for live trades) |
| **Safe** | Receives bridge deposits; holds USDC.e / pUSD; wrap/unwrap/withdraw | `POLY_GNOSIS_SAFE` (not used for live trades) |
| **Deposit wallet** | Holds pUSD collateral + outcome ERC-1155; all buys/sells | **`POLY_1271`** |

**Critical rule:** CLOB orders must use `funder: { type: 'depositWallet', depositWalletAddress }` + `POLY_1271`. Trading from the Safe directly returns *"Maker address not allowed"*.

**Funding path:**

```
Bridge → Safe (USDC.e / pUSD)
enableDepositWalletBetting() → deploy deposit wallet + move pUSD + approve exchanges
placeMarketOrder() / placeExitOrder() → CLOB from deposit wallet
withdraw → sweep deposit wallet → Safe → unwrap → USDC.e out
```

Files: `polymarket-safe.ts`, `polymarket-relayer.ts`, `polymarket-deposit-wallet.ts`, `polymarket-trading.ts` → `createPolymarketClobClient()`.  
Full diagram: [§3.4](#34-diagram).

### 2.2 Contract addresses (Polygon mainnet)

From `apps/web/src/lib/polymarket-contracts.ts` and `polymarket-safe.ts`:

| Name | Address | Notes |
|------|---------|-------|
| **USDC.e** | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | Bridged USDC on Polygon |
| **pUSD** (CLOB collateral) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` | Approve to all spenders below |
| **Collateral onramp** (wrap) | `0x93070a847efEf7F70739046A929D47a521F5B8ee` | USDC.e → pUSD in Safe |
| **Collateral offramp** (unwrap) | `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` | pUSD → USDC.e |
| **CTF** (ERC-1155 outcomes) | `0x4d97dcd97ec945f40cf65f87097ace5ea0476045` | Outcome tokens |
| **CTF Exchange** | `0xE111180000d2663C0091e4f400237545B87B996B` | Standard binary markets |
| **Neg-risk exchange** | `0xe2222d279d744050d28e00520010520000310F59` | `negRisk: true` markets |
| **Neg-risk adapter** | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | Neg-risk routing |
| **CTF collateral adapter** | `0xAdA100Db00Ca00073811820692005400218FcE1f` | pUSD spender |
| **Neg-risk CTF collateral adapter** | `0xadA2005600Dec949baf300f4C6120000bDB6eAab` | pUSD spender |
| **Safe factory** | `0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b` | `deriveSafe(eoa, factory)` |
| **Deposit wallet factory** | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` | CREATE2 proxy |
| **Deposit wallet implementation** | `0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB` | UUPS logic |

**Approvals required before trading** (`enableDepositWalletBetting`):

- **pUSD** `approve` → all addresses in `PUSD_SPENDERS` (exchanges + adapters)
- **CTF** `setApprovalForAll` → all addresses in `CTF_OPERATORS`

Always pass `negRisk` from Gamma metadata into order calls — wrong flag → rejected orders.

### 2.3 CLOB authentication (L1 + L2)

| Level | Who signs | What you get | Used for |
|-------|-----------|--------------|----------|
| **L1** | EOA EIP-712 | `{ key, secret, passphrase }` via `createOrDeriveApiKey()` | One-time key derivation |
| **L2** | HMAC with API creds | Signed REST headers on every CLOB request | Orders, balances, open orders |

**Browser (this app):** `polymarket-trading.ts` caches creds in `sessionStorage` (`gamekart_clob_creds_${eoa}`), clears + re-derives on HMAC errors.

**Headless bot:**

```typescript
import { ClobClient } from '@polymarket/clob-client-v2';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';

const account = privateKeyToAccount(process.env.BOT_PRIVATE_KEY as `0x${string}`);
const signer = createWalletClient({ account, chain: polygon, transport: http() });

const bootstrap = new ClobClient({
  host: 'https://clob.polymarket.com',  // direct — no Vite proxy
  chain: polygon.id,
  signer,
  useServerTime: true,
});
const creds = await bootstrap.createOrDeriveApiKey();
// Persist creds to disk/DB; reuse until invalidated

const client = new ClobClient({
  host: 'https://clob.polymarket.com',
  chain: polygon.id,
  signer,
  creds,
  signatureType: SignatureTypeV2.POLY_1271,
  funderAddress: depositWalletAddress,
  useServerTime: true,
});
```

Details: [§14](#14-clob-authentication).

### 2.4 Gasless relayer + server-side builder HMAC

On-chain setup (Safe deploy, wrap, deposit wallet deploy, approvals) is **gas-sponsored** via Polymarket's builder relayer. The user's EOA only signs EIP-712 payloads — no POL needed for normal flows.

```
Bot / browser                Your API server              Polymarket relayer
     │                              │                              │
     │  RelayClient needs           │                              │
     │  builder HMAC headers        │                              │
     ├─ POST /builder-sign ────────►│ BuilderSigner.create...()    │
     │  { method, path, body }      │  uses POLY_BUILDER_SECRET    │
     │◄──── { POLY_BUILDER_* } ─────┤                              │
     │                              │                              │
     ├─ RelayClient.execute() ─────────────────────────────────────►│
     │  (EIP-712 user sig + builder headers)                        │
```

**Server endpoint** (`apps/api/src/routes/polymarket-builder.ts`):

```http
POST /api/polymarket/builder-sign
Authorization: Bearer {POLY_BUILDER_SIGN_TOKEN}   # optional
Content-Type: application/json

{ "method": "POST", "path": "/submit", "body": "...", "timestamp": 1710000000 }
```

**Server env** (`apps/api/.env` — never expose to client/bot bundle):

| Variable | Purpose |
|----------|---------|
| `POLY_BUILDER_API_KEY` | Builder program key |
| `POLY_BUILDER_SECRET` | HMAC secret (quote in `.env` if value contains `=`) |
| `POLY_BUILDER_PASSPHRASE` | Builder passphrase |
| `POLY_BUILDER_SIGN_TOKEN` | Optional Bearer auth on builder-sign route |

**Client wiring** (`polymarket-relayer.ts`):

```typescript
new BuilderConfig({
  remoteBuilderConfig: {
    url: getPolymarketBuilderSignUrl(),   // e.g. http://127.0.0.1:8787/api/polymarket/builder-sign
    token: getPolymarketBuilderSignToken(),
  },
});
```

**Bot requirement:** Run the same builder-sign service (copy `apps/api` route or embed `BuilderSigner` in your bot process). Without valid builder creds, `executeSafeBatchGasless` and deposit wallet deploy fail with 401/503.

Details: [§15](#15-relayer--builder-signing).

### 2.5 Positions & portfolio value (Data API)

The CLOB tracks orders and balances; **open positions and PnL** come from Polymarket's **Data API** (separate host from CLOB/Gamma).

| Endpoint | Purpose | Code |
|----------|---------|------|
| `GET /positions?user={address}` | Open outcome positions (size, avgPrice, curPrice, redeemable) | `fetchPolymarketPositionsForWallets()` |
| `GET /value?user={address}` | Total portfolio USD value | `fetchPolymarketValueForWallets()` |

**Query all wallets that may hold tokens:**

```typescript
await fetchPolymarketPositionsForWallets([
  depositWalletAddress,  // primary — CLOB trades land here
  safeAddress,
  eoaAddress,
]);
```

**Lag after fills:** Data API can trail CLOB by seconds. Retry schedule in code:

```typescript
POSITION_REFRESH_RETRY_MS = [2_000, 5_000, 12_000, 25_000]
```

**Position fields the bot cares about:**

| Field | Use |
|-------|-----|
| `asset` | Outcome `tokenID` for sells / book queries |
| `size` | Shares held |
| `proxyWallet` | Which deposit wallet holds the position |
| `negativeRisk` | Pass to `createAndPostOrder` / exit |
| `redeemable` | Market resolved — needs on-chain redeem (not in repo) |
| `curPrice` | Stop-loss / take-profit monitoring |

Details: [§13](#13-positions--balances).

### 2.6 Vite proxy ordering gotcha (dev + production)

The web app proxies third-party APIs under `/api/*` to avoid CORS. **Proxy rule order matters.**

From `apps/web/vite.config.ts`:

```typescript
proxy: {
  // MUST be first — longer prefix before shorter
  '/api/polymarket-data': { target: 'https://data-api.polymarket.com', ... },
  '/api/polymarket':      { target: 'https://gamma-api.polymarket.com', ... },
  '/api/clob':            { target: 'https://clob.polymarket.com', ... },
  '/api/bridge':          { target: 'https://bridge.polymarket.com', ... },
  '/api/gamekart':        { target: 'http://127.0.0.1:8787', ... },
}
```

**Failure mode:** If `/api/polymarket` is registered **before** `/api/polymarket-data`, requests to `/api/polymarket-data/positions` match the shorter prefix and get rewritten to `gamma-api.polymarket.com/data/positions` → **404**. Symptoms: empty positions, zero portfolio value, silent UI failures.

**Production:** Apply the same ordering in nginx/Caddy/Cloudflare — declare `/api/polymarket-data` **before** `/api/polymarket`. See `DOCUMENTATION.md` deploy checklist.

**Headless bot:** Call upstream hosts **directly** (no proxy). Use the URLs in [§2.7](#27-direct-urls-for-headless-bots).

### 2.7 Direct URLs for headless bots

| Service | Production URL | This repo (browser dev) |
|---------|----------------|-------------------------|
| CLOB REST | `https://clob.polymarket.com` | `/api/clob` |
| Gamma metadata | `https://gamma-api.polymarket.com` | `/api/polymarket` |
| Data API (positions) | `https://data-api.polymarket.com` | `/api/polymarket-data` |
| Bridge | `https://bridge.polymarket.com` | `/api/bridge` |
| Relayer | `https://relayer-v2.polymarket.com` | `VITE_POLY_RELAYER_URL` |
| CLOB WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | direct (not proxied) |
| Builder sign | your server `POST .../builder-sign` | `/api/gamekart/polymarket/builder-sign` |

Set `host` / `fetch` base URLs to production endpoints in bot code. Only the web app needs Vite proxies.

### 2.8 BTC 5m bot — honest gaps (what this repo does NOT implement)

The infrastructure above is **reusable as-is**. The following trading features are **documented but not coded** — you must build them for a BTC 5-minute bot:

| Gap | What exists today | What you need to build |
|-----|-------------------|------------------------|
| **1. GTC limit orders + cancel** | Only **FAK market** orders: `placeMarketOrder`, `placeExitOrder`. Read-only `fetchOpenLimitOrders()`. | `client.createAndPostOrder(..., OrderType.GTC)` + `client.cancelOrder()` / `cancelMarketOrders()`. See [§16](#16-limit-orders-at-exact-prices), [§18](#18-order-cancellation). For 5m windows you likely want resting entries, take-profits, and `cancelMarketOrders` on expiry. |
| **2. On-chain redeem** | Data API sets `redeemable: true`; Portfolio **History** tab filters them. **No `redeemPositions` tx** in repo. | If you hold through resolution instead of selling to close, call CTF `redeemPositions` (via Safe or deposit wallet batch) to convert winning shares → pUSD. See [§12.4](#124-resolved-positions). |
| **3. Market discovery** | FIFA-only: `tag_id=102232`, slugs `fifwc-*`, `mapGammaEvent()` in `polymarket.ts`. | Replace Gamma filter for **BTC up/down 5m** markets. **Verify outcome names** (`"Up"`/`"Down"` vs `"Yes"`/`"No"`) map to the correct `clobTokenIds[0]` / `[1]` before calling `placeMarketOrder`. See [§19](#19-market-discovery-gamma-api), [§21](#21-adapting-for-a-btc-5-minute-bot). |

Also not native (bot-side logic): **stop-loss triggers** — Polymarket has no stop order type; monitor book + submit exit ([§17](#17-stop-losses)).

---

## 3. Wallet architecture

### 3.1 Derivation

| Wallet | How derived | File |
|--------|-------------|------|
| **Safe** | `deriveSafe(eoa, SAFE_FACTORY)` | `polymarket-safe.ts` |
| **Deposit wallet** | `deriveDepositWallet(eoa, FACTORY, IMPLEMENTATION)` | `polymarket-relayer.ts` |
| **Resolved deposit wallet** | UUPS address if deployed, else beacon | `polymarket-positions.ts` → `resolveDepositWalletAddress()` |

```typescript
// Safe factory
SAFE_FACTORY_ADDRESS = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b'

// Deposit wallet
DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07'
DEPOSIT_WALLET_IMPLEMENTATION = '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB'
```

### 3.2 Signature types for CLOB

From `polymarket-trading.ts` → `createPolymarketClobClient()`:

| Funder | `SignatureTypeV2` | `funderAddress` |
|--------|-------------------|-----------------|
| `{ type: 'eoa' }` | `EOA` | EOA |
| `{ type: 'safe', safeAddress }` | `POLY_GNOSIS_SAFE` | Safe |
| `{ type: 'depositWallet', depositWalletAddress }` | **`POLY_1271`** | Deposit wallet |

**All live trading in this app uses `depositWallet` + `POLY_1271`.**

### 3.3 Balance model

`usePmWallet` aggregates:

```typescript
balances.pusd = depositWalletPusd + safePusd   // "available to bet"
balances.usdce  = safe USDC.e
balances.usdceEoa = EOA USDC.e
```

Trading collateral for CLOB lives in the **deposit wallet** after "Enable betting". The Safe holds funds between deposits and withdrawals.

### 3.4 Diagram

```
                    ┌─────────────────────────────────────┐
                    │  EOA (Polygon, signs EIP-712)        │
                    │  - CLOB L1 API key (createOrDerive) │
                    │  - Relayer batch signatures         │
                    └──────────┬──────────────┬───────────┘
                               │              │
              deriveSafe()     │              │  deriveDepositWallet()
                               ▼              ▼
                    ┌──────────────┐   ┌──────────────────────┐
                    │ Polymarket   │   │ Deposit wallet        │
                    │ Safe         │   │ (POLY_1271 funder)    │
                    │              │   │                       │
                    │ Bridge lands │   │ pUSD for CLOB         │
                    │ USDC.e/pUSD  │──►│ Approvals to exchange │
                    │ Wrap/unwrap  │   │ Outcome ERC-1155      │
                    │ Withdraw     │   │ Market orders         │
                    └──────────────┘   └──────────────────────┘
                               ▲
                               │ Polymarket Bridge API
                               │ (evm / svm / btc / tvm rails)
```

---

## 4. Source file map

### 4.1 Core trading & wallets (`apps/web/src/lib/`)

| File | Responsibility |
|------|----------------|
| `env.ts` | CLOB, Gamma, Data API, relayer, builder-sign URLs |
| `polymarket-contracts.ts` | Token & exchange addresses, ABIs, `BRIDGE_MIN_DEPOSIT_USD` |
| `polymarket-safe.ts` | Safe derivation, Polygon RPC client, deploy check, POL gas guard |
| `polymarket-trading-helpers.ts` | Safe meta-tx builders: wrap, unwrap, approve pUSD + CTF |
| `polymarket-safe-wallet.ts` | Safe balances, gasless Safe batch, wrap, withdraw |
| `polymarket-relayer.ts` | `RelayClient`, gasless Safe deploy/execute, deposit wallet sweep |
| `polymarket-deposit-wallet.ts` | Deploy deposit wallet, approve, fund before trade |
| `polymarket-trading.ts` | **CLOB client, market buy/sell, open orders fetch** |
| `polymarket-positions.ts` | Data API positions/value, deposit wallet resolution |
| `polymarket-bridge.ts` | Bridge deposit addresses, status polling, supported assets |
| `polymarket.ts` | Gamma API — event/market mapping (FIFA-specific today) |
| `polymarket-wallet-provider.ts` | WaaS EIP-712 `chainId` normalization for Dynamic |
| `bridge-evm-deposit.ts` | EVM ERC-20 transfer helper (**not wired in UI**) |
| `pending-deposit.ts` | localStorage for in-flight bridge deposits |
| `errors.ts` | Human-readable wallet/CLOB errors |

### 4.2 UI entry points

| File | Trading action |
|------|----------------|
| `components/DepositModal.tsx` | Bridge → wrap → enable betting |
| `components/WithdrawModal.tsx` | Unwrap pUSD → USDC.e |
| `pages/MarketDetailPage.tsx` | `placeMarketOrder` (buy) |
| `pages/PortfolioPage.tsx` | Positions, `placeExitOrder`, `fetchOpenLimitOrders`, recover stranded funds |
| `hooks/usePmWallet.ts` | Wallet state, `getWalletClient()` |
| `hooks/useDepositWatch.ts` | Bridge status polling |

### 4.3 Backend (`apps/api/`)

| File | Responsibility |
|------|----------------|
| `routes/polymarket-builder.ts` | `POST /api/polymarket/builder-sign` — HMAC headers for relayer |
| `services/polymarket-builder.ts` | `BuilderSigner` from env creds |

---

## 5. NPM packages

From `apps/web/package.json`:

```json
"@polymarket/builder-relayer-client": "^0.0.10",
"@polymarket/builder-signing-sdk": "^0.0.8",
"@polymarket/clob-client-v2": "^1.0.6",
"@safe-global/protocol-kit": "...",
"viem": "..."
```

| Package | Used for |
|---------|----------|
| `@polymarket/clob-client-v2` | `ClobClient`, market orders, order book, API keys, open orders |
| `@polymarket/builder-relayer-client` | Gasless Safe + deposit wallet txs |
| `@polymarket/builder-signing-sdk` | Remote builder HMAC signing |
| `viem` | Polygon reads, wallet client, encoding |

---

## 6. Environment variables

### 6.1 Frontend (`apps/web/.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_POLY_CLOB_HOST` | `/api/clob` | CLOB REST (proxied in dev) |
| `VITE_GAMMA_BASE_URL` | `/api/polymarket` | Gamma metadata |
| `VITE_POLYMARKET_DATA_URL` | `/api/polymarket-data` | Positions, trades, value |
| `VITE_POLY_RELAYER_URL` | `https://relayer-v2.polymarket.com` | Gasless txs |
| `VITE_POLY_BUILDER_CODE` | — | Optional bytes32 builder attribution on orders |
| `VITE_POLY_BUILDER_SIGN_URL` | `/api/gamekart/polymarket/builder-sign` | Server-side HMAC |
| `VITE_POLY_BUILDER_SIGN_TOKEN` | — | Bearer auth for builder-sign |
| `VITE_POLYGON_RPC` | public Polygon RPC | On-chain reads (must be CORS-safe in browser) |
| `VITE_GAMEKART_API_URL` | `/api/gamekart` | App backend |

### 6.2 Backend (`apps/api/.env`)

| Variable | Purpose |
|----------|---------|
| `POLY_BUILDER_API_KEY` | Builder program credentials |
| `POLY_BUILDER_SECRET` | |
| `POLY_BUILDER_PASSPHRASE` | |
| `POLY_BUILDER_SIGN_TOKEN` | Optional auth on builder-sign endpoint |

**For a headless bot:** Run builder signing on your server (same as `apps/api`). Never expose `POLY_BUILDER_SECRET` in client code.

---

## 7. External APIs & proxies

### 7.1 Vite dev proxies (`apps/web/vite.config.ts`)

| Browser path | Upstream |
|--------------|----------|
| `/api/clob/*` | `https://clob.polymarket.com` |
| `/api/polymarket/*` | `https://gamma-api.polymarket.com` |
| `/api/polymarket-data/*` | `https://data-api.polymarket.com` |
| `/api/bridge/*` | `https://bridge.polymarket.com` |
| `/api/gamekart/*` | `http://127.0.0.1:8787/api` |

> **Order matters:** `/api/polymarket-data` must be registered **before** `/api/polymarket`.  
> Full failure mode + production nginx note: [§2.6](#26-vite-proxy-ordering-gotcha-dev--production).

### 7.2 Key REST endpoints used

| API | Endpoint | Purpose |
|-----|----------|---------|
| **CLOB** | `GET /book?token_id=` | Order book |
| **CLOB** | `POST` market order via SDK | `createAndPostMarketOrder` |
| **CLOB** | `GET /data/orders` (via SDK `getOpenOrders`) | Open limit orders |
| **CLOB** | Auth via SDK `createOrDeriveApiKey` | L2 HMAC credentials |
| **Gamma** | `GET /events?tag_id=&slug=` | Market discovery |
| **Gamma** | `GET /markets?slug=` | Single market |
| **Data** | `GET /positions?user=` | Open positions |
| **Data** | `GET /value?user=` | Portfolio value |
| **Data** | `GET /trades` | Public trade history |
| **Bridge** | `POST /deposit` | Deposit addresses for Safe |
| **Bridge** | `GET /status/:address` | Bridge tx status |
| **Relayer** | via SDK | Gasless Safe / deposit wallet |

### 7.3 WebSocket

```typescript
// polymarket.ts
export const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
```

Defined but **not used** in current trading flows. Useful for a BTC bot (live book / trades).

---

## 8. On-chain contracts

From `polymarket-contracts.ts` (Polygon mainnet):

| Name | Address |
|------|---------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| pUSD (collateral) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| Collateral onramp (wrap) | `0x93070a847efEf7F70739046A929D47a521F5B8ee` |
| Collateral offramp (unwrap) | `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` |
| CTF (ERC-1155 outcomes) | `0x4d97dcd97ec945f40cf65f87097ace5ea0476045` |
| CTF Exchange | `0xE111180000d2663C0091e4f400237545B87B996B` |
| Neg-risk exchange | `0xe2222d279d744050d28e00520010520000310F59` |
| Neg-risk adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |

**pUSD must be approved to all `PUSD_SPENDERS`.**  
**CTF must be `setApprovalForAll` for all `CTF_OPERATORS`.**

`negRisk: true` on a market → order must pass `negRisk: true` to `createAndPostMarketOrder` (already done in `placeMarketOrder` / `placeExitOrder`).

---

## 9. Deposits

### 9.1 Overview — three phases

1. **Fund the Safe** (bridge or transfer)
2. **Wrap** USDC.e → pUSD (if needed)
3. **Enable betting** — deploy deposit wallet, move pUSD, approve exchanges

### 9.2 Phase 1 — Bridge deposit

**Files:** `polymarket-bridge.ts`, `DepositModal.tsx`, `useDepositWatch.ts`

```typescript
// 1. Get per-rail deposit addresses FOR THE SAFE (not EOA)
const { address } = await createBridgeDepositAddresses(safeAddress);
// address: { evm?, svm?, btc?, tvm? }

// 2. User sends funds externally to the chosen rail address
//    Minimum ~$10 (BRIDGE_MIN_DEPOSIT_USD)

// 3. Poll until complete
const txs = await fetchBridgeDepositTransactions(depositAddress);
// Status: PENDING → DEPOSIT_DETECTED → ... → COMPLETED | FAILED
```

**BTC rail:** `bridgeRailForChain` maps Bitcoin chain id `8253038` → rail `'btc'`. Bridge credits the **Safe** on Polygon.

**Note:** `depositEvmTransfer()` in `bridge-evm-deposit.ts` can send ERC-20 from user's wallet to bridge address programmatically — **not used by current UI** (copy-address only).

### 9.3 Phase 2 — Wrap USDC.e → pUSD

**Files:** `polymarket-safe-wallet.ts`, `polymarket-trading-helpers.ts`

```typescript
await wrapUsdcEToPusdInSafe({ walletClient, safeAddress, amountUsdc });
```

**On-chain steps (gasless Safe batch via relayer):**

1. `USDC.e.approve(COLLATERAL_ONRAMP, amount)`
2. `COLLATERAL_ONRAMP.wrap(USDC_E, safeAddress, amount)` → pUSD minted to Safe

**If USDC.e is only on EOA:**

```typescript
await assertGasForSafeTx(eoa);  // needs ~0.02 POL on EOA
await transferUsdcEToSafe(walletClient, safeAddress, amount);
await wrapUsdcEToPusdInSafe(...);
```

### 9.4 Phase 3 — Enable betting (deposit wallet)

**Files:** `polymarket-deposit-wallet.ts`, `DepositModal.tsx`

```typescript
await enableDepositWalletBetting({ walletClient, safeAddress });
```

**Steps:**

1. `ensureDepositWalletDeployed(walletClient)`  
   - If no bytecode at derived address → `RelayClient.deployDepositWallet()`

2. Transfer **all** Safe pUSD → deposit wallet (gasless Safe batch)

3. `approvePolymarketTradingInDepositWallet(walletClient, depositWalletAddress)`  
   - Relayer: `executeDepositWalletBatch` with:
     - pUSD `approve` → each `PUSD_SPENDERS` (max uint)
     - CTF `setApprovalForAll` → each `CTF_OPERATORS`

**Approval check:**

```typescript
await isDepositWalletTradingApproved(depositWalletAddress);
// allowance(pUSD, CTF_EXCHANGE) > 0 && isApprovedForAll(CTF, CTF_EXCHANGE)
```

### 9.5 Pre-trade funding (automatic before each bet)

**File:** `ensureDepositWalletReadyForTrade()` in `polymarket-deposit-wallet.ts`

Called from `MarketDetailPage` before every buy:

```typescript
const tradingWallet = await ensureDepositWalletReadyForTrade({
  walletClient,
  safeAddress,
  requiredUsd: sizeUsd,
});
```

1. Ensure deposit wallet deployed  
2. If deposit wallet pUSD < required → gasless Safe transfer of shortfall  
3. If not approved → run approvals  

**Fee buffer:** Pass `userUSDCBalance` into `createAndPostMarketOrder` so CLOB reserves room for fees (avoids "balance too low for fee" errors when betting full balance).

### 9.6 Recover stranded funds

If pUSD/USDC landed in deposit wallet outside the normal flow:

```typescript
const funds = await fetchDepositWalletFunds(eoa);
await sweepDepositWalletToSafe(walletClient, safeAddress);
// Gasless deposit-wallet batch: transfer all tokens → Safe
```

---

## 10. Withdrawals

**Files:** `WithdrawModal.tsx`, `polymarket-safe-wallet.ts`, `polymarket-trading-helpers.ts`

```typescript
await withdrawUsdcEFromSafe({
  walletClient,
  safeAddress,
  to: recipientAddress,   // any 0x address, usually EOA
  amountUsdc: value,
});
```

**On-chain steps (gasless Safe batch):**

1. `pUSD.approve(COLLATERAL_OFFRAMP, amount)`
2. `COLLATERAL_OFFRAMP.unwrap(USDC_E_ADDRESS, to, amount)` → USDC.e sent to `to`

**Important:**

- Withdrawal uses **Safe pUSD**, not deposit-wallet pUSD.
- If trading funds are in the deposit wallet, sweep back to Safe first (`sweepDepositWalletToSafe`) or use `enableDepositWalletBetting` reverse flow manually.
- Max withdraw in UI = `balances.pusd` from Safe (`fetchPusdBalanceRaw(safeAddress)`).

---

## 11. Opening trades (buy)

### 11.1 UI flow

**File:** `pages/MarketDetailPage.tsx` → `BetSheet` → `tradeMutation`

```typescript
const tradingWallet = await ensureDepositWalletReadyForTrade({
  walletClient,
  safeAddress,
  requiredUsd: sizeUsd,
});

const result = await placeMarketOrder(walletClient, {
  market: selection.market,      // FifaMarket from Gamma
  outcome: selection.side,       // 'yes' | 'no'
  side: 'buy',
  sizeUsd: Number(amount),
  funder: { type: 'depositWallet', depositWalletAddress: tradingWallet },
});
```

### 11.2 `placeMarketOrder` internals

**File:** `polymarket-trading.ts`

```typescript
export async function placeMarketOrder(
  signer: WalletClientLike,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult>
```

**Algorithm:**

1. Resolve `tokenId` from `market.yesTokenId` or `market.noTokenId`
2. `createPolymarketClobClient(signer, funder)` — deposit wallet + `POLY_1271`
3. `client.updateBalanceAllowance({ asset_type: COLLATERAL })` — sync CLOB collateral
4. `client.getOrderBook(tokenId)`
5. Price:
   - Buy: `min(0.99, bestAsk + 2 * tickSize)`
   - Sell: `max(0.01, bestBid - 2 * tickSize)`
6. Amount:
   - Buy: `sizeUsd` (USDC notional)
   - Sell: `sizeUsd / price` (shares) — used in generic `placeMarketOrder` sell path
7. `client.createAndPostMarketOrder({ tokenID, price, amount, side, orderType: FAK, userUSDCBalance? }, { tickSize, negRisk }, FAK)`
8. `assertOrderFilled` — **rejects if `makingAmount` (buy) or `takingAmount` (sell) ≤ 0**

**Return type:**

```typescript
type PlaceOrderResult = {
  orderId?: string;
  price: number;
  status: string;
  filledUsd: number;  // makingAmount for buys
};
```

### 11.3 Market type requirements

From Gamma → `mapGammaMarket()`:

| Field | Bot usage |
|-------|-----------|
| `yesTokenId` / `noTokenId` | CLOB `tokenID` |
| `tickSize` | Price granularity (`orderPriceMinTickSize`) |
| `negRisk` | Must pass to order creation |
| `yesPrice` / `noPrice` | Fallback if book empty |

### 11.4 Order type

**Only `OrderType.FAK` (Fill-And-Kill)** is used — immediate marketable order, unfilled remainder cancelled.

There is **no** `createAndPostOrder` (GTC limit) in this codebase.

---

### 11.5 Order types compared (market vs limit vs stop)

Polymarket's CLOB has **no native stop-loss order type**. Every submission is a **limit order** at a price you choose; "market" orders are limit orders priced to cross the book immediately.

| `OrderType` | Rests on book? | Price control | Used in this repo |
|-------------|----------------|---------------|-------------------|
| **GTC** | Yes — until filled or cancelled | **Exact limit price** | ❌ (bot should add) |
| **GTD** | Yes — until expiration | **Exact limit price** + auto-expire | ❌ (bot should add) |
| **FAK** | No — immediate partial fill | Marketable (best ± 2 ticks) | ✅ buys & exits |
| **FOK** | No — immediate all-or-nothing | Marketable | ❌ |

See [§16 Limit orders](#16-limit-orders-at-exact-prices) and [§17 Stop losses](#17-stop-losses).

---

## 12. Closing trades (sell / exit)

### 12.1 UI flow

**File:** `pages/PortfolioPage.tsx` → `ExitPositionModal`

```typescript
await placeExitOrder(walletClient, {
  tokenId: position.asset,           // from Data API
  shares: Number(position.size),
  negRisk: Boolean(position.negativeRisk),
  funder: {
    type: 'depositWallet',
    depositWalletAddress: position.proxyWallet ?? depositWalletAddress,
  },
});
```

### 12.2 `placeExitOrder` internals

**File:** `polymarket-trading.ts`

```typescript
export async function placeExitOrder(
  signer: WalletClientLike,
  input: ExitOrderInput,
): Promise<PlaceOrderResult>
```

**Algorithm:**

1. Floor shares to 4 decimals: `Math.floor(shares * 1e4) / 1e4`
2. `createPolymarketClobClient` (no collateral sync needed for sells)
3. `getOrderBook(tokenId)`
4. `price = max(tick, bestBid - 2 * tick)`
5. `createAndPostMarketOrder({ tokenID, price, amount: shares, side: SELL, orderType: FAK }, { tickSize, negRisk }, FAK)`
6. `filledUsd = takingAmount` (USDC received)

**No `userUSDCBalance`** on sells — selling outcome tokens, not spending collateral.

### 12.3 Exit via limit sell at exact price (bot — not in repo)

To exit at an **exact** price instead of crossing the book with FAK:

```typescript
await client.createAndPostOrder(
  {
    tokenID: position.asset,
    price: 0.45,           // exact limit — must align to tickSize
    size: position.size,   // shares (not USD)
    side: Side.SELL,
  },
  { tickSize: '0.01', negRisk: position.negativeRisk ?? false },
  OrderType.GTC,
  false,  // postOnly — false allows immediate fill if price is marketable
);
```

Use `postOnly: true` if you only want to rest on the book as a maker at exactly `0.45` (rejected if it would cross).

### 12.4 Resolved positions (no on-chain redeem)

Data API returns `redeemable: true` when a market has resolved and winning shares can be claimed. **This app does not call on-chain redeem** — the Portfolio History tab only **displays** redeemable positions.

| Path | What happens |
|------|--------------|
| **Sell before resolution** | `placeExitOrder` (FAK) — ✅ implemented |
| **Hold through resolution** | Shares sit as `redeemable: true` in Data API — **no tx sent** |

**For a BTC 5m bot** that holds to expiry instead of exiting early, you must add `redeemPositions` on the CTF contract (`0x4d97dcd97ec945f40cf65f87097ace5ea0476045`):

```typescript
// Conceptual — not in repo. Redeem via Safe or deposit wallet gasless batch.
// CTF.redeemPositions(collateralToken, parentCollectionId, conditionId, indexSets)
// indexSets: [1] or [2] for binary outcomes — match winning side
```

Typical flow:

1. Poll `GET /positions?user={depositWallet}` until `redeemable === true`.
2. Submit redeem tx (relayer batch from Safe, or direct if bot pays gas).
3. pUSD proceeds land in the redeeming wallet → sweep to Safe if needed.

Until redeem is implemented, capital stays locked in resolved outcome tokens. See also [§2.8](#28-btc-5m-bot--honest-gaps).

---

## 13. Positions & balances

### 13.1 Fetch positions

**File:** `polymarket-positions.ts`

```typescript
GET {DATA_API}/positions?user={address}&limit=100&sizeThreshold=0&sortBy=CURRENT&sortDirection=DESC
```

**Query multiple wallets** (deposit wallet + Safe + EOA):

```typescript
await fetchPolymarketPositions(depositWalletAddress, safeAddress, walletAddress);
```

Data API can lag after fills — retry schedule:

```typescript
POSITION_REFRESH_RETRY_MS = [2_000, 5_000, 12_000, 25_000]
```

### 13.2 Position shape

```typescript
type PolymarketPosition = {
  proxyWallet?: string;    // deposit wallet that holds the position
  asset?: string;          // outcome token ID — use for sell + order book
  conditionId?: string;
  size?: number;           // shares
  avgPrice?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  title?: string;
  slug?: string;
  outcome?: string;
  curPrice?: number;
  negativeRisk?: boolean;
  redeemable?: boolean;
};
```

### 13.3 Portfolio value

```typescript
GET {DATA_API}/value?user={address}
```

Summed across all queried wallet addresses.

---

## 14. CLOB authentication

### 14.1 Two-level auth

| Level | Method | Purpose |
|-------|--------|---------|
| **L1** | EOA signs EIP-712 | Create/derive API key |
| **L2** | HMAC (`key`, `secret`, `passphrase`) | Orders, balances, open orders |

### 14.2 Key derivation (browser)

**File:** `polymarket-trading.ts` → `createOrDeriveApiKey()`

```typescript
// Cached in sessionStorage:
// key = `gamekart_clob_creds_${eoa.toLowerCase()}`

const client = new ClobClient({ host, chain: POLYGON, signer, useServerTime: true });
const creds = await client.createOrDeriveApiKey();
// { key, secret, passphrase }
```

On HMAC errors, creds are cleared and re-derived once.

### 14.3 Bot recommendation

For a headless bot:

1. Store EOA private key securely (not Dynamic WaaS).
2. Use `viem` `privateKeyToAccount` + `createWalletClient`.
3. Call `createOrDeriveApiKey` once, persist creds to disk/DB.
4. Reuse creds until invalidated.

---

## 15. Relayer & builder signing

### 15.1 Why relayer?

Polymarket's builder relayer **sponsors gas** for:

- Safe deployment
- Safe batch transactions (wrap, transfer, unwrap)
- Deposit wallet deployment
- Deposit wallet approval batches

User EOA only **signs EIP-712** — no POL required for normal flows.

### 15.2 Builder sign proxy

**Browser** → `POST /api/gamekart/polymarket/builder-sign`  
**Server** (`polymarket-builder.ts`) → HMAC with `POLY_BUILDER_*` env vars  
**Relayer** receives signed builder headers

```typescript
// polymarket-relayer.ts
new BuilderConfig({
  remoteBuilderConfig: {
    url: getPolymarketBuilderSignUrl(),
    token: getPolymarketBuilderSignToken(),  // optional Bearer
  },
});
```

### 15.3 Gasless Safe batch

```typescript
await executeSafeBatchGasless(walletClient, safeAddress, transactions);
// 1. ensureSafeDeployedGasless
// 2. RelayClient.execute([{ to, data, value: '0' }])
// 3. waitForRelayerConfirmation — requires on-chain tx hash
```

### 15.4 Deposit wallet batch

```typescript
await client.executeDepositWalletBatch(calls, depositWalletAddress, deadline);
// calls: { target, value, data }[]
```

---

## 16. Limit orders at exact prices

### 16.1 Key concept: all Polymarket orders are limit orders

From [Polymarket order docs](https://docs.polymarket.com/trading/orders/create):

> All orders on Polymarket are expressed as limit orders. Market orders are supported by submitting a limit order with a **marketable price**.

To trade at an **exact** price, use `createAndPostOrder` with `OrderType.GTC` or `OrderType.GTD` — not `createAndPostMarketOrder` (which uses FAK/FOK).

**This repo does not wrap limit placement yet.** The SDK (`@polymarket/clob-client-v2`) fully supports it via the same `createPolymarketClobClient()` + deposit wallet funder used for market orders.

### 16.2 SDK entry point

```typescript
import { OrderType, Side } from '@polymarket/clob-client-v2';

await client.createAndPostOrder(
  userOrder,           // UserOrderV2 — see below
  { tickSize, negRisk },
  OrderType.GTC,       // or OrderType.GTD
  postOnly,            // optional — maker-only
  deferExec,           // optional
);
```

| Method | Purpose |
|--------|---------|
| `createAndPostOrder` | Sign + post resting limit (GTC/GTD) |
| `createOrder` + `postOrder` | Two-step if batching |
| `postOrders` | Up to **15** signed orders per batch |
| `getOpenOrders` | List resting orders — wrapped as `fetchOpenLimitOrders()` in repo |

### 16.3 `UserOrderV2` fields (exact price orders)

From `node_modules/@polymarket/clob-client-v2/dist/types/ordersV2.d.ts`:

```typescript
interface UserOrderV2 {
  tokenID: string;      // outcome token (Up/Down/Yes/No)
  price: number;        // EXACT limit price, e.g. 0.55 = 55¢
  size: number;         // SHARES (conditional tokens), NOT USD
  side: Side;           // Side.BUY | Side.SELL
  expiration?: number;  // unix seconds — required for GTD semantics
  userUSDCBalance?: number;  // optional — fee buffer on buys (same as market orders)
  builderCode?: string;
  metadata?: string;
}
```

**Important size semantics:**

| Side | `size` means | USD notional |
|------|--------------|--------------|
| **BUY** | Shares to acquire | ≈ `price × size` USDC (+ fees) |
| **SELL** | Shares to sell | Proceeds ≈ `price × size` USDC |

This differs from `createAndPostMarketOrder` **buy**, where `amount` is **USD notional**.

### 16.4 Price rules (exact price must respect tick size)

The SDK validates and rounds price in `createOrder()`:

```typescript
// Invalid if price < tickSize or price > 1 - tickSize
// Price rounded to tick precision via ROUNDING_CONFIG[tickSize]
```

| `tickSize` | Valid prices (examples) | Invalid |
|------------|-------------------------|---------|
| `0.01` | `0.45`, `0.46`, `0.99` | `0.455` |
| `0.001` | `0.455`, `0.456` | `0.4555` |
| `0.0001` | `0.4555` | — |

Always read `orderPriceMinTickSize` from Gamma for each market.

**Helper to compute shares from USD budget at a limit price:**

```typescript
function sharesForLimitBuy(usdBudget: number, limitPrice: number): number {
  return usdBudget / limitPrice;
}

// Example: $25 at 0.50 → 50 shares
```

### 16.5 GTC — Good-Til-Cancelled (default limit)

Rests on the book at your **exact** `price` until fully filled or manually cancelled.

```typescript
import { Side, OrderType } from '@polymarket/clob-client-v2';
import { createPolymarketClobClient } from './polymarket-trading';
import { ensureDepositWalletReadyForTrade } from './polymarket-deposit-wallet';

async function placeLimitBuyAtPrice({
  walletClient,
  safeAddress,
  depositWalletAddress,
  tokenId,
  limitPrice,      // e.g. 0.52 — exact
  usdBudget,       // e.g. 25
  tickSize,
  negRisk,
}: {
  walletClient: WalletClient;
  safeAddress: Address;
  depositWalletAddress: Address;
  tokenId: string;
  limitPrice: number;
  usdBudget: number;
  tickSize: string;
  negRisk: boolean;
}) {
  const shares = usdBudget / limitPrice;

  await ensureDepositWalletReadyForTrade({
    walletClient,
    safeAddress,
    requiredUsd: usdBudget,
  });

  const client = await createPolymarketClobClient(walletClient, {
    type: 'depositWallet',
    depositWalletAddress,
  });

  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });

  const userUSDCBalance = await getClobCollateralBalanceUsd(client); // same pattern as placeMarketOrder

  const response = await client.createAndPostOrder(
    {
      tokenID: tokenId,
      price: limitPrice,
      size: shares,
      side: Side.BUY,
      ...(userUSDCBalance > 0 ? { userUSDCBalance } : {}),
    },
    { tickSize, negRisk },
    OrderType.GTC,
    false,  // postOnly
  );

  return response; // { success, orderID, status: 'live' | 'matched' | ... }
}
```

**Limit sell at exact price** (e.g. take-profit at 0.75):

```typescript
await client.createAndPostOrder(
  {
    tokenID: heldTokenId,
    price: 0.75,           // exact exit target
    size: sharesHeld,
    side: Side.SELL,
  },
  { tickSize, negRisk },
  OrderType.GTC,
);
```

### 16.6 GTD — Good-Til-Date (limit + auto-expire)

Same as GTC but order **expires** at `expiration` (unix seconds).

**Security threshold:** Polymarket enforces expiration ≥ **now + 60 seconds**. To get an effective lifetime of `N` seconds:

```typescript
const effectiveLifetimeSec = 300; // 5 minutes — matches BTC 5m window
const expiration = Math.floor(Date.now() / 1000) + 60 + effectiveLifetimeSec;

await client.createAndPostOrder(
  {
    tokenID: tokenId,
    price: 0.48,
    size: shares,
    side: Side.BUY,
    expiration,
  },
  { tickSize, negRisk },
  OrderType.GTD,
);
```

Use GTD on BTC 5-minute markets so unfilled entry orders auto-cancel when the window ends.

### 16.7 Post-only (maker at exact price)

```typescript
await client.createAndPostOrder(
  userOrder,
  { tickSize, negRisk },
  OrderType.GTC,
  true,  // postOnly — MUST rest on book; rejected if it would cross (take liquidity)
);
```

| `postOnly` | Behavior |
|------------|----------|
| `false` | Limit at exact price; **fills immediately** if price crosses current book |
| `true` | Limit at exact price; **only rests** as maker; error if marketable |

Use `postOnly: true` when you insist on **exact** maker price with zero slippage.

### 16.8 Proposed repo wrapper (to implement)

Add to `polymarket-trading.ts` alongside `placeMarketOrder`:

```typescript
export type PlaceLimitOrderInput = {
  tokenId: string;
  side: 'buy' | 'sell';
  price: number;           // exact limit
  sizeShares: number;      // conditional token amount
  tickSize: string;
  negRisk: boolean;
  orderType?: 'GTC' | 'GTD';
  expiration?: number;     // required for GTD
  postOnly?: boolean;
  funder: PolymarketTradingFunder;
};

export async function placeLimitOrder(
  signer: WalletClientLike,
  input: PlaceLimitOrderInput,
): Promise<{ orderId: string; status: string }> {
  const client = await createPolymarketClobClient(signer, input.funder);
  if (input.side === 'buy') {
    await syncClobCollateral(client);
  }
  const orderType = input.orderType === 'GTD' ? OrderType.GTD : OrderType.GTC;
  const response = await client.createAndPostOrder(
    {
      tokenID: input.tokenId,
      price: input.price,
      size: input.sizeShares,
      side: input.side === 'buy' ? Side.BUY : Side.SELL,
      ...(input.expiration ? { expiration: input.expiration } : {}),
    },
    { tickSize: normalizeTickSize(input.tickSize), negRisk: input.negRisk },
    orderType,
    input.postOnly ?? false,
  );
  return { orderId: response.orderID, status: response.status };
}
```

### 16.9 Monitoring limit fills

After posting, poll:

```typescript
const open = await client.getOpenOrders({ asset_id: tokenId }, true);
const order = await client.getOrder(orderId);
```

Or watch trades via Data API / WebSocket. Open orders in this repo:

```typescript
// polymarket-trading.ts — already implemented
await fetchOpenLimitOrders(signer, funder);
// Returns: { id, assetId, price, remainingSize, side, createdAt, ... }
```

### 16.10 Limit order errors (common)

| Error | Cause | Fix |
|-------|-------|-----|
| `INVALID_ORDER_MIN_TICK_SIZE` | Price not on tick grid | Round to `tickSize` |
| `INVALID_ORDER_MIN_SIZE` | Too few shares | Increase size |
| `INVALID_POST_ONLY_ORDER` | postOnly order would cross | Lower buy price or raise sell price |
| `INVALID_ORDER_NOT_ENOUGH_BALANCE` | Insufficient pUSD / shares | Fund deposit wallet |
| `INVALID_ORDER_EXPIRATION` | GTD &lt; now + 60s | Use `now + 60 + N` |
| `FOK_ORDER_NOT_FILLED_ERROR` | Used FOK with no liquidity | Use GTC or FAK |

---

## 17. Stop losses

### 17.1 Polymarket has no native stop-loss orders

The CLOB API exposes only:

- `GTC` / `GTD` — resting **limit** orders at a price **you set now**
- `FAK` / `FOK` — immediate execution

There is **no** `STOP`, `STOP_LIMIT`, or trigger order type. A stop loss at an exact trigger price (e.g. "sell when bid hits 42¢") must be implemented **in your bot process**.

### 17.2 Why you cannot simply "place a stop" as a resting order

Example: you are **long** 100 shares of "BTC Up" bought at **60¢**. You want a stop at **50¢**.

| Approach | What happens |
|----------|--------------|
| Place GTC **sell limit at 50¢** while market is **60¢** | Order is **below** the best bid → executes **immediately** (marketable), not a stop |
| Place GTC **sell limit at 50¢** while market is **45¢** | Rests on book; may not fill if bid stays below 50¢ |
| **Correct: monitor + trigger** | Bot watches bid; when `bestBid <= 0.50`, submit exit |

**Stop losses require a price feed loop**, not a single `createAndPostOrder` at startup.

### 17.3 Stop-loss patterns (exact trigger prices)

#### Pattern A — Monitor + FAK exit (recommended; matches `placeExitOrder`)

Guaranteed **attempt** to exit as soon as trigger hits. Exit price may slip slightly below stop in fast markets.

```typescript
const STOP_PRICE = 0.50;

async function pollStopLoss({
  client,
  tokenId,
  shares,
  negRisk,
  tickSize,
}: {
  client: ClobClient;
  tokenId: string;
  shares: number;
  negRisk: boolean;
  tickSize: string;
}) {
  const book = await client.getOrderBook(tokenId);
  const bestBid = Number(book.bids?.[0]?.price ?? 0);

  if (bestBid > 0 && bestBid <= STOP_PRICE) {
    // Reuse placeExitOrder logic — FAK sell crossing the book
    await placeExitOrder(walletClient, {
      tokenId,
      shares,
      negRisk,
      tickSize,
      funder: { type: 'depositWallet', depositWalletAddress },
    });
    return 'triggered';
  }
  return 'watching';
}
```

**Poll interval:** 250ms–1s for BTC 5m, or use WebSocket (see below).

#### Pattern B — Monitor + limit exit at exact stop price

When `bestBid <= stopPrice`, post **GTC sell at exactly `stopPrice`**:

```typescript
if (bestBid <= STOP_PRICE) {
  await client.createAndPostOrder(
    {
      tokenID: tokenId,
      price: STOP_PRICE,   // exact limit at stop level
      size: sharesHeld,
      side: Side.SELL,
    },
    { tickSize, negRisk },
    OrderType.GTC,
    false,
  );
}
```

- If bid is **at** stop: fills at 50¢.
- If price **gaps through** (bid 48¢): order may **not fill** until bid recovers to 50¢.
- Safer for gap risk: use Pattern A (FAK) or Pattern C.

#### Pattern C — Monitor + FAK at exact stop cap

Submit FAK sell with **limit price = stop price** (won't sell below your stop):

```typescript
if (bestBid <= STOP_PRICE) {
  await client.createAndPostMarketOrder(
    {
      tokenID: tokenId,
      price: STOP_PRICE,   // worst acceptable price (= stop)
      amount: sharesHeld,
      side: Side.SELL,
      orderType: OrderType.FAK,
    },
    { tickSize, negRisk },
    OrderType.FAK,
  );
}
```

This is the closest on-chain equivalent to a **stop-market with slippage cap at the stop price**.

#### Pattern D — Arm a GTC sell only after price approaches (advanced)

1. While `bestBid > stopPrice + buffer`, do nothing.
2. When `bestBid <= stopPrice + buffer`, place GTC sell at **exact** `stopPrice`.
3. Cancel if price recovers above `stopPrice + buffer` before fill.

Useful to avoid immediate marketable fills while still resting at an exact price near the stop.

### 17.4 Stop-loss architecture for BTC 5-minute bot

```
┌─────────────────────────────────────────────────────────────┐
│  Position manager                                            │
│  - entry: GTC limit buy @ 0.52 OR FAK market buy            │
│  - armed stop: stopPrice = 0.45                             │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Price monitor (poll or WebSocket)                           │
│  - CLOB_WS_URL or GET /book every 250–1000ms                │
│  - track bestBid for held tokenId                           │
└───────────────────────────┬─────────────────────────────────┘
                            │ bestBid <= stopPrice
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Exit executor                                               │
│  - cancel competing GTC orders (cancelMarketOrders)         │
│  - placeExitOrder (FAK) OR limit sell @ stopPrice (Pattern B/C) │
│  - confirm position size → 0 via Data API                   │
└─────────────────────────────────────────────────────────────┘
```

### 17.5 WebSocket for stop monitoring

```typescript
// polymarket.ts
export const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
```

Subscribe to the outcome `tokenId` book/trade channel. On each update, re-evaluate `bestBid <= stopPrice`.

Polling fallback (already used for positions):

```typescript
const book = await fetchOrderBookSummary(tokenId);
// GET /api/clob/book?token_id=
```

### 17.6 Take-profit at exact price (limit sell)

Take-profit **can** be a resting GTC sell at your exact target **above** current price:

```typescript
// Long from 0.40, take profit at exactly 0.65 — rests until bid reaches 0.65
await client.createAndPostOrder(
  { tokenID, price: 0.65, size: shares, side: Side.SELL },
  { tickSize, negRisk },
  OrderType.GTC,
);
```

This works because the sell limit is **above** the market (non-marketable).  
**Stop losses are the inverse problem** (sell below market while still holding) — hence the monitor requirement.

### 17.7 OCO-style logic (stop + take-profit)

Polymarket has no OCO (one-cancels-other). Implement in bot:

1. Post GTC take-profit sell at `tpPrice`.
2. Run stop monitor at `stopPrice`.
3. When stop triggers: `cancelOrder(tpOrderId)` then exit.
4. When TP fills: stop monitor sees `shares === 0` and stops.

```typescript
await client.cancelOrder({ orderID: tpOrderId });
await client.cancelMarketOrders({ asset_id: tokenId }); // cancel all for token
```

### 17.8 Proposed `StopLossMonitor` helper (to implement)

```typescript
export type StopLossConfig = {
  tokenId: string;
  shares: number;
  stopPrice: number;        // exact trigger — e.g. 0.45
  negRisk: boolean;
  tickSize: string;
  mode: 'fak' | 'limit_at_stop';  // Pattern A vs B
  pollMs?: number;                // default 500
  onTriggered?: (result: PlaceOrderResult) => void;
};

export function startStopLossMonitor(
  walletClient: WalletClientLike,
  funder: PolymarketTradingFunder,
  config: StopLossConfig,
): () => void {
  let active = true;
  const poll = async () => {
    if (!active) return;
    const book = await fetchOrderBookSummary(config.tokenId);
    const bestBid = Number(book.bids?.[0]?.price ?? 0);
    if (bestBid > 0 && bestBid <= config.stopPrice) {
      active = false;
      const result =
        config.mode === 'fak'
          ? await placeExitOrder(walletClient, { tokenId: config.tokenId, shares: config.shares, ... })
          : await placeLimitOrder(walletClient, {
              tokenId: config.tokenId,
              side: 'sell',
              price: config.stopPrice,
              sizeShares: config.shares,
              orderType: 'GTC',
              ...
            });
      config.onTriggered?.(result);
      return;
    }
    setTimeout(poll, config.pollMs ?? 500);
  };
  void poll();
  return () => { active = false; };
}
```

---

## 18. Order cancellation

### 18.1 SDK methods (not wrapped in repo yet)

```typescript
const client = await createPolymarketClobClient(signer, funder);

// Single order
await client.cancelOrder({ orderID: '0x...' });

// Multiple by hash
await client.cancelOrders(['0xabc...', '0xdef...']);

// All open orders for user
await client.cancelAll();

// All orders for a market or token
await client.cancelMarketOrders({ asset_id: tokenId });
await client.cancelMarketOrders({ market: conditionId });
```

### 18.2 When to cancel

| Scenario | Action |
|----------|--------|
| BTC window expired, entry not filled | GTD auto-expires; or `cancelMarketOrders({ asset_id })` |
| Stop triggered | Cancel resting take-profit limits first |
| Strategy signal flip | `cancelAll()` before new entry |
| Bot shutdown | `cancelAll()` |

### 18.3 Read open orders (already in repo)

```typescript
import { fetchOpenLimitOrders } from './polymarket-trading';

const orders = await fetchOpenLimitOrders(walletClient, {
  type: 'depositWallet',
  depositWalletAddress,
});

for (const o of orders) {
  console.log(o.id, o.side, o.price, o.remainingSize);
}
```

---

## 19. Market discovery (Gamma API)

### 19.1 Current (FIFA)

```typescript
GET https://gamma-api.polymarket.com/events?tag_id=102232&active=true&closed=false
```

Mapped via `mapGammaEvent()` / `mapGammaMarket()` in `polymarket.ts`.

### 19.2 Generic market fields (for any market including BTC)

From `mapGammaMarket()` — reuse for BTC:

```typescript
{
  id, slug, question,
  outcomes: [{ name, price, tokenId }],
  yesTokenId, noTokenId,   // from clobTokenIds + outcome names
  yesPrice, noPrice,        // from outcomePrices
  tickSize,                 // orderPriceMinTickSize
  negRisk,
  active, endDate,
  volumeUsd, liquidityUsd,
}
```

**Gamma raw fields:**

- `outcomes` — JSON string array
- `outcomePrices` — JSON string array
- `clobTokenIds` — JSON string array of token IDs
- `orderPriceMinTickSize` — tick size string

### 19.3 Finding BTC 5-minute markets (bot task)

Not implemented in repo. Typical approach:

```typescript
// Example strategies (verify against live Gamma API):
GET /markets?active=true&closed=false&limit=100
// Filter: slug or question matches /btc.*5.*min|up.*down/i

// Or search by tag if Polymarket assigns a crypto tag:
GET /events?tag_id={CRYPTO_TAG}&active=true
```

For each candidate market, extract:

- `clobTokenIds[0]` → "Up" token
- `clobTokenIds[1]` → "Down" token
- `endDate` / `eventStartTime` → 5-minute window timing
- `negRisk` — likely `false` for binary BTC windows but **always read from API**

### 19.4 Outcome names — do not assume `clobTokenIds` order (BTC bot)

FIFA markets use `"Yes"` / `"No"`. BTC 5m markets often use `"Up"` / `"Down"`. The repo maps `yesTokenId` / `noTokenId` from outcome **names**, not array index alone:

```typescript
// polymarket.ts — mapGammaMarket() pattern (simplified)
const outcomes = JSON.parse(market.outcomes);       // e.g. ["Up", "Down"]
const tokenIds = JSON.parse(market.clobTokenIds);   // parallel array
const prices = JSON.parse(market.outcomePrices);

// Match by name — never hardcode tokenIds[0] = Up without checking
for (let i = 0; i < outcomes.length; i++) {
  const name = outcomes[i].toLowerCase();
  if (name === 'yes' || name === 'up') yesTokenId = tokenIds[i];
  if (name === 'no' || name === 'down') noTokenId = tokenIds[i];
}
```

**Bot rule:** Before `placeMarketOrder({ outcome: 'yes' })`, confirm your market mapper treats `'yes'` as the **Up** side for BTC markets (or pass `tokenId` directly and skip yes/no abstraction). Wrong mapping → you buy the opposite side.

See [§2.8 gap #3](#28-btc-5m-bot--honest-gaps).

---

## 20. Production gotchas

| Issue | Cause | Mitigation in code |
|-------|-------|-------------------|
| "Maker address not allowed" | Trading from Safe instead of deposit wallet | Use `POLY_1271` + deposit wallet |
| Order "success" but no fill | FAK found no liquidity | `assertOrderFilled` checks amounts |
| Fee exceeds balance | Betting 100% of pUSD | Pass `userUSDCBalance` to market order |
| Positions not showing | Data API lag / wrong wallet / **proxy misroute** | Query deposit wallet + Safe + EOA; retry polling; fix proxy order ([§2.6](#26-vite-proxy-ordering-gotcha-dev--production)) |
| Relayer fails | Builder creds / sign URL | Check `POLY_BUILDER_*`, builder-sign 401 |
| WaaS sign errors | `chainId` as bigint | `wrapWalletClientForWaas()` |
| CLOB cred errors | Stale sessionStorage creds | `clearStoredClobCreds` + retry |
| Withdraw empty | Funds in deposit wallet not Safe | `sweepDepositWalletToSafe` first |
| `POLY_BUILDER_SECRET` with `=` | dotenv quoting | Single-quoted value in `.env` is fine |

---

## 21. Adapting for a BTC 5-minute bot

> **Read first:** [§2.8 BTC 5m bot — honest gaps](#28-btc-5m-bot--honest-gaps) — limit orders, redeem, and market discovery are **not implemented** in this repo.

### 21.1 What you can reuse as-is

| Module | Reuse |
|--------|-------|
| `polymarket-deposit-wallet.ts` | ✅ Full deposit/approve/trade-prep flow |
| `polymarket-trading.ts` | ✅ `placeMarketOrder`, `placeExitOrder`, CLOB client |
| `polymarket-relayer.ts` | ✅ Gasless Safe + deposit wallet |
| `polymarket-safe-wallet.ts` | ✅ Wrap, withdraw |
| `polymarket-bridge.ts` | ✅ Fund Safe from any chain |
| `polymarket-positions.ts` | ✅ Position tracking |
| `polymarket-contracts.ts` | ✅ Addresses & ABIs |

### 21.2 What you must build new

1. **Market scanner** — Gamma (or CLOB) poll for active BTC 5m up/down markets  
2. **Window clock** — parse `endDate` / `startTime`, trade only inside allowed window  
3. **Strategy loop** — signal → entry → monitor → exit or hold to resolution  
4. **Headless wallet** — replace Dynamic `getWalletClient()` with viem `privateKeyToAccount`  
5. **Price monitor** — poll or WebSocket for stop-loss triggers ([§17](#17-stop-losses))  
6. **Limit orders** — GTC/GTD entries and take-profits at exact prices ([§16](#16-limit-orders-at-exact-prices))  
7. **Order management** — cancel stale limits on window expiry ([§18](#18-order-cancellation))  

### 21.3 Suggested bot architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Market scanner  │────►│ Strategy engine  │────►│ Trade executor  │
│ (Gamma 5m BTC)  │     │ (signals, risk)  │     │ FAK / GTC limits│
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                         │                        │
         ▼                         ▼                        ▼
   Gamma API / WS            Stop monitor (§17)        CLOB + Relayer
                             Position tracker           (deposit wallet)
                             (Data API poll)
```

### 21.4 Minimal buy snippet (headless)

Conceptual — adapt from `MarketDetailPage`:

```typescript
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { derivePolymarketSafeAddress } from './polymarket-safe';
import { ensureDepositWalletReadyForTrade } from './polymarket-deposit-wallet';
import { placeMarketOrder } from './polymarket-trading';

const account = privateKeyToAccount(process.env.BOT_PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
const safeAddress = derivePolymarketSafeAddress(account.address);

const depositWallet = await ensureDepositWalletReadyForTrade({
  walletClient,
  safeAddress,
  requiredUsd: 25,
});

const result = await placeMarketOrder(walletClient, {
  market: btcMarket,           // your Gamma-mapped market object
  outcome: 'yes',              // 'yes' = Up, 'no' = Down (verify outcome names!)
  side: 'buy',
  sizeUsd: 25,
  funder: { type: 'depositWallet', depositWalletAddress: depositWallet },
});

console.log('Filled:', result.filledUsd, '@', result.price);
```

### 21.5 Minimal exit snippet

```typescript
import { placeExitOrder } from './polymarket-trading';

await placeExitOrder(walletClient, {
  tokenId: position.asset!,
  shares: position.size!,
  negRisk: position.negativeRisk ?? false,
  funder: { type: 'depositWallet', depositWalletAddress: depositWallet },
});
```

### 21.6 Limit entry at exact price (headless)

```typescript
// After ensureDepositWalletReadyForTrade — see §16.5
const client = await createPolymarketClobClient(walletClient, {
  type: 'depositWallet',
  depositWalletAddress: depositWallet,
});

const limitPrice = 0.52;
const usdBudget = 25;
const shares = usdBudget / limitPrice;

const response = await client.createAndPostOrder(
  {
    tokenID: btcMarket.yesTokenId,  // Up token
    price: limitPrice,
    size: shares,
    side: Side.BUY,
  },
  { tickSize: btcMarket.tickSize, negRisk: btcMarket.negRisk },
  OrderType.GTC,
);

// Arm stop monitor after fill — see §17.8
```

### 21.7 Market object for BTC

You need a struct compatible with `PlaceOrderInput.market`:

```typescript
// Minimum fields required by placeMarketOrder:
{
  yesTokenId: string,   // Up token from clobTokenIds
  noTokenId: string,    // Down token
  yesPrice: number,
  noPrice: number,
  tickSize: string,     // e.g. '0.01'
  negRisk: boolean,
  // ... other FifaMarket fields can be stubbed if not used
}
```

Consider adding a generic `PolymarketMarket` type in `packages/shared` for the bot (decouple from `FifaMarket`).

---

## 22. End-to-end bot checklist

### One-time setup

- [ ] Polygon EOA with private key (secure storage)
- [ ] Builder API credentials (`POLY_BUILDER_*`) on server
- [ ] Builder sign endpoint running (or inline `BuilderSigner` in bot process)
- [ ] Fund Safe via bridge (`createBridgeDepositAddresses`)
- [ ] Wrap if needed (`wrapUsdcEToPusdInSafe`)
- [ ] Enable betting (`enableDepositWalletBetting`)
- [ ] Verify: `isDepositWalletTradingApproved` === true
- [ ] Verify: CLOB `createOrDeriveApiKey` succeeds

### Per-trade loop

- [ ] Discover active BTC 5m market (Gamma)
- [ ] Read `tokenId`, `tickSize`, `negRisk`, `endDate`
- [ ] Check deposit wallet pUSD ≥ size + fee buffer
- [ ] `ensureDepositWalletReadyForTrade({ requiredUsd })`
- [ ] **Entry:** `placeMarketOrder` (FAK) **or** `createAndPostOrder` GTC/GTD at exact limit price (§16)
- [ ] Confirm fill (`filledUsd > 0` or order `status === 'matched'`)
- [ ] Poll positions until size updates
- [ ] **Stop:** start price monitor; on `bestBid <= stopPrice` → `placeExitOrder` or limit sell at stop (§17)
- [ ] **Take-profit (optional):** resting GTC sell at exact `tpPrice` (§17.6)
- [ ] On window end: `cancelMarketOrders({ asset_id })` for unfilled limits (§18)
- [ ] Log `orderId`, price, fill amounts

### Risk controls (recommended)

- Max position size per window
- Max daily loss
- Skip if spread > threshold
- Skip if `endDate` < N seconds away (illiquidity near expiry)
- Retry with refreshed book on FAK miss
- GTD expiration = `now + 60 + windowSeconds` so limits auto-expire with 5m market
- Cancel take-profit limit when stop fires (OCO in bot logic, §17.7)

---

## Quick reference — function index

| Function | File | Action |
|----------|------|--------|
| `createBridgeDepositAddresses` | `polymarket-bridge.ts` | Get deposit addresses |
| `wrapUsdcEToPusdInSafe` | `polymarket-safe-wallet.ts` | USDC.e → pUSD |
| `enableDepositWalletBetting` | `polymarket-deposit-wallet.ts` | Move pUSD + approve |
| `ensureDepositWalletReadyForTrade` | `polymarket-deposit-wallet.ts` | Pre-bet funding |
| `placeMarketOrder` | `polymarket-trading.ts` | FAK market buy |
| `placeExitOrder` | `polymarket-trading.ts` | FAK market sell / exit |
| `createAndPostOrder` | SDK via `createPolymarketClobClient` | GTC/GTD limit at exact price (§16) |
| `cancelOrder` / `cancelAll` / `cancelMarketOrders` | SDK | Cancel resting limits (§18) |
| `fetchOpenLimitOrders` | `polymarket-trading.ts` | List resting orders |
| `withdrawUsdcEFromSafe` | `polymarket-safe-wallet.ts` | Withdraw |
| `sweepDepositWalletToSafe` | `polymarket-relayer.ts` | Recover stranded funds |
| `fetchPolymarketPositions` | `polymarket-trading.ts` | Open positions |
| `createPolymarketClobClient` | `polymarket-trading.ts` | Authenticated CLOB client |
| `executeSafeBatchGasless` | `polymarket-relayer.ts` | Gasless Safe txs |
| `resolveDepositWalletAddress` | `polymarket-positions.ts` | Correct deposit wallet address |

---

*Last updated from codebase audit. For FIFA-specific UI flows see `DOCUMENTATION.md`. For outdated generic notes see `POLYMARKET_INTEGRATION.md` (do not trust for this repo).*
