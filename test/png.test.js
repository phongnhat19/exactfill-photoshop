const zlib = require('zlib');
const P = require('../png.js');

// 1. deflate round-trip on different data
console.log('=== deflate round-trip ===');
const samples = [
  ['zeros 10k',       new Uint8Array(10000)],
  ['identical 0xAB',  new Uint8Array(5000).fill(0xAB)],
  ['random 4k',   Uint8Array.from({length:4000},()=>Math.floor(Math.random()*256))],
  ['gradient',       Uint8Array.from({length:8000},(_,i)=>i&255)],
  ['1 byte',         new Uint8Array([42])],
  ['empty',       new Uint8Array(0)],
  ['boundary 143/144',   Uint8Array.from({length:512},(_,i)=>i<256?i:255-(i-256))],
];
let fail=0;
for(const [name,data] of samples){
  try{
    const z = P.deflateRle(data, 100);
    const back = zlib.inflateSync(Buffer.from(z));
    const same = back.length===data.length && back.every((v,i)=>v===data[i]);
    const ratio = data.length? (z.length/data.length*100).toFixed(1)+'%' : '—';
    console.log(`  ${name.padEnd(16)} ${String(data.length).padStart(6)}B → ${String(z.length).padStart(6)}B (${ratio.padStart(7)})  ${same?'✓ identical':'✗ DIFFERENT'}`);
    if(!same) fail++;
  }catch(e){ console.log(`  ${name.padEnd(16)} ✗ EXCEPTION: ${e.message}`); fail++; }
}

// 2. PNG masks: validity + size
console.log('\n=== buildRectMaskPng ===');
for(const [w,h] of [[1024,1024],[2048,1536],[3840,2160],[816,816]]){
  const png = P.buildRectMaskPng(w,h,{left:w*0.25,top:h*0.25,right:w*0.75,bottom:h*0.75});
  // check the signature and the CRC of every chunk
  const sig=[137,80,78,71,13,10,26,10]; let sigOK=sig.every((v,i)=>png[i]===v);
  const rd=o=>((png[o]<<24)|(png[o+1]<<16)|(png[o+2]<<8)|png[o+3])>>>0;
  let off=8, crcOK=true, chunks=[], idat=null;
  while(off+8<=png.length){
    const len=rd(off), type=String.fromCharCode(png[off+4],png[off+5],png[off+6],png[off+7]);
    const want=rd(off+8+len), got=P.crc32(png.subarray(off+4,off+8+len));
    if(want!==got) crcOK=false;
    chunks.push(type);
    if(type==='IDAT') idat=png.subarray(off+8,off+8+len);
    off+=12+len;
    if(type==='IEND') break;
  }
  let inflOK=false, rawLen=0;
  try{ const r=zlib.inflateSync(Buffer.from(idat)); inflOK=true; rawLen=r.length; }catch(e){}
  const expectRaw = h*(w*4+1);   // RGBA: the input and the mask must be the same format
  console.log(`  ${w}×${h}: ${(png.length/1024).toFixed(1)} KB  sig=${sigOK} crc=${crcOK} chunks=[${chunks}] inflate=${inflOK} raw=${rawLen}/${expectRaw} ${rawLen===expectRaw?'✓':'✗'}`);
  if(!sigOK||!crcOK||!inflOK||rawLen!==expectRaw) fail++;
  if(png.length>4*1024*1024){ console.log('    ✗ EXCEEDED the 4 MB limit'); fail++; }
}

// 3. pHYs
console.log('\n=== setPngResolution ===');
let png = P.buildRectMaskPng(64,64,{left:0,top:0,right:32,bottom:32});
const noPhys = png.length;
png = P.setPngResolution(png, 300);
const withPhys = png.length;
png = P.setPngResolution(png, 300);   // again — must overwrite, not append
const twice = png.length;
const rd=o=>((png[o]<<24)|(png[o+1]<<16)|(png[o+2]<<8)|png[o+3])>>>0;
let off=8, physVal=null, physCount=0, order=[];
while(off+8<=png.length){
  const len=rd(off), type=String.fromCharCode(png[off+4],png[off+5],png[off+6],png[off+7]);
  order.push(type);
  if(type==='pHYs'){ physCount++; physVal=rd(off+8); }
  off+=12+len; if(type==='IEND') break;
}
console.log(`  without pHYs ${noPhys}B → with pHYs ${withPhys}B → again ${twice}B (must = ${withPhys})`);
console.log(`  pHYs chunks: ${physCount} (must 1), value: ${physVal} px/m (300ppi → 11811), order: [${order}]`);
const physOK = physCount===1 && physVal===11811 && twice===withPhys && order.indexOf('pHYs')===1;
console.log(`  ${physOK?'✓':'✗ PROBLEM'}`);
if(!physOK) fail++;

// 4. readPngSize
console.log('\n=== readPngSize ===');
const p2=P.buildRectMaskPng(333,222,{left:1,top:1,right:9,bottom:9});
const sz=P.readPngSize(p2);
console.log(`  333×222 → ${sz.w}×${sz.h} ${sz.w===333&&sz.h===222?'✓':'✗'}`);
if(sz.w!==333||sz.h!==222) fail++;
try{ P.readPngSize(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24])); console.log('  non-PNG → ✗ did not throw'); fail++; }
catch(e){ console.log(`  non-PNG → ✓ "${e.message}"`); }

