'use strict';
// FIN-100B disposable test-only preload. Never ship or use outside Docker internal network.
if (process.env.BD05_ISOLATED_TEST !== 'YES' || process.env.NODE_ENV !== 'production') {
  throw Error('BD05 preload refused: isolated test sentinel missing');
}
const originalFetch = globalThis.fetch;
if (typeof originalFetch !== 'function') throw Error('BD05 preload requires native fetch');
const allowedBridge = 'http://flashpay-bd05-http-bridge:56381';
let piGets = 0;
globalThis.fetch = async function bd05Fetch(input, init) {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (typeof target !== 'string') throw Error('BD05 blocked non-string fetch URL');
  const url = new URL(target);
  const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
  if (url.href === 'https://api.minepi.com/v2/me' && method === 'GET') {
    const headers = new Headers(init?.headers || input?.headers || {});
    const token = headers.get('authorization');
    if (token === 'Bearer BD05_TOKEN_MERCHANT_A' || token === 'Bearer BD05_TOKEN_MERCHANT_B') {
      piGets++;
      const isB = token.endsWith('_B');
      return new Response(JSON.stringify({uid: isB ? 'bd05-uid-b' : 'bd05-uid-a',username: isB ? 'bd05-merchant-b' : 'bd05-merchant-a'}),{status:200,headers:{'Content-Type':'application/json'}});
    }
    return new Response(JSON.stringify({error:'BD05 synthetic unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}});
  }
  if (url.origin === allowedBridge && (url.pathname === '/' || url.pathname === '/pipeline') && method === 'POST') {
    return originalFetch(input,init);
  }
  throw Error('BD05 OUTBOUND BLOCKED: '+method+' '+url.origin+url.pathname);
};
process.on('exit',()=>{ if (piGets) console.log('BD05_SYNTHETIC_PI_GETS='+piGets); });
