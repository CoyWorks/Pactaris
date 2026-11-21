import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,rm,link} from 'node:fs/promises';
import {join} from 'node:path';

/** Completion proof is intimate content. It is stored only on the instance's own disk,
 *  metadata-stripped (EXIF/GPS and text removed) and encrypted at rest with AES-256-GCM.
 *  Bytes never leave the instance except, decrypted, through an authorized command stream. */
export type ProofType='image/jpeg'|'image/png'|'image/webp';
export const proofTypes:readonly ProofType[]=['image/jpeg','image/png','image/webp'];
export const maxProofBytes=5*1024*1024;
const uuidLike=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

/** Sniff the real type from magic bytes; a declared type that disagrees is rejected by the caller. */
export function sniffProof(bytes:Buffer):ProofType|undefined{
 if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
 if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'image/png';
 if(bytes.length>=12&&bytes.subarray(0,4).toString('latin1')==='RIFF'&&bytes.subarray(8,12).toString('latin1')==='WEBP')return 'image/webp';
 return undefined;
}

/** Remove metadata-bearing segments/chunks without a full re-encode (no native dependency). */
export function stripMetadata(type:ProofType,bytes:Buffer):Buffer{
 if(type==='image/jpeg')return stripJpeg(bytes);
 if(type==='image/png')return stripPng(bytes);
 return stripWebp(bytes);
}
// JPEG: drop every APPn (0xE0–0xEF, incl. EXIF/XMP in APP1) and COM (0xFE); keep structural segments and scan.
function stripJpeg(bytes:Buffer):Buffer{
 const out:Buffer[]=[];let i=0;
 if(bytes.length<2||bytes[0]!==0xff||bytes[1]!==0xd8)throw new ProofError('type');
 out.push(bytes.subarray(0,2));i=2;
 while(i+1<bytes.length){
  if(bytes[i]!==0xff){throw new ProofError('type');}
  let marker=bytes[i+1];if(marker===undefined)throw new ProofError('type');
  while(marker===0xff&&i+2<bytes.length){i++;const m=bytes[i+1];if(m===undefined)throw new ProofError('type');marker=m;}
  if(marker===0xd9){out.push(bytes.subarray(i,i+2));break;}
  if(marker===0xda){out.push(bytes.subarray(i));break;} // start of scan: copy the rest verbatim
  if(i+4>bytes.length)throw new ProofError('type');
  const len=bytes.readUInt16BE(i+2);if(len<2||i+2+len>bytes.length)throw new ProofError('type');
  const drop=(marker>=0xe0&&marker<=0xef)||marker===0xfe;
  if(!drop)out.push(bytes.subarray(i,i+2+len));
  i+=2+len;
 }
 return Buffer.concat(out);
}
// PNG: keep all chunks except ancillary metadata ones (EXIF, text, time).
function stripPng(bytes:Buffer):Buffer{
 const sig=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
 if(bytes.length<8||!bytes.subarray(0,8).equals(sig))throw new ProofError('type');
 const drop=new Set(['eXIf','tEXt','zTXt','iTXt','tIME']);
 const out:Buffer[]=[bytes.subarray(0,8)];let i=8;
 while(i+8<=bytes.length){
  const len=bytes.readUInt32BE(i);if(len>bytes.length)throw new ProofError('type');
  const name=bytes.subarray(i+4,i+8).toString('latin1');const end=i+12+len;if(end>bytes.length)throw new ProofError('type');
  if(!drop.has(name))out.push(bytes.subarray(i,end));
  i=end;if(name==='IEND')break;
 }
 return Buffer.concat(out);
}
// WebP (RIFF): keep image chunks, drop EXIF and XMP; rewrite the RIFF size.
function stripWebp(bytes:Buffer):Buffer{
 if(bytes.length<12||bytes.subarray(0,4).toString('latin1')!=='RIFF'||bytes.subarray(8,12).toString('latin1')!=='WEBP')throw new ProofError('type');
 const drop=new Set(['EXIF','XMP ']);const body:Buffer[]=[];let i=12;
 while(i+8<=bytes.length){
  const name=bytes.subarray(i,i+4).toString('latin1');const len=bytes.readUInt32LE(i+4);
  const padded=len+(len%2);const end=i+8+padded;if(end>bytes.length)throw new ProofError('type');
  if(!drop.has(name))body.push(bytes.subarray(i,end));
  i=end;
 }
 const payload=Buffer.concat(body);const head=Buffer.alloc(12);head.write('RIFF',0,'latin1');head.writeUInt32LE(4+payload.length,4);head.write('WEBP',8,'latin1');
 return Buffer.concat([head,payload]);
}

