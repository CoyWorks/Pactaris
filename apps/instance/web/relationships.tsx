import {Agreements} from './consent.js';
import {Hint} from './navigation.js';
import React,{useEffect,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import type {RelationshipView,RelationshipRole,Proposal} from '../../../packages/auth/relationships.js';
import type {MemberRow} from '../members.js';
type Listing={actorMembershipId:string;relationships:RelationshipView[];nextCursor:string|null};
type Draft={action:string;input:Record<string,unknown>};
const decisions:Record<string,MessageKey>={pending:'relationships.pending',accepted:'relationships.accepted',declined:'relationships.declined',withdrawn:'relationships.withdrawn'};
const states:Record<string,MessageKey>={proposed:'relationships.proposed',active:'relationships.active',ended:'relationships.ended'};
const reasons:Record<string,MessageKey>={declined:'relationships.declined',withdrawn:'relationships.withdrawn',membershipEnded:'relationships.membershipEnded'};
const errorKey=(value:unknown):MessageKey=>(['relationships.invalid','relationships.denied','relationships.conflict','relationships.unavailable','errors.rateLimited','errors.request'] as unknown[]).includes(value)?value as MessageKey:'relationships.unavailable';
export function Relationships({householdId,session,language,format,timeZone}:{householdId:string;session:{csrfToken:string;account:{id:string}};language:string;format:string;timeZone:string}){
 const t=createTranslator(language),[listing,setListing]=useState<Listing>(),[members,setMembers]=useState<MemberRow[]>([]),[cursor,setCursor]=useState<string>(),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[draft,setDraft]=useState<Draft>(),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>();
 const [label,setLabel]=useState(''),[scope,setScope]=useState(''),[participants,setParticipants]=useState<string[]>([]),[roles,setRoles]=useState<RelationshipRole[]>([]),[confirm,setConfirm]=useState<{action:string;relationship:RelationshipView}>();
 useEffect(()=>{
  let gone=false,active:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  async function load(){
   if(gone||active||document.hidden||!navigator.onLine)return;active=new AbortController();const deadline=setTimeout(()=>active?.abort(),12000);
   try{
    const base='/api/households/'+householdId;
    const [r,m]=await Promise.all([fetch(base+'/relationships'+(cursor?'?after='+encodeURIComponent(cursor):''),{cache:'no-store',signal:active.signal}),fetch(base+'/members',{cache:'no-store',signal:active.signal})]);
    const data=await r.json();if(!r.ok)throw {messageKey:data.messageKey};
    const membership=await m.json();if(!m.ok)throw {messageKey:'relationships.unavailable'};
    if(!gone){setListing(data);setMembers(membership.members);setError(undefined);}
   }catch(e){if(!gone){setListing(undefined);setMembers([]);setError(errorKey((e as {messageKey?:string})?.messageKey));}}
   finally{clearTimeout(deadline);active=undefined;if(!gone)timer=setTimeout(()=>{void load();},60000);}
  }
  const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden)active?.abort();else void load();};
  void load();document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
  return()=>{gone=true;if(timer)clearTimeout(timer);active?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
 },[householdId,session.account.id,cursor,refresh]);
 async function execute(action:string,input:Record<string,unknown>,retry?:Draft){
  if(busy||(!retry&&draft))return;const request=retry??{action,input:{...input,operationId:crypto.randomUUID()}};
  setDraft(request);setBusy(true);setConfirm(undefined);setError(undefined);setNotice(undefined);
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);
  try{
   const r=await fetch('/api/households/'+householdId+'/relationships/'+request.action,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(request.input)}),data=await r.json();
   if(!r.ok){setError(errorKey(data.messageKey));if(r.status<500)setDraft(undefined);else setNotice('relationships.unknown');return;}
   setDraft(undefined);setNotice('relationships.confirmed');if(request.action==='propose'){setLabel('');setScope('');setParticipants([]);setRoles([]);}
   setRefresh(v=>v+1);
  }catch{setNotice('relationships.unknown');}finally{clearTimeout(deadline);setBusy(false);}
 }
 const blocked=busy||!!draft,alias=(id:string)=>members.find(m=>m.membershipId===id)?.displayName||id;
 const selected=[...new Set([...(listing?[listing.actorMembershipId]:[]),...participants])];
 const updateRole=(index:number,patch:Partial<RelationshipRole>)=>setRoles(old=>old.map((r,i)=>i===index?{...r,...patch}:r));
 return <section><h2>{t('relationships.title')}</h2><Hint label={t('hint.more')}>{t('relationships.description')}</Hint><p>{t('relationships.safetyNotice')}</p>
  {error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}
  {draft&&<div><p>{t('relationships.retryDescription')}</p><button type="button" disabled={busy} onClick={()=>{void execute(draft.action,draft.input,draft);}}>{t('onboarding.retry')}</button></div>}
  <button type="button" disabled={busy} onClick={()=>{setCursor(undefined);setRefresh(v=>v+1);}}>{t('relationships.refresh')}</button>
  {listing&&<>
   <form onSubmit={e=>{e.preventDefault();const proposal:Proposal={label:label.trim(),scope:scope.trim(),participants:selected,roles:roles.map(r=>({...r,label:r.label.trim(),context:r.context.trim()}))};void execute('propose',{proposal});}}>
    <h3>{t('relationships.new')}</h3><label htmlFor="relationship-label">{t('relationships.label')}</label><input id="relationship-label" maxLength={80} required disabled={blocked} value={label} onChange={e=>setLabel(e.target.value)}/>
    <label htmlFor="relationship-scope">{t('relationships.scope')}</label><textarea id="relationship-scope" maxLength={500} disabled={blocked} value={scope} onChange={e=>setScope(e.target.value)}/>
    <fieldset disabled={blocked}><legend>{t('relationships.participants')}</legend><p>{t('relationships.selfIncluded')}</p>
     {members.filter(m=>!m.isSelf).map(m=><label key={m.membershipId}><input type="checkbox" checked={participants.includes(m.membershipId)} disabled={!participants.includes(m.membershipId)&&selected.length>=8} onChange={e=>{setParticipants(old=>e.target.checked?[...old,m.membershipId]:old.filter(id=>id!==m.membershipId));setRoles([]);}}/>{alias(m.membershipId)}</label>)}
    </fieldset>
    <fieldset disabled={blocked}><legend>{t('relationships.roles')}</legend><Hint label={t('hint.more')}>{t('relationships.rolesDescription')}</Hint>
     {roles.map((role,i)=><div key={i}>
      <label>{t('relationships.person')}<select value={role.membershipId} onChange={e=>updateRole(i,{membershipId:e.target.value,counterpartMembershipId:null})}>{selected.map(id=><option key={id} value={id}>{alias(id)}</option>)}</select></label>
      <label>{t('relationships.roleLabel')}<input value={role.label} maxLength={80} required onChange={e=>updateRole(i,{label:e.target.value})}/></label>
      <label>{t('relationships.counterpart')}<select value={role.counterpartMembershipId??''} onChange={e=>updateRole(i,{counterpartMembershipId:e.target.value||null})}><option value="">{t('relationships.noCounterpart')}</option>{selected.filter(id=>id!==role.membershipId).map(id=><option key={id} value={id}>{alias(id)}</option>)}</select></label>
      <label>{t('relationships.context')}<input value={role.context} maxLength={160} onChange={e=>updateRole(i,{context:e.target.value})}/></label>
      <button type="button" onClick={()=>setRoles(old=>old.filter((_,j)=>j!==i))}>{t('relationships.removeRole')}</button>
     </div>)}
     <button type="button" disabled={roles.length>=8} onClick={()=>setRoles(old=>[...old,{membershipId:listing.actorMembershipId,label:'',counterpartMembershipId:null,context:''}])}>{t('relationships.addRole')}</button>
    </fieldset>
    <p>{t('relationships.proposalNotice')}</p><button type="submit" disabled={blocked||selected.length<2}>{t('relationships.propose')}</button>
   </form>
   {!listing.relationships.length&&<p>{t('relationships.empty')}</p>}
   {listing.relationships.map(r=><article key={r.relationshipId}><h3>{r.label}</h3><p>{r.scope}</p><p>{t(states[r.status]??'relationships.ended')}</p>{r.endReason&&<p>{t(reasons[r.endReason]??'relationships.membershipEnded')}</p>}
    <dl><dt>{t('relationships.version')}</dt><dd>{r.version}</dd></dl>
    <ul>{r.participants.map(p=><li key={p.membershipId}>{p.displayName||p.membershipId} <span>{t(decisions[p.decision]??'relationships.withdrawn')}</span></li>)}</ul>
    <ul>{r.roles.map((role,i)=><li key={i}><dl><dt>{t('relationships.person')}</dt><dd>{r.participants.find(p=>p.membershipId===role.membershipId)?.displayName||role.membershipId}</dd><dt>{t('relationships.roleLabel')}</dt><dd>{role.label}</dd><dt>{t('relationships.counterpart')}</dt><dd>{role.counterpartMembershipId?(r.participants.find(p=>p.membershipId===role.counterpartMembershipId)?.displayName||role.counterpartMembershipId):t('relationships.noCounterpart')}</dd><dt>{t('relationships.context')}</dt><dd>{role.context}</dd></dl></li>)}</ul>
    {r.status==='proposed'&&r.participants.some(p=>p.membershipId===listing.actorMembershipId&&p.decision==='pending')&&<>
     <button type="button" disabled={blocked} onClick={()=>setConfirm({action:'accept',relationship:r})}>{t('relationships.accept')}</button>
     <button type="button" disabled={blocked} onClick={()=>setConfirm({action:'decline',relationship:r})}>{t('relationships.decline')}</button>
    </>}
    {r.status!=='ended'&&<button type="button" disabled={blocked} onClick={()=>setConfirm({action:'withdraw',relationship:r})}>{t('relationships.withdraw')}</button>}
    <Agreements relationship={r} language={language} format={format} timeZone={timeZone}/>
   </article>)}
   {listing.nextCursor&&<button type="button" disabled={busy} onClick={()=>setCursor(listing.nextCursor!)}>{t('portal.more')}</button>}
   {confirm&&<div className="notice" role="group"><h3>{t('relationships.confirmTitle')}</h3><p>{confirm.relationship.label}</p><p>{confirm.relationship.scope}</p><p>{t(confirm.action==='accept'?'relationships.acceptNotice':'relationships.endNotice')}</p>
    <button type="button" disabled={blocked} onClick={()=>{void execute(confirm.action,{relationshipId:confirm.relationship.relationshipId,version:confirm.relationship.version});}}>{t(confirm.action==='accept'?'relationships.accept':confirm.action==='decline'?'relationships.decline':'relationships.withdraw')}</button>
    <button type="button" disabled={busy} onClick={()=>setConfirm(undefined)}>{t('onboarding.cancel')}</button>
   </div>}
  </>}
 </section>;
}