// 5. Soft mask edge. Checked not by eye but by three alpha values:
//    inside 0 (change), exactly on the edge 128 (a symmetric gradient),
//    outside the band 255 (keep). And that compression of the gradient does not fall apart.
console.log('\n=== buildRectMaskPng: soft edge ===');
{
  const W=1024,H=1024,R={left:200,top:150,right:800,bottom:650};
  const stride=W*4+1;
  for(const f of [0,4,8,16,32,64,128,256]){
    const png=P.buildRectMaskPng(W,H,R,f);
    let off=8,idat=null;
    while(off<png.length){
      const len=(png[off]<<24|png[off+1]<<16|png[off+2]<<8|png[off+3])>>>0;
      const t=String.fromCharCode(png[off+4],png[off+5],png[off+6],png[off+7]);
      if(t==='IDAT'){ idat=png.slice(off+8,off+8+len); break; }
      off+=12+len;
    }
    const raw=zlib.inflateSync(Buffer.from(idat));
    const alpha=(x,y)=>raw[y*stride+1+x*4+3];
    const inside=alpha(500,400), edge=alpha(R.left,400), outside=alpha(100,400);
    // For a very wide feather the point x=100 itself already lies in the gradient;
    // then we check that it is lighter than the edge, rather than requiring alpha=255.
    const outsideOk = f <= 64 ? outside===255 : outside>edge;
    const ok = raw.length===H*stride && inside===0 && outsideOk &&
               (f<1 ? edge===0 : Math.abs(edge-128)<=1);
    console.log(`  edge ${String(f).padStart(2)} px: ${(png.length/1024).toFixed(1)} KB  `+
                `alpha inside=${inside} on the edge=${edge} outside=${outside} ${ok?'✓':'✗'}`);
    if(!ok) fail++;
  }
  // a gradient wider than half the area must not eat the change zone entirely
  const tiny=P.buildRectMaskPng(64,64,{left:20,top:20,right:30,bottom:30},64);
  console.log(`  narrow area + edge 64 px: assembled, ${tiny.length} B ✓ (feather is clamped)`);
}

// 6. The deflate window. REGRESSION: RLE took a match from the previous row at
//    distance rowStride, but deflate allows distance ≤ 32768 (RFC 1951 §3.2.5). On
//    a wide canvas rowStride stuck out of the window, putDistance silently wrote a
//    truncated number — and the stream became INVALID. The user's symptom: the mask
//    or the input is a broken PNG, the server answers 400 or silently ignores the mask.
//    The LOSSLESS_MAX_PX threshold (2 MP) does NOT save it: a 11000×180 strip = 1.98 MP
//    passes it, and stride 33001 is already outside the window. A mask has no threshold at all.
console.log('\n=== deflate window (distance ≤ 32768) ===');
{
  for (const stride of [32767, 32768, 32769, 40000, 65537]) {
    const rows = new Uint8Array(200000);
    for (let i = 0; i < rows.length; i++) rows[i] = (i % stride) & 255;  // twin rows
    let ok = false, note = '';
    try {
      const back = zlib.inflateSync(Buffer.from(P.deflateRle(rows, stride)));
      ok = back.length === rows.length && back.every((v, i) => v === rows[i]);
    } catch (e) { note = ' ' + e.message; }
    console.log(`  stride ${String(stride).padStart(5)}: ${ok ? '✓ valid stream' : '✗ STREAM BROKEN' + note}`);
    if (!ok) fail++;
  }
  // Real sizes at which this shows up for the user.
  for (const [w, h, what] of [[8192, 64, 'RGBA mask'], [10923, 180, 'RGB input']]) {
    let ok = false, note = '';
    try {
      const png = what.includes('mask')
        ? P.buildRectMaskPng(w, h, { left: 10, top: 10, right: w - 10, bottom: h - 10 }, 8)
        : P.encodePng(new Uint8Array(w * h * 3).fill(0x77), w, h, 3);
      const rd = o => ((png[o]<<24)|(png[o+1]<<16)|(png[o+2]<<8)|png[o+3])>>>0;
      let off = 8, idat = [];
      while (off + 8 <= png.length) {
        const len = rd(off), t = String.fromCharCode(png[off+4],png[off+5],png[off+6],png[off+7]);
        if (t === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
        off += 12 + len; if (t === 'IEND') break;
      }
      const raw = zlib.inflateSync(Buffer.concat(idat.map(Buffer.from)));
      const comps = what.includes('mask') ? 4 : 3;
      ok = raw.length === h * (w * comps + 1);
    } catch (e) { note = ' ' + e.message; }
    console.log(`  ${what} ${w}×${h}: ${ok ? '✓ readable' : '✗ BROKEN' + note}`);
    if (!ok) fail++;
  }
}

console.log('\nFAILURES:',fail);
process.exit(fail?1:0);
