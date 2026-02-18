export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const addr = req.query.addr;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr))
    return res.status(400).json({ error: 'valid EVM address required' });

  const origin = req.headers.origin || '';
  const allowed = ['https://arthurdex.com', 'https://woofi-dustsweep.vercel.app', 'http://localhost'];
  const corsOrigin = allowed.find(a => origin.startsWith(a)) || allowed[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);

  const walletPadded = '000000000000000000000000' + addr.slice(2).toLowerCase();

  const CHAINS = [
    { name: 'Ethereum', slug: 'ethereum', rpcs: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'] },
    { name: 'Arbitrum', slug: 'arbitrum', rpcs: ['https://arb1.arbitrum.io/rpc', 'https://rpc.ankr.com/arbitrum'] },
    { name: 'Base', slug: 'base', rpcs: ['https://mainnet.base.org', 'https://rpc.ankr.com/base'] },
    { name: 'Optimism', slug: 'optimism', rpcs: ['https://mainnet.optimism.io'] },
    { name: 'Polygon', slug: 'polygon', rpcs: ['https://polygon-rpc.com'] },
    { name: 'BSC', slug: 'bsc', rpcs: ['https://bsc-dataseed.binance.org'] },
    { name: 'Mantle', slug: 'mantle', rpcs: ['https://rpc.mantle.xyz'] },
    { name: 'Merlin', slug: 'merlinchain', rpcs: ['https://rpc.merlinchain.io'] },
    { name: 'Blast', slug: 'blast', rpcs: ['https://rpc.blast.io', 'https://rpc.ankr.com/blast'] },
  ];

  // Multicall3 is deployed at the same address on most EVM chains
  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const BALANCE_OF_SELECTOR = '70a08231';

  async function rpcCall(rpcs, payload, timeoutMs = 10000) {
    for (const rpc of rpcs) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const r = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });
        clearTimeout(timer);
        if (!r.ok) continue;
        const d = await r.json();
        if (d.error) continue;
        return d.result;
      } catch(e) { continue; }
    }
    return null;
  }

  // Fetch top tokens for a chain from DexScreener
  async function getTopTokens(chainSlug) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      // Get trending/top tokens for the chain
      const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chainSlug}`, {
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!r.ok) return [];
      const d = await r.json();
      const seen = new Set();
      const tokens = [];
      for (const p of (d.pairs || [])) {
        const bt = p.baseToken || {};
        const addr = bt.address?.toLowerCase();
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        tokens.push({ address: addr, symbol: bt.symbol, name: bt.name });
        if (tokens.length >= 100) break;
      }
      return tokens;
    } catch(e) { return []; }
  }

  // Use multicall3 to batch-check balances
  async function batchBalances(rpcs, tokenAddresses) {
    // Encode multicall: aggregate3(Call3[] calls)
    // Each call: (target, allowFailure, callData)
    // callData = balanceOf(wallet)
    const calldata = BALANCE_OF_SELECTOR + walletPadded;

    // Build aggregate3 calldata
    // Function selector for aggregate3: 0x82ad56cb
    const calls = tokenAddresses.map(t => ({
      target: t,
      allowFailure: true,
      callData: '0x' + calldata
    }));

    // ABI encode — this is complex, let's just do individual calls in parallel instead
    // Multicall encoding is non-trivial without ethers.js
    // Parallel individual calls is fine for <100 tokens

    const results = {};
    const batchSize = 20;
    for (let i = 0; i < tokenAddresses.length; i += batchSize) {
      const batch = tokenAddresses.slice(i, i + batchSize);
      const promises = batch.map(async (tokenAddr) => {
        const result = await rpcCall(rpcs, {
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: tokenAddr, data: '0x' + calldata }, 'latest']
        }, 5000);
        if (!result || result === '0x' || result === '0x0') return;
        try {
          const bal = BigInt(result);
          if (bal > 0n) results[tokenAddr] = bal;
        } catch(e) {}
      });
      await Promise.all(promises);
    }
    return results;
  }

  // Get decimals for tokens
  async function getDecimals(rpcs, tokenAddr) {
    const result = await rpcCall(rpcs, {
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: tokenAddr, data: '0x313ce567' }, 'latest']
    }, 3000);
    if (!result || result === '0x') return 18;
    try { return Number(BigInt(result)); } catch(e) { return 18; }
  }

  // Get symbol
  async function getSymbol(rpcs, tokenAddr) {
    const result = await rpcCall(rpcs, {
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: tokenAddr, data: '0x95d89b41' }, 'latest']
    }, 3000);
    if (!result || result === '0x' || result.length < 66) return null;
    try {
      const hex = result.slice(2);
      const offset = parseInt(hex.slice(0, 64), 16) * 2;
      const len = parseInt(hex.slice(offset, offset + 64), 16);
      const strHex = hex.slice(offset + 64, offset + 64 + len * 2);
      return Buffer.from(strHex, 'hex').toString('utf8').replace(/\0/g, '');
    } catch(e) {
      try {
        return Buffer.from(result.slice(2, 66), 'hex').toString('utf8').replace(/\0/g, '');
      } catch(e2) { return null; }
    }
  }

  // Well-known tokens per chain: { address, symbol, name, decimals }
  // decimals is optional — will be fetched from chain if not provided
  const KNOWN_TOKENS = {
    'Ethereum': [
      { addr: '0xdac17f958d2ee523a2206206994597c13d831ec7', sym: 'USDT', dec: 6 },
      { addr: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', sym: 'USDC', dec: 6 },
      { addr: '0x6b175474e89094c44da98b954eedeac495271d0f', sym: 'DAI', dec: 18 },
      { addr: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', sym: 'WBTC', dec: 8 },
      { addr: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', sym: 'WETH', dec: 18 },
      { addr: '0x514910771af9ca656af840dff83e8264ecf986ca', sym: 'LINK', dec: 18 },
      { addr: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', sym: 'UNI', dec: 18 },
      { addr: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', sym: 'AAVE', dec: 18 },
      { addr: '0xabd4c63d2616a5201454168269031355f4764337', sym: 'ORDER', dec: 18 },
      { addr: '0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8', sym: 'ORDER', dec: 18 },
    ],
    'Arbitrum': [
      { addr: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', sym: 'USDC', dec: 6 },
      { addr: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', sym: 'USDT', dec: 6 },
      { addr: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', sym: 'WETH', dec: 18 },
      { addr: '0x912ce59144191c1204e64559fe8253a0e49e6548', sym: 'ARB', dec: 18 },
      { addr: '0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8', sym: 'ORDER', dec: 18 },
    ],
    'Base': [
      { addr: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', sym: 'USDC', dec: 6 },
      { addr: '0x4200000000000000000000000000000000000006', sym: 'WETH', dec: 18 },
      { addr: '0x50da645f148798f68ef2d7db7c1cb22a6819bb2c', sym: 'SPX', name: 'SPX6900', dec: 8 },
      { addr: '0x532f27101965dd16442e59d40670faf5ebb142e4', sym: 'BRETT', dec: 18 },
      { addr: '0xbc45647ea894030a4e9801ec03479739fa2485f0', sym: 'TOSHI', dec: 18 },
      { addr: '0x0b3e328455c4059ebc0290ba6bab5a2eba2bdca1', sym: 'VIRTUAL', dec: 18 },
    ],
    'Optimism': [
      { addr: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', sym: 'USDC', dec: 6 },
      { addr: '0x4200000000000000000000000000000000000042', sym: 'OP', dec: 18 },
      { addr: '0x4200000000000000000000000000000000000006', sym: 'WETH', dec: 18 },
    ],
    'Polygon': [
      { addr: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', sym: 'USDC', dec: 6 },
      { addr: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', sym: 'USDT', dec: 6 },
      { addr: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', sym: 'WPOL', dec: 18 },
    ],
    'BSC': [
      { addr: '0x55d398326f99059ff775485246999027b3197955', sym: 'USDT', dec: 18 },
      { addr: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', sym: 'USDC', dec: 18 },
      { addr: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', sym: 'WBNB', dec: 18 },
      { addr: '0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8', sym: 'ORDER', dec: 18 },
    ],
    'Mantle': [
      { addr: '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9', sym: 'USDC', dec: 6 },
      { addr: '0x201eba5cc46d216ce6dc03f6a759e8e766e956ae', sym: 'USDT', dec: 6 },
      { addr: '0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111', sym: 'WETH', dec: 18 },
      { addr: '0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8', sym: 'WMNT', dec: 18 },
    ],
    'Blast': [
      { addr: '0x4300000000000000000000000000000000000004', sym: 'WETH', dec: 18 },
      { addr: '0x4300000000000000000000000000000000000003', sym: 'USDB', dec: 18 },
      { addr: '0xb1a5700fa2358173fe465e6ea4ff52e36e88e2ad', sym: 'BLAST', dec: 18 },
    ],
    'Merlin': [
      { addr: '0x480e158395cc5b41e5584347c495584ca2caf78d', sym: 'MERL', dec: 8 },
      { addr: '0xb880fd278198bd590252621d4cd071b1842e9bcd', sym: 'M-BTC', dec: 18 },
      { addr: '0x967aec3276b63c5e2262da9641db9dbebb07dc0d', sym: 'USDC', dec: 6 },
      { addr: '0x5c46bff4b38dc1eae09c5bac65f31a150b940064', sym: 'MERL', dec: 18 },
    ],
  };

  try {
    const allTokens = [];

    // Process all chains in parallel
    const chainResults = await Promise.allSettled(
      CHAINS.map(async (chain) => {
        // Build known token lookup
        const knownList = KNOWN_TOKENS[chain.name] || [];
        const knownMap = {};
        for (const k of knownList) {
          knownMap[k.addr.toLowerCase()] = k;
        }
        const knownAddrs = knownList.map(k => k.addr.toLowerCase());
        
        // Fetch DexScreener top tokens (non-blocking, best effort)
        let dexTokens = [];
        try { dexTokens = await getTopTokens(chain.slug); } catch(e) {}
        const dexAddrs = dexTokens.map(t => t.address.toLowerCase());
        
        // Merge and dedupe
        const allAddrs = [...new Set([...knownAddrs, ...dexAddrs])];
        
        // Batch check balances
        const balances = await batchBalances(chain.rpcs, allAddrs);
        
        // For tokens with balance, get metadata
        const tokens = [];
        const addrList = Object.keys(balances);
        
        await Promise.all(addrList.map(async (tokenAddr) => {
          const bal = balances[tokenAddr];
          const known = knownMap[tokenAddr];
          const dexInfo = dexTokens.find(t => t.address.toLowerCase() === tokenAddr);
          
          // Use known decimals if available, otherwise fetch
          let decimals = known?.dec;
          if (decimals === undefined) {
            decimals = await getDecimals(chain.rpcs, tokenAddr);
          }
          
          // Use known symbol, then dex, then fetch
          let symbol = known?.sym || dexInfo?.symbol;
          if (!symbol) {
            symbol = await getSymbol(chain.rpcs, tokenAddr) || 'UNK';
          }

          const balFloat = Number(bal) / (10 ** decimals);
          if (balFloat < 0.000001) return;

          tokens.push({
            symbol,
            name: known?.name || dexInfo?.name || symbol,
            chain: chain.name,
            chainSlug: chain.slug,
            balance: balFloat,
            contractAddress: tokenAddr,
            decimals,
            logoUrl: null
          });
        }));

        return tokens;
      })
    );

    for (const r of chainResults) {
      if (r.status === 'fulfilled') allTokens.push(...r.value);
    }

    return res.status(200).json({ tokens: allTokens, source: 'rpc-scan' });

  } catch (err) {
    console.error('EVM token scan error:', err.message);
    return res.status(200).json({ tokens: [], source: 'error', error: err.message });
  }
}
