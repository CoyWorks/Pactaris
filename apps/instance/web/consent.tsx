import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import {activities,type Activity,type Limits,type Terms,type SafetyState,type AgreementView,type ConsentResult} from '../../../packages/auth/consent.js';
import type {RelationshipView} from '../../../packages/auth/relationships.js';
type Draft={url:string;body:Record<string,unknown>};
type Context={state?:SafetyState;actor?:string;refresh:number;command:(action:string,input:Record<string,unknown>,restrictive?:boolean)=>Promise<ConsentResult|undefined>;read:(action:string,input:Record<string,unknown>,signal?:AbortSignal)=>Promise<ConsentResult>};
const SafetyContext=createContext<Context|null>(null);
const errorKey=(key:unknown):MessageKey=>(['consent.invalid','consent.denied','consent.conflict','consent.unavailable','errors.request','errors.rateLimited'] as unknown[]).includes(key)?key as MessageKey:'consent.unavailable';
const activityKeys:Record<Activity,MessageKey>={task:'consent.activity.task',protocol:'consent.activity.protocol',reward:'consent.activity.reward',consequence:'consent.activity.consequence',session:'consent.activity.session',reminder:'consent.activity.reminder'};
const decisionKeys:Record<string,MessageKey>={pending:'relationships.pending',accepted:'relationships.accepted',declined:'relationships.declined',withdrawn:'relationships.withdrawn'};
export function SafetyProvider({householdId,session,language,children}:{householdId:string;session:{csrfToken:string};language:string;children:React.ReactNode}){
 const t=createTranslator(language),[state,setState]=useState<SafetyState>(),[actor,setActor]=useState<string>(),[refresh,setRefresh]=useState(0),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>(),[draft,setDraft]=useState<Draft>(),[busy,setBusy]=useState(false);
 const grant=useRef<{ticketId:string;proof:string;expiresAt:string}|undefined>(undefined),active=useRef(false),base='/api/households/'+householdId;
 async function read(action:string,input:Record<string,unknown>,signal?:AbortSignal){
  const r=await fetch(base+'/consent/'+action,{method:'POST',cache:'no-store',signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),...input})}),data=await r.json();if(!r.ok)throw data;return data as ConsentResult;
 }
 useEffect(()=>{
  let gone=false,controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  async function load(){
   if(gone||controller||document.hidden||!navigator.onLine)return;controller=new AbortController();const deadline=setTimeout(()=>controller?.abort(),12000);
   try{
    const r=await fetch(base+'/safety',{cache:'no-store',signal:controller.signal}),data=await r.json();if(!r.ok)throw data;
    if(!gone){setState(data.state);setActor(data.actorMembershipId);}
    if(!grant.current||Date.parse(grant.current.expiresAt)-Date.now()<60000){
     const bytes=crypto.getRandomValues(new Uint8Array(32)),proof=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
     const proofHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(proof)))].map(b=>b.toString(16).padStart(2,'0')).join('');
     const response=await fetch(base+'/consent/safetyGrant',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),proofHash})}),ticket=await response.json();
     if(response.ok&&!gone)grant.current={...ticket,proof};
    }
   }catch(e){if(!gone){setState(undefined);setError(errorKey((e as {messageKey?:string})?.messageKey));}}
   finally{clearTimeout(deadline);controller=undefined;if(!gone)timer=setTimeout(()=>{void load();},60000);}
  }
  const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden)controller?.abort();else void load();};
  void load();document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
  return()=>{gone=true;if(timer)clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
 },[base,session.csrfToken,refresh]);
 useEffect(()=>()=>{grant.current=undefined;},[householdId]);
 async function send(request:Draft){
  // A pending normal edit must never disable a fresh restrictive safety action.
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);
  setBusy(true);setError(undefined);setNotice(undefined);
  try{
   const r=await fetch(request.url,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(request.body)}),data=await r.json();
   if(!r.ok){setError(errorKey(data.messageKey));if(r.status>=500){setDraft(request);setNotice('consent.unknown');}else setDraft(undefined);return;}
   setDraft(undefined);setNotice('consent.confirmed');setRefresh(v=>v+1);return data as ConsentResult;
  }catch{setDraft(request);setNotice('consent.unknown');return;}finally{clearTimeout(deadline);setBusy(false);}
 }
 async function command(action:string,input:Record<string,unknown>,restrictive=false){
  if(!restrictive&&(active.current||draft))return;if(!restrictive)active.current=true;
  const operationId=crypto.randomUUID(),ticket=grant.current;
  try{return await send(restrictive&&ticket&&Date.parse(ticket.expiresAt)>Date.now()?{url:'/api/local-safety/'+ticket.ticketId,body:{operationId,proof:ticket.proof,restriction:{action,...input}}}:{url:base+'/consent/'+action,body:{operationId,...input}});}finally{if(!restrictive)active.current=false;}
 }
 return <SafetyContext.Provider value={{state,actor,refresh,read,command}}><section className="notice"><h2>{t('consent.safetyTitle')}</h2><p>{t('consent.ackNotice')}</p>
  {state&&<><p>{t(state.householdStatus==='active'?'consent.householdActive':'consent.householdPaused')}</p><p>{t(state.selfPaused?'consent.selfPaused':'consent.selfActive')}</p></>}
  {error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}
  <button type="button" onClick={()=>{void command('selfPause',{},true);}}>{t('consent.pauseSelf')}</button>
  <button type="button" onClick={()=>{void command('householdStop',{},true);}}>{t('consent.stopHousehold')}</button>
  {state?.selfPaused&&<button type="button" disabled={busy||!!draft} onClick={()=>{void command('selfResume',{epoch:state.epoch,memberEpoch:state.memberEpoch});}}>{t('consent.resumeSelf')}</button>}
  {state?.householdStatus==='paused'&&<><p>{t('consent.quorum')}</p><button type="button" disabled={busy||!!draft||state.selfPaused} onClick={()=>{void command('householdResume',{epoch:state.epoch,memberEpoch:state.memberEpoch});}}>{t(state.resumeAcknowledged?'consent.reentryAcknowledged':'consent.reentry')}</button></>}
  {draft&&<div><p>{t('consent.retryNotice')}</p><button type="button" disabled={busy} onClick={()=>{void send(draft);}}>{t('onboarding.retry')}</button><button type="button" disabled={busy} onClick={()=>setDraft(undefined)}>{t('consent.discardRetry')}</button></div>}
  <button type="button" onClick={()=>setRefresh(v=>v+1)}>{t('members.refresh')}</button>
  {state&&<PersonalLimits state={state} language={language} command={command}/>}
 </section>{children}</SafetyContext.Provider>;
}
function PersonalLimits({state,language,command}:{state:SafetyState;language:string;command:Context['command']}){
 const t=createTranslator(language),[limits,setLimits]=useState<Limits>(state.limits),[version,setVersion]=useState(state.limitsVersion),edited=useRef(false);
 useEffect(()=>{if(!edited.current){setLimits(state.limits);setVersion(state.limitsVersion);}},[state]);
 const update=(patch:Partial<Limits>)=>{edited.current=true;setLimits(v=>({...v,...patch}));};
 return <form onSubmit={e=>{e.preventDefault();void command('limitsUpdate',{limits:{...limits,hard:limits.hard.trim(),soft:limits.soft.trim(),signal:limits.signal.trim(),aftercare:limits.aftercare.trim()},limitsVersion:version}).then(result=>{if(result)edited.current=false;});}}><h3>{t('consent.privateLimits')}</h3><p>{t('consent.privateNotice')}</p>
  {(['hard','soft','signal','aftercare'] as const).map(k=><label key={k}>{t(({hard:'consent.hard',soft:'consent.soft',signal:'consent.signal',aftercare:'consent.aftercare'} as const)[k])}<input value={limits[k]} maxLength={k==='signal'?80:200} onChange={e=>update({[k]:e.target.value.trimStart()})}/></label>)}
  <fieldset><legend>{t('consent.blockedActivities')}</legend>{activities.map(code=><label key={code}><input type="checkbox" checked={limits.blockedActivities.includes(code)} onChange={e=>update({blockedActivities:e.target.checked?[...limits.blockedActivities,code]:limits.blockedActivities.filter(c=>c!==code)})}/>{t(activityKeys[code])}</label>)}</fieldset>
  <button type="submit">{t('consent.saveLimits')}</button>
 </form>;
}
const emptyTerms=():Terms=>({label:'',scope:'',hard:'',soft:'',signal:'',aftercare:'',activities:['task'],validHours:24});
export function Agreements({relationship,language,format,timeZone}:{relationship:RelationshipView;language:string;format:string;timeZone:string}){
 const ctx=useContext(SafetyContext),t=createTranslator(language),[listing,setListing]=useState<ConsentResult>(),[cursor,setCursor]=useState<string>(),[refresh,setRefresh]=useState(0),[error,setError]=useState<MessageKey>(),[terms,setTerms]=useState<Terms>(emptyTerms),[revision,setRevision]=useState<{id:string;version:string}>(),[eligible,setEligible]=useState<boolean>();
 useEffect(()=>{
  if(!ctx)return;let gone=false,controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  async function load(){
   if(gone||controller||document.hidden||!navigator.onLine)return;controller=new AbortController();const deadline=setTimeout(()=>controller?.abort(),12000);
   try{const data=await ctx!.read('agreementList',{relationshipId:relationship.relationshipId,...(cursor?{after:cursor}:{})},controller.signal);if(!gone){setListing(data);setError(undefined);setEligible(undefined);}}
   catch(e){if(!gone){setListing(undefined);setError(errorKey((e as {messageKey?:string})?.messageKey));}}
   finally{clearTimeout(deadline);controller=undefined;if(!gone)timer=setTimeout(()=>{void load();},60000);}
  }
  void load();const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden)controller?.abort();else void load();};document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
  return()=>{gone=true;if(timer)clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
 },[relationship.relationshipId,cursor,ctx?.refresh,refresh]);
 if(!ctx)return null;
 const self=ctx.state,alias=(id:string)=>relationship.participants.find(p=>p.membershipId===id)?.displayName||id;
 const submit=async()=>{const cleaned={...terms,...Object.fromEntries(['label','scope','hard','soft','signal','aftercare'].map(k=>[k,terms[k as keyof Terms].toString().trim()]))};const result=await ctx.command(revision?'agreementRevise':'agreementPropose',revision?{agreementId:revision.id,version:revision.version,terms:cleaned}:{relationshipId:relationship.relationshipId,terms:cleaned});if(result){setTerms(emptyTerms());setRevision(undefined);setRefresh(v=>v+1);}};
 return <section><h4>{t('consent.agreementsTitle')}</h4><p>{t('consent.notRealWorld')}</p>{error&&<p role="alert">{t(error)}</p>}
  <button type="button" onClick={()=>{void ctx.command('relationshipPause',{relationshipId:relationship.relationshipId},true);}}>{t('consent.pauseRelationship')}</button>
  {listing?.relationshipPaused&&self&&<button type="button" onClick={()=>{void ctx.command('relationshipResume',{relationshipId:relationship.relationshipId,epoch:self.epoch,memberEpoch:self.memberEpoch,relationshipEpoch:listing.relationshipEpoch});}}>{t('consent.resumeRelationship')}</button>}
  {relationship.status==='active'&&<form onSubmit={e=>{e.preventDefault();void submit();}}><h4>{t(revision?'consent.revise':'consent.propose')}</h4><p>{t('consent.sharedNotice')}</p>
   {(['label','scope','hard','soft','signal','aftercare'] as const).map(k=><label key={k}>{t(({label:'consent.label',scope:'consent.scope',hard:'consent.hard',soft:'consent.soft',signal:'consent.signal',aftercare:'consent.aftercare'} as const)[k])}<input value={terms[k]} maxLength={k==='label'||k==='signal'?80:k==='scope'?400:200} required={k==='label'} onChange={e=>setTerms(old=>({...old,[k]:e.target.value}))}/></label>)}
   <label>{t('consent.validHours')}<input type="number" min={1} max={720} required value={terms.validHours} onChange={e=>setTerms(old=>({...old,validHours:Number(e.target.value)}))}/></label>
   <fieldset><legend>{t('consent.activities')}</legend>{activities.map(code=><label key={code}><input type="checkbox" checked={terms.activities.includes(code)} onChange={e=>setTerms(old=>({...old,activities:e.target.checked?[...old.activities,code]:old.activities.filter(c=>c!==code)}))}/>{t(activityKeys[code])}</label>)}</fieldset>
   <button type="submit">{t(revision?'consent.submitRevision':'consent.submitProposal')}</button>{revision&&<button type="button" onClick={()=>{setRevision(undefined);setTerms(emptyTerms());}}>{t('onboarding.cancel')}</button>}
  </form>}
  {listing&&!listing.agreements?.length&&<p>{t('consent.empty')}</p>}
  {listing?.agreements?.map(a=><article key={a.agreementId}><h4>{a.terms.label}</h4><p>{t('relationships.version')} <span>{a.version}</span></p>
   <dl>{(['scope','hard','soft','signal','aftercare'] as const).map(k=><React.Fragment key={k}><dt>{t(({scope:'consent.scope',hard:'consent.hard',soft:'consent.soft',signal:'consent.signal',aftercare:'consent.aftercare'} as const)[k])}</dt><dd>{a.terms[k]}</dd></React.Fragment>)}<dt>{t('invitations.expires')}</dt><dd>{formatTime(new Date(a.expiresAt),format,timeZone)}</dd></dl>
   <ul>{a.terms.activities.map(code=><li key={code}>{t(activityKeys[code])}</li>)}</ul><p>{t(a.revoked?'consent.revoked':'consent.reviewNotice')}</p>
   <ul>{a.decisions.map(d=><li key={d.membershipId}>{alias(d.membershipId)} <span>{t(decisionKeys[d.decision]??'relationships.pending')}</span>{d.decision==='accepted'&&!d.current&&<strong>{t('consent.renewRequired')}</strong>}</li>)}</ul>
   {self&&!a.revoked&&<button type="button" onClick={()=>{void ctx.command('agreementAccept',{agreementId:a.agreementId,version:a.version,epoch:self.epoch,memberEpoch:self.memberEpoch,limitsVersion:self.limitsVersion,relationshipEpoch:listing.relationshipEpoch});}}>{t('consent.accept')}</button>}
   <button type="button" onClick={()=>{void ctx.command('agreementDecline',{agreementId:a.agreementId,version:a.version});}}>{t('consent.decline')}</button>
   <button type="button" onClick={()=>{void ctx.command('agreementWithdraw',{agreementId:a.agreementId,version:a.version},true);}}>{t('consent.withdraw')}</button>
   {relationship.status==='active'&&<button type="button" onClick={()=>{setTerms(a.terms);setRevision({id:a.agreementId,version:a.version});}}>{t('consent.revise')}</button>}
   {self&&<button type="button" onClick={()=>{void ctx.read('activityCheck',{agreementId:a.agreementId,version:a.version,activity:'task',epoch:self.epoch}).then(r=>setEligible(r.eligible)).catch(()=>setError('consent.unavailable'));}}>{t('consent.checkTask')}</button>}
  </article>)}
  {eligible!==undefined&&<p role="status">{t(eligible?'consent.eligible':'consent.ineligible')}</p>}
  <button type="button" onClick={()=>setRefresh(v=>v+1)}>{t('members.refresh')}</button>{listing?.nextCursor&&<button type="button" onClick={()=>setCursor(listing.nextCursor!)}>{t('portal.more')}</button>}
 </section>;
}
