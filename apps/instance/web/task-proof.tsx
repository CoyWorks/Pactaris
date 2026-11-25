import React,{useEffect,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {ApprovalDetail,ApprovalItem,PartnerResult,TaskApprover,TaskProofState} from '../../../packages/auth/partner.js';
import {Hint,Layer} from './navigation.js';

const proofFailure=(e:unknown):MessageKey=>['proof.invalid','proof.denied','proof.conflict','proof.paused','proof.gone','proof.unavailable','errors.request','errors.rateLimited'].includes((e as {messageKey:string})?.messageKey)?(e as {messageKey:MessageKey}).messageKey:'proof.unavailable';
const decisionKeys={approved:'partner.approvalApproved',changes:'partner.approvalChanges'} as const;

/** Re-encodes a photo in the browser before upload: at most 1600 px on the long side, JPEG. This also
 *  drops camera metadata; the instance strips metadata again and rejects anything that is not an image. */
async function shrink(file:File):Promise<{type:string;bytes:Blob}>{
 try{
  const bitmap=await createImageBitmap(file),scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d');if(!context)throw Error('canvas');context.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',0.85));if(!blob)throw Error('encode');
  return {type:'image/jpeg',bytes:blob};
 }catch{return {type:file.type,bytes:file};}
}

/** The assignee's photo before submitting: add, replace or remove. */
export function ProofAttach({householdId,csrfToken,taskId,proof,language,disabled,onChanged}:{householdId:string;csrfToken:string;taskId:string;proof?:TaskProofState|null;language:string;disabled:boolean;onChanged:()=>void}){
 const t=createTranslator(language),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>();
 const pending=proof&&!proof.bound&&proof.state==='stored'?proof:undefined;
 // A local preview of the photo picked on this device; the stored copy is not shown back.
 const [preview,setPreview]=useState<string>();
 useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview);},[preview]);
 async function upload(file:File){
  setBusy(true);setError(undefined);
  try{
   const image=await shrink(file);
   const r=await fetch(`/api/households/${householdId}/participant-tasks/${taskId}/proof`,{method:'POST',cache:'no-store',headers:{'Content-Type':image.type,'X-CSRF-Token':csrfToken,'X-Operation-Id':crypto.randomUUID()},body:image.bytes});
   if(!r.ok)throw await r.json().catch(()=>({}));setPreview(URL.createObjectURL(image.bytes));onChanged();
  }catch(e){setError(proofFailure(e));}finally{setBusy(false);}
 }
 async function remove(){
  if(!pending)return;setBusy(true);setError(undefined);
  try{
   setPreview(undefined);
   const r=await fetch(`/api/households/${householdId}/proofs/${pending.proofId}/remove`,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({operationId:crypto.randomUUID()})});
   if(!r.ok)throw await r.json().catch(()=>({}));onChanged();
  }catch(e){setError(proofFailure(e));}finally{setBusy(false);}
 }
 return <section className="settings-group"><h4>{t('proof.title')}</h4><Hint label={t('hint.more')}>{t('proof.attachHelp')}</Hint>
  {pending&&<p>{t('proof.attached')}</p>}{pending&&preview&&<img className="proof-preview" src={preview} alt={t('proof.previewAlt')}/>}{busy&&<p role="status">{t('proof.uploading')}</p>}{error&&<p role="alert">{t(error)}</p>}
  <label className="button">{t(pending?'proof.replace':'proof.attach')}<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden disabled={disabled||busy}
   onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void upload(file);}}/></label>
  {pending&&<button type="button" className="secondary" disabled={disabled||busy} onClick={()=>{void remove();}}>{t('proof.remove')}</button>}
 </section>;
}

/** Opens a proof photo for a reviewer. The first full view uses up their single view. */
export function ProofViewer({householdId,csrfToken,proof,language,format,timeZone}:{householdId:string;csrfToken:string;proof?:TaskProofState|null;language:string;format:string;timeZone:string}){
 const t=createTranslator(language),[url,setUrl]=useState<string>(),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>();
 useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
 if(!proof||!proof.bound)return null;
 async function open(){
  if(!proof)return;setBusy(true);setError(undefined);
  try{
   const r=await fetch(`/api/households/${householdId}/proofs/${proof.proofId}/view`,{method:'POST',cache:'no-store',headers:{'X-CSRF-Token':csrfToken}});
   if(!r.ok)throw await r.json().catch(()=>({}));
   setUrl(URL.createObjectURL(await r.blob()));
  }catch(e){setError(proofFailure(e));}finally{setBusy(false);}
 }
 return <section className="settings-group"><h4>{t('proof.title')}</h4>
  {url?<><img src={url} alt={t('proof.alt')} className="proof-image"/><p className="muted">{t('proof.viewOnce')}</p></>
   :proof.available?<>{proof.consumes&&<p>{t('proof.viewOnce')}</p>}<p className="muted">{t('proof.expires')} <time dateTime={proof.expiresAt}>{formatTime(new Date(proof.expiresAt),format,timeZone)}</time></p>
    <button type="button" disabled={busy} onClick={()=>{void open();}}>{t('proof.view')}</button></>
   :<p className="muted">{t(proof.consumes||proof.state!=='viewed'?'proof.gone':'proof.viewed')}</p>}
  {error&&<p role="alert">{t(error)}</p>}
 </section>;
}

