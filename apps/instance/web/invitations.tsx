import React,{useEffect,useState} from 'react';
import {Hint} from './navigation.js';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import {signInHref} from './auto-sign-in.js';
import {EmailVerificationNotice} from './email-verification.js';
type Session={account:{id:string;displayName:string};csrfToken:string;emailVerified?:boolean};
type Invite={invitationId:string;status:string;role:string;expiresAt:string;delivery?:string};
const errorKey=(key:unknown):MessageKey=>(['invitations.invalid','invitations.denied','invitations.conflict','invitations.capacity','invitations.proof','invitations.unavailable','errors.rateLimited','errors.request'] as unknown[]).includes(key)?key as MessageKey:'invitations.unavailable';
function secret(){const data=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...data)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
export function InvitationManager({householdId,session,language,format,timeZone}:{householdId:string;session:Session;language:string;format:string;timeZone:string}){
 const [emailEnabled,setEmailEnabled]=useState(false);
 const t=createTranslator(language),[items,setItems]=useState<Invite[]>(),[allowed,setAllowed]=useState(false),[email,setEmail]=useState(''),[draft,setDraft]=useState<{id:string;token:string}>(),[link,setLink]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[refresh,setRefresh]=useState(0),[copied,setCopied]=useState(false),[revokeIds,setRevokeIds]=useState<Record<string,string>>({});
 useEffect(()=>{
  const controller=new AbortController();let gone=false;
  void fetch('/api/households/'+householdId+'/invitations',{cache:'no-store',signal:controller.signal}).then(async r=>{
   if(r.status===404||r.status===403){if(!gone)setAllowed(false);return;}
   const body=await r.json();if(!r.ok)throw Error('list');if(!gone){setAllowed(true);setItems(body.invitations);setEmailEnabled(body.emailEnabled===true);}
  }).catch(()=>{if(!gone)setError('invitations.unavailable');});
  return()=>{gone=true;controller.abort();};
 },[householdId,session.account.id,refresh]);
 async function create(event:React.FormEvent){
  event.preventDefault();if(busy||link)return;
  const current=draft??{id:crypto.randomUUID(),token:secret()};setDraft(current);setBusy(true);setError(undefined);
  try{
   const r=await fetch('/api/households/'+householdId+'/invitations',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId:current.id,token:current.token,email:email.trim()})}),body=await r.json();
   if(!r.ok){setError(errorKey(body.messageKey));return;}
   const url=new URL('/join',window.location.origin);url.hash=body.invitationId+'.'+current.token;setLink(url.href);setRefresh(v=>v+1);
  }catch{setError('invitations.unknownCreate');}finally{setBusy(false);}
 }
 async function revoke(id:string){
  if(busy)return;setBusy(true);setError(undefined);const operationId=revokeIds[id]??crypto.randomUUID();setRevokeIds(v=>({...v,[id]:operationId}));
  try{const r=await fetch('/api/households/'+householdId+'/invitations/'+id+'/revoke',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId})}),body=await r.json();
   if(!r.ok){setError(errorKey(body.messageKey));return;}setRefresh(v=>v+1);if(link.includes(id))setLink('');
  }catch{setError('invitations.unavailable');}finally{setBusy(false);}
 }
 const stateKeys:Record<string,MessageKey>={pending:'invitations.state.pending',accepted:'invitations.state.accepted',declined:'invitations.state.declined',revoked:'invitations.state.revoked',inactive:'invitations.state.inactive'};
 const deliveryKeys:Record<string,MessageKey>={queued:'invitations.delivery.queued',sent:'invitations.delivery.sent',
  failed:'invitations.delivery.failed',inactive:'invitations.delivery.inactive'};
 const stateKey=(value:string):MessageKey=>stateKeys[value]??'invitations.state.inactive';
 if(!allowed)return error?<p role="alert">{t(error)}</p>:null;
 return <section><h2>{t('invitations.title')}</h2><Hint label={t('hint.more')}>{t('invitations.createDescription')}</Hint>
  {emailEnabled&&<p>{t('invitations.emailEnabled')}</p>}
  {error&&<p role="alert">{t(error)}</p>}
  <form onSubmit={event=>{void create(event);}}><label htmlFor="invite-email">{t('invitations.email')}</label>
   <input id="invite-email" type="email" autoComplete="off" maxLength={254} required value={email} disabled={busy||!!draft} onChange={e=>setEmail(e.target.value)}/>
   {!link&&<button type="submit" disabled={busy||!email.trim()}>{t(draft?'onboarding.retry':'invitations.create')}</button>}
  </form>
  {draft&&<button type="button" disabled={busy} onClick={()=>{setDraft(undefined);setEmail('');setLink('');setCopied(false);setError(undefined);}}>{t('invitations.new')}</button>}
  {link&&<div role="status"><p>{t('invitations.shareDescription')}</p><label htmlFor="invite-link">{t('invitations.link')}</label><input id="invite-link" readOnly value={link} onFocus={e=>e.target.select()}/>
   <button type="button" onClick={()=>{void (async()=>{try{if(!navigator.clipboard)throw Error('clipboard');await navigator.clipboard.writeText(link);setCopied(true);}catch{setError('invitations.copyManual');}})();}}>{t('invitations.copy')}</button>{copied&&<p>{t('invitations.copied')}</p>}
  </div>}
  {!!items?.length&&<ul className="card-list">{items.map(i=><li key={i.invitationId}><span className="grow"><span>{t(stateKey(i.status))}</span><span className="muted">{t('invitations.expires')} <time dateTime={i.expiresAt} title={timeZone}>{formatTime(new Date(i.expiresAt),format,timeZone)}</time></span>
   {i.delivery&&deliveryKeys[i.delivery]&&<span className="muted">{t(deliveryKeys[i.delivery]!)}</span>}</span>
   {i.status==='pending'&&<button type="button" className="secondary" disabled={busy} onClick={()=>{void revoke(i.invitationId);}}>{t('invitations.revoke')}</button>}
  </li>)}</ul>}
 </section>;
}
export function InvitationJoin({session,loading,language,format,timeZone}:{session?:Session;loading:boolean;language:string;format:string;timeZone:string}){
 const t=createTranslator(language);
 const [claim]=useState(()=>{const match=/^#([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(window.location.hash);return match?{invitationId:match[1]!,token:match[2]!}:undefined;});
 const [preview,setPreview]=useState<{name:string;role:string;termsVersion:string;expiresAt:string;accountId:string}>(),[error,setError]=useState<MessageKey>(),[busy,setBusy]=useState(false),[decision,setDecision]=useState<{action:'accept'|'decline';id:string}>(),[pending,setPending]=useState(false),[declined,setDeclined]=useState(false);
 useEffect(()=>{if(claim)window.history.replaceState(null,'','/join');},[claim]);
 useEffect(()=>{setPreview(undefined);setDecision(undefined);setPending(false);setDeclined(false);setError(undefined);},[session?.account.id]);
 async function review(){
  if(!session||!claim||busy)return;setBusy(true);setError(undefined);
  try{const r=await fetch('/api/invitations/'+claim.invitationId+'/preview',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({token:claim.token})}),body=await r.json();
   if(!r.ok){setError(errorKey(body.messageKey));return;}setPreview({...body,accountId:session.account.id});
  }catch{setError('invitations.unavailable');}finally{setBusy(false);}
 }
 async function respond(action:'accept'|'decline'){
  if(!session||!claim||!preview||preview.accountId!==session.account.id||busy)return;const op=decision??{action,id:crypto.randomUUID()};
  if(op.action!==action)return;setDecision(op);setBusy(true);setError(undefined);
  try{
   const r=await fetch('/api/invitations/'+claim.invitationId+'/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({token:claim.token,operationId:op.id,...(action==='accept'?{termsVersion:preview.termsVersion}:{})})}),body=await r.json();
   if(!r.ok){setError(errorKey(body.messageKey));setDecision(undefined);return;}
   if(body.status==='accepted'){window.location.assign('/households/'+body.householdId);return;}
   if(body.status==='declined'){setDeclined(true);setPending(false);return;}
   if(body.status==='left'){setError('invitations.left');setPending(false);return;}
   setPending(true);
  }catch{setPending(true);setError('invitations.unknownResponse');}finally{setBusy(false);}
 }
 return <main><header><span className="eyebrow">{t('app.title')}</span></header><h1>{t('invitations.joinTitle')}</h1>
  {loading?<p role="status">{t('portal.loading')}</p>:!claim?<p role="alert">{t('invitations.invalidLink')}</p>:!session?<section><p>{t('invitations.signInThenReopen')}</p><a className="button" href={signInHref()}>{t('portal.signIn')}</a></section>:<>
   {error&&<p role="alert">{t(error)}</p>}
   {(!preview||preview.accountId!==session.account.id)&&!declined&&<button type="button" disabled={busy} onClick={()=>{void review();}}>{t('invitations.review')}</button>}
   {preview&&preview.accountId===session.account.id&&!declined&&<section><h2>{preview.name}</h2><p>{t('invitations.participant')}</p><p>{t('invitations.noConsent')}</p><p>{t('invitations.expires')} <time dateTime={preview.expiresAt} title={timeZone}>{formatTime(new Date(preview.expiresAt),format,timeZone)}</time></p>
    {pending?<div role="status"><p>{t('invitations.pending')}</p><button type="button" disabled={busy} onClick={()=>{void respond(decision?.action??'accept');}}>{t('onboarding.retry')}</button></div>:<>
     <button type="button" disabled={busy} onClick={()=>{void respond('accept');}}>{t('invitations.accept')}</button><button type="button" disabled={busy} onClick={()=>{void respond('decline');}}>{t('invitations.decline')}</button>
    </>}
   </section>}
   {declined&&<p role="status">{t('invitations.declined')}</p>}
   {error==='invitations.proof'&&(session.emailVerified===false
     ?<EmailVerificationNotice language={language} emailVerified={false} body="invitations.verifyFirst"/>
     :<p>{t('invitations.signInThenReopen')} <a href={signInHref('/auth/reauth')}>{t('portal.signIn')}</a></p>)}
  </>}
  <p><a href="/">{t('portal.back')}</a></p>
 </main>;
}
