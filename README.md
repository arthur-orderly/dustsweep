# 🧹 DustSweep

Sweep forgotten tokens from your wallet into SOL, USDC, WOO, or ORDER.

**Live:** [arthurdex.com/sweep](https://arthurdex.com/sweep)

## How it works

1. Connect your Phantom (Solana) or EVM wallet (Rabby, MetaMask)
2. DustSweep scans for all token balances
3. Select tokens to sweep, pick your destination token
4. Sign each swap transaction in your wallet

## Routing

- **Solana:** [Jupiter](https://jup.ag) aggregator — best execution across all Solana DEXs
- **EVM:** [WOOFi](https://woofi.com) WooRouterV2 — sPMM liquidity across 12+ chains

## Security

- **Non-custodial** — your keys never leave your wallet
- **No backend** — pure client-side, static HTML
- **Exact approvals** — ERC-20 approvals are for the exact swap amount, not unlimited
- **HTML-escaped** — all token names/symbols sanitized against XSS
- **Preflight enabled** — Solana transactions simulated before sending

## Stack

Single `index.html` — no build step, no dependencies, no framework. Just HTML + vanilla JS.

## License

MIT