/** Who must approve in the current round, and what each decided. */
export function ApprovalRound({approvals,language}:{approvals?:TaskApprover[];language:string}){
 const t=createTranslator(language);
 if(!approvals?.length)return null;
 return <section><h4>{t('partner.approvals')}</h4><Hint label={t('hint.more')}>{t('partner.approvalHelp')}</Hint>
  <ul>{approvals.map(a=><li key={a.membershipId}><span>{a.name||t('partner.unnamed')}</span> <span className="muted">{t(a.decision?decisionKeys[a.decision]:'partner.approvalWaiting')}</span></li>)}</ul></section>;
}

/** Tasks waiting for this member's approval, including ones they did not create (a delegated reviewer). */
export function ApprovalQueue({householdId,csrfToken,language,format,timeZone,refresh,blocked,onDecided}:{householdId:string;csrfToken:string;language:string;format:string;timeZone:string;refresh:number;blocked:boolean;onDecided:()=>void}){
 const t=createTranslator(language),[items,setItems]=useState<ApprovalItem[]>(),[open,setOpen]=useState<ApprovalDetail>(),[note,setNote]=useState(''),[asking,setAsking]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[reload,setReload]=useState(0);
 const base=`/api/households/${householdId}/participant-tasks/`;
 async function call(action:string,input:Record<string,unknown>){
  const r=await fetch(base+action,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),...input})}),data=await r.json();
  if(!r.ok)throw data;return data as PartnerResult;
 }
 useEffect(()=>{let gone=false;void call('approvalList',{}).then(r=>{if(!gone)setItems(r.approvals??[]);}).catch(()=>{if(!gone)setItems([]);});return()=>{gone=true;};},[householdId,refresh,reload]);// eslint-disable-line react-hooks/exhaustive-deps
 async function read(taskId:string){setBusy(true);setError(undefined);try{const r=await call('approvalRead',{taskId});setOpen(r.approval);setNote('');setAsking(false);}catch(e){setError(((e as {messageKey?:MessageKey})?.messageKey)??'partner.unavailable');}finally{setBusy(false);}}
 async function decide(action:'partnerApprove'|'partnerChanges'){
  if(!open)return;setBusy(true);setError(undefined);
  try{await call(action,{taskId:open.taskId,version:open.version,epoch:open.epoch,safetyVersion:open.safetyVersion,...(action==='partnerChanges'?{note:note.trim()}:{})});setOpen(undefined);setReload(v=>v+1);onDecided();}
  catch(e){setError(((e as {messageKey?:MessageKey})?.messageKey)??'partner.unavailable');}finally{setBusy(false);}
 }
 if(!items?.length&&!open)return null;
 return <section><h3>{t('partner.awaitingYou')}</h3>
  <ul className="task-list">{items?.map(item=><li key={item.taskId}><h4>{item.title}</h4><p>{t('partner.doneBy')} {item.assigneeName||t('partner.unnamed')}</p><p className="muted">{t('partner.givenBy')} {item.creatorName||t('partner.unnamed')}</p>
   {item.submittedAt&&<time dateTime={item.submittedAt}>{formatTime(new Date(item.submittedAt),format,timeZone)}</time>}
   <button type="button" disabled={blocked||busy} onClick={()=>{void read(item.taskId);}}>{t('partner.review')}</button></li>)}</ul>
  {open&&<Layer title={open.title} backLabel={t('nav.back')} onClose={()=>setOpen(undefined)} status={error&&<p role="alert">{t(error)}</p>}><article className="document-detail">
   <h3>{open.title}</h3><p className="document-body">{open.description}</p>
   <p>{t('partner.doneBy')} {open.assigneeName||t('partner.unnamed')}</p><p className="muted">{t('partner.givenBy')} {open.creatorName||t('partner.unnamed')}</p>
   {open.note&&<section><h4>{t('partner.submission')}</h4><p className="document-body">{open.note}</p></section>}
   <ProofViewer householdId={householdId} csrfToken={csrfToken} proof={open.proof} language={language} format={format} timeZone={timeZone}/>
   <ApprovalRound approvals={open.approvals} language={language}/>
   {open.canDecide&&!asking&&<div className="workspace-actions"><button type="button" disabled={busy} onClick={()=>{void decide('partnerApprove');}}>{t('partner.approve')}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setAsking(true)}>{t('partner.requestChanges')}</button></div>}
   {open.canDecide&&asking&&<form className="notice" onSubmit={e=>{e.preventDefault();void decide('partnerChanges');}}><p>{t('partner.changesNotice')}</p><label>{t('partner.feedback')}<textarea required maxLength={500} disabled={busy} value={note} onChange={e=>setNote(e.target.value)}/></label>
    <button type="submit" disabled={busy||!note.trim()}>{t('partner.requestChanges')}</button><button type="button" disabled={busy} onClick={()=>setAsking(false)}>{t('onboarding.cancel')}</button></form>}
   {!open.canDecide&&<p className="muted">{t('partner.alreadyDecided')}</p>}
   <button type="button" disabled={busy} onClick={()=>setOpen(undefined)}>{t('library.close')}</button>
  </article></Layer>}
 </section>;
}
