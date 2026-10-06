const T = require('../transfer-core');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const results = [];
  for (const size of [10e6,100e6,500e6,1e9,5e9]) {
    global.gc?.();
    let maxSlice = 0, peakBuffers = 0, active = 0, maxConcurrent = 0;
    const sample = () => { peakBuffers = Math.max(peakBuffers,process.memoryUsage().arrayBuffers); };
    const file = {name:'synthetic.bin',size,type:'application/octet-stream',slice(start,end) {
      maxSlice = Math.max(maxSlice,end-start);
      return {async arrayBuffer() { const bytes = new Uint8Array(end-start); bytes.fill(start % 251); sample(); return bytes.buffer; }};
    }};
    let parts = 0;
    const api = async (action) => {
      if (action === 'resume') return {parts:[]};
      if (action === 'part') return {url:'https://benchmark.invalid/',headers:{}};
      if (action === 'confirm') parts++;
      return {};
    };
    const oldFetch = global.fetch;
    global.fetch = async () => { active++; maxConcurrent = Math.max(maxConcurrent,active); sample(); await new Promise((r) => setImmediate(r)); active--; return {ok:true}; };
    const start = performance.now();
    try {
      const session = await T.prepare([file]);
      await T.upload([file],session,{api,save:async () => {},progress:sample});
    } finally { global.fetch = oldFetch; }
    const result = {bytes:size,seconds:Number(((performance.now()-start)/1000).toFixed(2)),chunks:parts,maxSliceBytes:maxSlice,peakArrayBufferMB:Number((peakBuffers/1e6).toFixed(1)),maxConcurrentUploads:maxConcurrent};
    results.push(result); console.log(JSON.stringify(result));
    if (maxSlice > T.CHUNK_SIZE || maxConcurrent > 2) throw new Error('Bounded-memory invariant failed.');
  }
  fs.mkdirSync(path.join(__dirname,'..','reports'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'..','reports','transfer-benchmark.json'),JSON.stringify({runtime:process.version,at:new Date().toISOString(),scope:'Synthetic Node WebCrypto engine benchmark; no network/storage or browser memory measurement',results},null,2)+'\n');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
