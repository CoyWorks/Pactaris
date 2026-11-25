import React,{useEffect,useRef,useState} from 'react';
import {Hint,Icon,Layer} from './navigation.js';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {MemberRow,OwnerOffer} from '../members.js';
import {signInHref} from './auto-sign-in.js';
type Session={account:{id:string;displayName:string};csrfToken:string};
type Action='alias'|'remove'|'offer'|'accept'|'decline'|'cancel';
type Operation={operationId:string;action:string;status:'pending'|'complete'|'rejected'};
type Listing={actorMembershipId:string;members:MemberRow[];offers:OwnerOffer[];nextCursor:string|null;operations:Operation[]};
type Draft={action:Action;payload:Record<string,string>;operationId:string};
const roles:Record<string,MessageKey>={owner:'members.role.owner',admin:'members.role.admin',participant:'members.role.participant'};
const states:Record<string,MessageKey>={pending:'members.state.pending',accepted:'members.state.accepted',declined:'members.state.declined',cancelled:'members.state.cancelled',expired:'members.state.expired',invalidated:'members.state.invalidated'};
const errorKey=(value:unknown):MessageKey=>(['members.invalid','members.denied','members.conflict','members.reauthenticate','members.unavailable','errors.rateLimited','errors.request'] as unknown[]).includes(value)?value as MessageKey:'members.unavailable';
export function MemberAdministration({householdId,session,language,format,timeZone}:{householdId:string;session:Session;language:string;format:string;timeZone:string}){
 const t=createTranslator(language),[listing,setListing]=useState<Listing>(),[name,setName]=useState(''),[error,setError]=useState<MessageKey>(),[busy,setBusy]=useState(false),[draft,setDraft]=useState<Draft>(),[confirm,setConfirm]=useState<{action:'remove'|'offer'|'accept';payload:Record<string,string>}>(),[refresh,setRefresh]=useState(0),[notice,setNotice]=useState<MessageKey>();
 const edited=useRef(false);
 const [naming,setNaming]=useState(false),[openMember,setOpenMember]=useState<string>();
 useEffect(()=>{
  let gone=false,timer:ReturnType<typeof setTimeout>|undefined,active:AbortController|undefined;
  async function load(){
   if(gone||active||document.hidden||!navigator.onLine)return;active=new AbortController();const deadline=setTimeout(()=>active?.abort(),12000);
   try{
    const r=await fetch('/api/households/'+householdId+'/members',{cache:'no-store',signal:active.signal}),data=await r.json();
    if(!r.ok){if(!gone){setListing(undefined);setError(errorKey(data.messageKey));}return;}
    if(!gone){setListing(data);const self=(data as Listing).members.find(m=>m.isSelf);if(self&&!edited.current)setName(self.displayName);}
   }catch{if(!gone){setListing(undefined);setError('members.unavailable');}}
   finally{clearTimeout(deadline);active=undefined;if(!gone)timer=setTimeout(()=>{void load();},60000);}
  }
  const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden)active?.abort();else void load();};
  document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);void load();
  return()=>{gone=true;if(timer)clearTimeout(timer);active?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
 },[householdId,session.account.id,refresh]);
 async function execute(action:Action,payload:Record<string,string>,retry?:Draft){
  if(busy||(!retry&&draft))return;const current=retry??{action,payload,operationId:crypto.randomUUID()};
  setDraft(current);setBusy(true);setError(undefined);setNotice(undefined);setConfirm(undefined);
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);
  try{
   const r=await fetch('/api/households/'+householdId+'/members/'+current.action,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({...current.payload,operationId:current.operationId})}),data=await r.json();
   if(!r.ok){setError(errorKey(data.messageKey));setDraft(undefined);setRefresh(v=>v+1);return;}
   if(data.status==='complete'){setDraft(undefined);edited.current=false;setNaming(false);setNotice(current.action==='alias'?'members.nameSaved':'members.confirmed');}
   else setNotice('members.unknown');
   setRefresh(v=>v+1);
  }catch{setNotice('members.unknown');}finally{clearTimeout(deadline);setBusy(false);}
 }
 async function more(){
  if(!listing?.nextCursor||busy)return;setBusy(true);
  try{
   const r=await fetch('/api/households/'+householdId+'/members?after='+encodeURIComponent(listing.nextCursor),{cache:'no-store'}),data=await r.json() as Listing;
   if(!r.ok)throw Error('members');
   setListing({...data,members:[...listing.members,...data.members.filter(m=>!listing.members.some(old=>old.membershipId===m.membershipId))]});
  }catch{setListing(undefined);setError('members.unavailable');}finally{setBusy(false);}
 }
 const alias=(id:string)=>listing?.members.find(m=>m.membershipId===id)?.displayName||id;
 const blocked=busy||!!draft;
 const self=listing?.members.find(m=>m.isSelf),member=listing?.members.find(m=>m.membershipId===openMember),layerOpen=naming||!!member||!!confirm;
 const status=<>{error&&<p role="alert">{t(error)}</p>}{error==='members.reauthenticate'&&<p><a href={signInHref()}>{t('portal.signIn')}</a></p>}
  {notice&&<p role="status">{t(notice)}</p>}
  {draft&&<div><p>{t('members.retryDescription')}</p><button type="button" disabled={busy} onClick={()=>{void execute(draft.action,draft.payload,draft);}}>{t('onboarding.retry')}</button></div>}</>;
 return <section><h2>{t('members.title')}</h2><Hint label={t('hint.more')}>{t('members.description')}</Hint>
  {!layerOpen&&status}
  {!listing?<button type="button" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>{t('members.refresh')}</button>:<>
   {listing.operations.some(op=>op.status==='pending'&&op.operationId!==draft?.operationId)&&<p role="status">{t('members.otherPending')}</p>}
   <ul className="menu">
    <li><button type="button" onClick={()=>setNaming(true)}><span className="grow"><span>{self?.displayName||t('members.nameNotSet')}</span><span className="muted">{[t('members.you'),self&&t(roles[self.technicalRole]??'members.role.participant')].filter(Boolean).join(t('catalog.separator'))}</span></span><Icon name="chevron"/></button></li>
    {listing.members.filter(m=>!m.isSelf).map(m=><li key={m.membershipId}><button type="button" onClick={()=>setOpenMember(m.membershipId)}><span className="grow"><span>{m.displayName||t('authority.newMember')}</span><span className="muted">{t(roles[m.technicalRole]??'members.role.participant')}</span></span><Icon name="chevron"/></button></li>)}
   </ul>
   {listing.nextCursor&&<button type="button" disabled={busy} onClick={()=>{void more();}}>{t('portal.more')}</button>}
   {!!listing.offers.length&&<><h3>{t('members.offers')}</h3><ul>{listing.offers.map(o=><li key={o.offerId}>
    <dl><dt>{t('members.from')}</dt><dd>{alias(o.fromMembershipId)}</dd><dt>{t('members.to')}</dt><dd>{alias(o.toMembershipId)}</dd>
     <dt>{t('members.offerState')}</dt><dd>{t(states[o.status]??'members.state.invalidated')}</dd><dt>{t('invitations.expires')}</dt><dd><time dateTime={o.expiresAt} title={timeZone}>{formatTime(new Date(o.expiresAt),format,timeZone)}</time></dd>
    </dl>
    {o.status==='pending'&&o.toMembershipId===listing.actorMembershipId&&<>
     <button type="button" disabled={blocked} onClick={()=>setConfirm({action:'accept',payload:{offerId:o.offerId}})}>{t('members.accept')}</button>
     <button type="button" disabled={blocked} onClick={()=>{void execute('decline',{offerId:o.offerId});}}>{t('members.decline')}</button>
    </>}
    {o.status==='pending'&&o.fromMembershipId===listing.actorMembershipId&&<button type="button" disabled={blocked} onClick={()=>{void execute('cancel',{offerId:o.offerId});}}>{t('members.cancelOffer')}</button>}
   </li>)}</ul></>}
   {naming&&<Layer title={t('members.name')} backLabel={t('nav.back')} onClose={()=>setNaming(false)} status={status}>
   <form onSubmit={e=>{e.preventDefault();void execute('alias',{name:name.trim()});}}><label htmlFor="membership-name">{t('members.name')}</label>
    <input id="membership-name" autoComplete="off" maxLength={80} value={name} disabled={blocked} onChange={e=>{edited.current=true;setName(e.target.value);}}/>
    <Hint label={t('hint.more')}>{t('members.nameDescription')}</Hint><button type="submit" disabled={blocked}>{t('members.saveName')}</button>
   </form>
   </Layer>}
   {member&&<Layer title={member.displayName||t('partner.unnamed')} backLabel={t('nav.back')} onClose={()=>setOpenMember(undefined)} status={confirm?undefined:status}>
    <dl><dt>{t('members.role')}</dt><dd>{t(roles[member.technicalRole]??'members.role.participant')}</dd></dl>
    <div className="workspace-actions">{member.canRemove&&<button type="button" className="danger" disabled={blocked} onClick={()=>setConfirm({action:'remove',payload:{targetMembershipId:member.membershipId}})}>{t('members.remove')}</button>}
    {member.canOffer&&<button type="button" disabled={blocked} onClick={()=>setConfirm({action:'offer',payload:{targetMembershipId:member.membershipId}})}>{t('members.offer')}</button>}</div>
   </Layer>}
   {confirm&&<Layer title={t(confirm.action==='remove'?'members.confirmRemove':confirm.action==='offer'?'members.confirmOffer':'members.confirmAccept')} backLabel={t('nav.back')} onClose={()=>setConfirm(undefined)} status={status}><div className="notice" role="group">
    {confirm.payload.targetMembershipId&&<p>{alias(confirm.payload.targetMembershipId)} <code>{confirm.payload.targetMembershipId}</code></p>}
    <p>{t(confirm.action==='remove'?'members.removeDescription':'members.transferDescription')}</p>
    <button type="button" disabled={blocked} onClick={()=>{void execute(confirm.action,confirm.payload);}}>{t('members.confirm')}</button><button type="button" disabled={busy} onClick={()=>setConfirm(undefined)}>{t('onboarding.cancel')}</button>
</div></Layer>}
  </>}
 </section>;
}
