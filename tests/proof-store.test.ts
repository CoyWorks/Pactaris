import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile}from 'node:fs/promises';
import {tmpdir}from 'node:os';
import {join}from 'node:path';
import {randomUUID,randomBytes}from 'node:crypto';
import {ProofStore,ProofError,sniffProof,stripMetadata,proofTypes}from '../apps/instance/proof-store.js';

const keyHex=randomBytes(32).toString('hex');
// Minimal structurally-parseable images carrying a metadata segment/chunk.
function jpeg(withExif:boolean){
 const parts=[Buffer.from([0xff,0xd8])]; // SOI
 if(withExif){const exif=Buffer.from('Exif\0\0'+'GPS 51.9 4.5 secret','latin1');const seg=Buffer.alloc(4+exif.length);seg[0]=0xff;seg[1]=0xe1;seg.writeUInt16BE(2+exif.length,2);exif.copy(seg,4);parts.push(seg);}
 const sof=Buffer.alloc(4);sof[0]=0xff;sof[1]=0xc0;sof.writeUInt16BE(2,2); // zero-length-ish frame header (structural only)
 parts.push(sof);
 parts.push(Buffer.from([0xff,0xda,0x00,0x02]));parts.push(Buffer.from([0x11,0x22,0x33])); // SOS + scan data
 parts.push(Buffer.from([0xff,0xd9])); // EOI
 return Buffer.concat(parts);
}
function png(withText:boolean){
 const sig=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
 const chunk=(name:string,data:Buffer)=>{const b=Buffer.alloc(12+data.length);b.writeUInt32BE(data.length,0);b.write(name,4,'latin1');data.copy(b,8);b.writeUInt32BE(0,8+data.length);return b;};
 const parts=[sig,chunk('IHDR',Buffer.alloc(13))];
 if(withText)parts.push(chunk('tEXt',Buffer.from('Comment\0secret location','latin1')),chunk('eXIf',Buffer.from('gps-data','latin1')));
 parts.push(chunk('IDAT',Buffer.from([1,2,3])),chunk('IEND',Buffer.alloc(0)));
 return Buffer.concat(parts);
}
function webp(withExif:boolean){
 const sub=(name:string,data:Buffer)=>{const pad=data.length%2;const b=Buffer.alloc(8+data.length+pad);b.write(name,0,'latin1');b.writeUInt32LE(data.length,4);data.copy(b,8);return b;};
 const chunks=[sub('VP8L',Buffer.from([0x2f,0,0,0,0]))];
 if(withExif)chunks.push(sub('EXIF',Buffer.from('gps secret','latin1')),sub('XMP ',Buffer.from('<x>meta</x>','latin1')));
 const payload=Buffer.concat(chunks);const head=Buffer.alloc(12);head.write('RIFF',0,'latin1');head.writeUInt32LE(4+payload.length,4);head.write('WEBP',8,'latin1');
 return Buffer.concat([head,payload]);
}

test('proof store: sniffing, stripping, round-trip, access and tamper',async()=>{
 const root=await mkdtemp(join(tmpdir(),'proof-'));
 try{
  const store=new ProofStore(root,keyHex);
  assert.throws(()=>new ProofStore(root,'short'),(e:unknown)=>e instanceof ProofError&&e.kind==='key');

  // Sniffing recognises the three types and rejects others.
  assert.equal(sniffProof(jpeg(false)),'image/jpeg');
  assert.equal(sniffProof(png(false)),'image/png');
  assert.equal(sniffProof(webp(false)),'image/webp');
  assert.equal(sniffProof(Buffer.from('%PDF-1.7')),undefined);

  // Metadata is removed; the secret strings must not survive.
  for(const [type,withMeta] of [['image/jpeg',jpeg(true)],['image/png',png(true)],['image/webp',webp(true)]] as const){
   const stripped=stripMetadata(type,withMeta);
   assert.ok(!stripped.toString('latin1').includes('secret'),type+' kept metadata');
  }

  const hh=randomUUID(),id=randomUUID();
  const {size,sha256}=await store.put(hh,id,'image/jpeg',jpeg(true));
  assert.ok(size>0&&/^[0-9a-f]{64}$/.test(sha256));

  // On disk it is encrypted: the GPS text is gone and the plaintext is not readable.
  const onDisk=await readFile(join(root,hh,id));
  assert.ok(!onDisk.toString('latin1').includes('secret')&&!onDisk.toString('latin1').includes('GPS'));

  // An authorized read returns the clean image and its declared type.
  const got=await store.get(hh,id);assert.equal(got.type,'image/jpeg');assert.ok(!got.bytes.toString('latin1').includes('secret'));

  // A second write for the same id keeps the first file.
  const again=store.prepare('image/jpeg',jpeg(false));
  assert.equal(await store.write(hh,id,again.type,again.clean),false);
  assert.ok((await readFile(join(root,hh,id))).equals(onDisk));

  // Declared type must match the real bytes; oversize and empty are rejected.
  await assert.rejects(store.put(hh,randomUUID(),'image/png',jpeg(false)),(e:unknown)=>e instanceof ProofError&&e.kind==='type');
  await assert.rejects(store.put(hh,randomUUID(),'image/jpeg',Buffer.alloc(0)),(e:unknown)=>e instanceof ProofError&&e.kind==='size');

  // A different key cannot decrypt; tampering is detected.
  const other=new ProofStore(root,randomBytes(32).toString('hex'));
  await assert.rejects(other.get(hh,id),(e:unknown)=>e instanceof ProofError&&e.kind==='corrupt');
  const corrupt=await readFile(join(root,hh,id));corrupt[20]=(corrupt[20]??0)^0xff;await writeFile(join(root,hh,id),corrupt);
  await assert.rejects(store.get(hh,id),(e:unknown)=>e instanceof ProofError&&e.kind==='corrupt');

  // Missing reads and household-wide deletion.
  await assert.rejects(store.get(hh,randomUUID()),(e:unknown)=>e instanceof ProofError&&e.kind==='missing');
  await store.deleteHousehold(hh);
  await assert.rejects(store.get(hh,id),(e:unknown)=>e instanceof ProofError&&e.kind==='missing');
  assert.equal(proofTypes.length,3);
 }finally{await rm(root,{recursive:true,force:true});}
});
