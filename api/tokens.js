export default async function handler(req, res) {
  // CORS set below after validation
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const addr = req.query.addr;
  if (!addr) return res.status(400).json({ error: 'addr required' });
  // Validate Solana address: base58, 32-44 chars
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr))
    return res.status(400).json({ error: 'invalid address' });
  
  // Restrict origin
  const origin = req.headers.origin || '';
  const allowed = ['https://arthurdex.com', 'https://woofi-dustsweep.vercel.app', 'http://localhost'];
  const corsOrigin = allowed.find(a => origin.startsWith(a)) || allowed[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);

  const RPC = 'https://api.mainnet-beta.solana.com';
  const headers = { 'Content-Type': 'application/json' };

  try {
    // 1. SOL balance
    const balResp = await fetch(RPC, { method: 'POST', headers, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getBalance', params: [addr]
    })});
    const balData = await balResp.json();
    const solBal = (balData?.result?.value || 0) / 1e9;

    // 2. SPL tokens (jsonParsed works fast server-side)
    const splResp = await fetch(RPC, { method: 'POST', headers, body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'getTokenAccountsByOwner',
      params: [addr, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]
    })});
    const splData = await splResp.json();
    const accts = splData?.result?.value || [];

    // 3. Token-2022
    const t22Resp = await fetch(RPC, { method: 'POST', headers, body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'getTokenAccountsByOwner',
      params: [addr, { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { encoding: 'jsonParsed' }]
    })});
    const t22Data = await t22Resp.json();
    const t22Accts = t22Data?.result?.value || [];

    // Merge and deduplicate
    const mintMap = {};
    for (const a of [...accts, ...t22Accts]) {
      const info = a.account.data.parsed.info;
      const amt = parseFloat(info.tokenAmount.uiAmountString || '0');
      const dec = info.tokenAmount.decimals || 6;
      if (amt > 0.000001) {
        if (mintMap[info.mint]) mintMap[info.mint].amount += amt;
        else mintMap[info.mint] = { mint: info.mint, amount: amt, decimals: dec };
      }
    }

    res.status(200).json({
      solBalance: solBal,
      tokens: Object.values(mintMap),
      totalAccounts: accts.length + t22Accts.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