export class ProofError extends Error{constructor(public kind:'type'|'size'|'key'|'missing'|'corrupt'){super('proof.'+kind);}}

export class ProofStore{
 private key:Buffer;
 constructor(private root:string,keyHex:string){
  if(!/^[0-9a-f]{64}$/i.test(keyHex))throw new ProofError('key');
  this.key=Buffer.from(keyHex,'hex');
 }
 private dir(householdId:string){if(!uuidLike(householdId))throw new ProofError('missing');return join(this.root,householdId);}
 private path(householdId:string,proofId:string){if(!uuidLike(proofId))throw new ProofError('missing');return join(this.dir(householdId),proofId);}
 /** Validate and strip metadata without touching the disk. */
 prepare(declaredType:string,bytes:Buffer):{type:ProofType;clean:Buffer;size:number;sha256:string}{
  if(bytes.length===0||bytes.length>maxProofBytes)throw new ProofError('size');
  const sniffed=sniffProof(bytes);
  if(!sniffed||sniffed!==declaredType)throw new ProofError('type');
  const clean=stripMetadata(sniffed,bytes);
  if(clean.length===0||clean.length>maxProofBytes)throw new ProofError('size');
  return {type:sniffed,clean,size:clean.length,sha256:createHash('sha256').update(clean).digest('hex')};
 }
 /** Validate, strip metadata, encrypt and write. Returns the stored size and a sha256 of the clean image. */
 async put(householdId:string,proofId:string,declaredType:string,bytes:Buffer):Promise<{size:number;sha256:string}>{
  const prepared=this.prepare(declaredType,bytes);
  await this.write(householdId,proofId,prepared.type,prepared.clean);
  return {size:prepared.size,sha256:prepared.sha256};
 }
 /** Encrypt and write an already prepared image. An existing file is never overwritten: returns false then. */
 async write(householdId:string,proofId:string,type:ProofType,clean:Buffer):Promise<boolean>{
  // plaintext = type(1 byte index) + image; authenticated as a whole by GCM.
  const plain=Buffer.concat([Buffer.from([proofTypes.indexOf(type)]),clean]);
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
  const body=Buffer.concat([cipher.update(plain),cipher.final()]),tag=cipher.getAuthTag();
  const file=Buffer.concat([iv,tag,body]);
  const dir=this.dir(householdId);await mkdir(dir,{recursive:true,mode:0o700});
  const target=this.path(householdId,proofId),tmp=target+'.tmp';
  await rm(tmp,{force:true});await writeFile(tmp,file,{mode:0o600,flag:'wx'});
  try{await link(tmp,target);return true;}
  catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='EEXIST')return false;throw error;}
  finally{await rm(tmp,{force:true});}
 }
 /** Decrypt and return the clean image for an already-authorized read. */
 async get(householdId:string,proofId:string):Promise<{type:ProofType;bytes:Buffer}>{
  let file:Buffer;
  try{file=await readFile(this.path(householdId,proofId));}catch{throw new ProofError('missing');}
  if(file.length<=28)throw new ProofError('corrupt');
  const iv=file.subarray(0,12),tag=file.subarray(12,28),body=file.subarray(28);
  try{
   const decipher=createDecipheriv('aes-256-gcm',this.key,iv);decipher.setAuthTag(tag);
   const plain=Buffer.concat([decipher.update(body),decipher.final()]);
   const type=plain[0]===undefined?undefined:proofTypes[plain[0]];if(!type)throw new ProofError('corrupt');
   return {type,bytes:plain.subarray(1)};
  }catch{throw new ProofError('corrupt');}
 }
 async delete(householdId:string,proofId:string):Promise<void>{await rm(this.path(householdId,proofId),{force:true});}
 async deleteHousehold(householdId:string):Promise<void>{await rm(this.dir(householdId),{recursive:true,force:true});}
}
