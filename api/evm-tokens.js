export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const addr = req.query.addr;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr))
    return res.status(400).json({ error: 'valid EVM address required' });

  const origin = req.headers.origin || '';
  const allowed = ['https://arthurdex.com', 'https://woofi-dustsweep.vercel.app', 'http://localhost'];
  const corsOrigin = allowed.find(a => origin.startsWith(a)) || allowed[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);

  // Chain mapping for Ankr blockchain names
  const ANKR_CHAINS = {
    'eth': { name: 'Ethereum', chainId: 1 },
    'arbitrum': { name: 'Arbitrum', chainId: 42161 },
    'base': { name: 'Base', chainId: 8453 },
    'optimism': { name: 'Optimism', chainId: 10 },
    'polygon': { name: 'Polygon', chainId: 137 },
    'bsc': { name: 'BSC', chainId: 56 },
    'mantle': { name: 'Mantle', chainId: 5000 },
  };

  try {
    // Try Ankr multichain API (free, no key needed)
    const ankrResp = await fetch('https://rpc.ankr.com/multichain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'ankr_getAccountBalance',
        params: {
          walletAddress: addr,
          blockchain: Object.keys(ANKR_CHAINS),
          onlyWhitelisted: false,
          pageSize: 500
        }
      })
    });

    if (!ankrResp.ok) throw new Error('Ankr HTTP ' + ankrResp.status);
    const ankrData = await ankrResp.json();

    if (ankrData.error) throw new Error(ankrData.error.message || 'Ankr error');

    const assets = ankrData.result?.assets || [];
    const tokens = [];

    for (const a of assets) {
      // Skip native tokens (handled by frontend) and zero balances
      if (!a.contractAddress || a.contractAddress === '0x0000000000000000000000000000000000000000') continue;
      const bal = parseFloat(a.balance || '0');
      if (bal <= 0) continue;

      const chainInfo = ANKR_CHAINS[a.blockchain];
      if (!chainInfo) continue;

      tokens.push({
        symbol: a.tokenSymbol || 'UNK',
        name: a.tokenName || 'Unknown',
        chain: chainInfo.name,
        chainId: chainInfo.chainId,
        balance: bal,
        contractAddress: a.contractAddress,
        decimals: a.tokenDecimals || 18,
        logoUrl: a.thumbnail || null
      });
    }

    return res.status(200).json({ tokens, source: 'ankr' });

  } catch (ankrErr) {
    // Fallback: scan known popular tokens via multicall on each chain
    console.error('Ankr failed:', ankrErr.message);

    // Minimal fallback - just return empty with error info
    // A full fallback would need multicall contracts per chain
    return res.status(200).json({
      tokens: [],
      source: 'fallback',
      error: 'Ankr unavailable: ' + ankrErr.message
    });
  }
}
