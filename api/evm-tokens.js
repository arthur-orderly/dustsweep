export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const addr = req.query.addr;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr))
    return res.status(400).json({ error: 'valid EVM address required' });

  const origin = req.headers.origin || '';
  const allowed = ['https://arthurdex.com', 'https://woofi-dustsweep.vercel.app', 'http://localhost'];
  const corsOrigin = allowed.find(a => origin.startsWith(a)) || allowed[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);

  // Blockscout explorers — free, no API key, returns ALL token balances
  const CHAINS = [
    { name: 'Ethereum', slug: 'ethereum', blockscout: 'https://eth.blockscout.com' },
    { name: 'Arbitrum', slug: 'arbitrum', blockscout: 'https://arbitrum.blockscout.com' },
    { name: 'Base', slug: 'base', blockscout: 'https://base.blockscout.com' },
    { name: 'Optimism', slug: 'optimism', blockscout: 'https://optimism.blockscout.com' },
    { name: 'Polygon', slug: 'polygon', blockscout: 'https://polygon.blockscout.com' },
    { name: 'BSC', slug: 'bsc', blockscout: 'https://bsc.blockscout.com' },
    { name: 'Blast', slug: 'blast', blockscout: 'https://blast.blockscout.com' },
  ];

  // Chains without Blockscout — fall back to known token list + RPC
  const FALLBACK_CHAINS = [
    { name: 'Mantle', slug: 'mantle', rpcs: ['https://rpc.mantle.xyz'],
      tokens: [
        { addr: '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9', sym: 'USDC', dec: 6 },
        { addr: '0x201eba5cc46d216ce6dc03f6a759e8e766e956ae', sym: 'USDT', dec: 6 },
        { addr: '0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8', sym: 'WMNT', dec: 18 },
      ]},
    { name: 'Merlin', slug: 'merlinchain', rpcs: ['https://rpc.merlinchain.io'],
      tokens: [
        { addr: '0x480e158395cc5b41e5584347c495584ca2caf78d', sym: 'MERL', dec: 8 },
        { addr: '0xb880fd278198bd590252621d4cd071b1842e9bcd', sym: 'M-BTC', dec: 18 },
        { addr: '0x5c46bff4b38dc1eae09c5bac65f31a150b940064', sym: 'MERL', dec: 18 },
      ]},
  ];

  const walletPadded = '000000000000000000000000' + addr.slice(2).toLowerCase();

  async function fetchT(url, opts = {}, ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      return r;
    } catch(e) { clearTimeout(timer); throw e; }
  }

  // Blockscout: fetch all token balances in one call
  async function scanBlockscout(chain) {
    const url = `${chain.blockscout}/api/v2/addresses/${addr}/token-balances`;
    const r = await fetchT(url, {}, 10000);
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data)) return [];

    const tokens = [];
    for (const entry of data) {
      const tok = entry.token || {};
      const value = entry.value;
      if (!value || value === '0') continue;

      const decimals = parseInt(tok.decimals || '18');
      let bal;
      try {
        bal = Number(BigInt(value)) / (10 ** decimals);
      } catch(e) {
        // If BigInt fails, try parseFloat
        bal = parseFloat(value) / (10 ** decimals);
      }
      if (!bal || bal < 0.000001 || !isFinite(bal)) continue;

      // Skip NFTs
      if (tok.type === 'ERC-721' || tok.type === 'ERC-1155') continue;

      // Skip spam/scam tokens
      const sym = (tok.symbol || '').trim();
      const name = (tok.name || '').trim();
      const combined = (sym + ' ' + name).toLowerCase();
      const isSpam =
        // URLs in symbol or name (including www. and domain patterns)
        /https?:|www\.|\.com|\.io|\.xyz|\.cc|\.top|\.app|\.org|\.net|\.icu|\.finance|\.markets|\.promo/i.test(combined) ||
        // Claim/airdrop/bridge scams
        /claim|airdrop|bridge for|visit |access /i.test(combined) ||
        // Dollar amounts in name
        /\$[\d,]+/.test(name) ||
        // Homoglyph characters (Cyrillic lookalikes)
        /[\u0400-\u04FF]/.test(sym + name) ||
        // Position value > $10M = spam
        (parseFloat(tok.exchange_rate) > 0 && bal * parseFloat(tok.exchange_rate) > 10_000_000) ||
        // No exchange rate + huge balance = fake airdrop token
        (!tok.exchange_rate || tok.exchange_rate === 'None' || tok.exchange_rate === null) && bal > 1_000_000;
      if (isSpam) continue;

      tokens.push({
        symbol: tok.symbol || 'UNK',
        name: tok.name || tok.symbol || 'Unknown',
        chain: chain.name,
        chainSlug: chain.slug,
        balance: bal,
        contractAddress: (tok.address_hash || tok.address || '').toLowerCase(),
        decimals,
        logoUrl: tok.icon_url || null
      });
    }
    return tokens;
  }

  // Fallback: check known tokens via RPC
  async function scanFallback(chain) {
    const tokens = [];
    for (const t of chain.tokens) {
      for (const rpc of chain.rpcs) {
        try {
          const r = await fetchT(rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1, method: 'eth_call',
              params: [{ to: t.addr, data: '0x70a08231' + walletPadded }, 'latest']
            })
          }, 5000);
          if (!r.ok) continue;
          const d = await r.json();
          if (d.error || !d.result || d.result === '0x') continue;
          const bal = Number(BigInt(d.result)) / (10 ** t.dec);
          if (bal < 0.000001) break;
          tokens.push({
            symbol: t.sym,
            name: t.name || t.sym,
            chain: chain.name,
            chainSlug: chain.slug,
            balance: bal,
            contractAddress: t.addr,
            decimals: t.dec,
            logoUrl: null
          });
          break;
        } catch(e) { continue; }
      }
    }
    return tokens;
  }

  try {
    const allTokens = [];

    // Scan all chains in parallel
    const results = await Promise.allSettled([
      ...CHAINS.map(c => scanBlockscout(c).catch(() => [])),
      ...FALLBACK_CHAINS.map(c => scanFallback(c).catch(() => []))
    ]);

    const debug = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const label = i < CHAINS.length ? CHAINS[i].name : FALLBACK_CHAINS[i - CHAINS.length].name;
      if (r.status === 'fulfilled') {
        debug.push({ chain: label, found: r.value.length });
        allTokens.push(...r.value);
      } else {
        debug.push({ chain: label, error: r.reason?.message || String(r.reason) });
      }
    }

    // Deduplicate by chain+contract
    const seen = new Set();
    const deduped = allTokens.filter(t => {
      const key = `${t.chain}:${t.contractAddress}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Count per source for debugging
    const chainCounts = {};
    for (const t of deduped) chainCounts[t.chain] = (chainCounts[t.chain] || 0) + 1;

    return res.status(200).json({ tokens: deduped, source: 'blockscout' });

  } catch (err) {
    console.error('EVM token scan error:', err.message);
    return res.status(200).json({ tokens: [], source: 'error', error: err.message });
  }
}
