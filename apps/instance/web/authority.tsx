import React,{useEffect,useRef,useState} from 'react';
import {PunishmentPicker} from './shop.js';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {AuthorityLink,AuthorityPower,AuthorityResult,AuthorityTransfer} from '../../../packages/auth/authority.js';
import {Hint,Icon,Layer} from './navigation.js';
import {Skeleton} from './today-habits.js';
type Session={csrfToken:string};
const errors:MessageKey[]=['authority.invalid','authority.denied','authority.conflict','authority.paused','authority.capacity','authority.unavailable','errors.rateLimited','errors.request'];
const errorKey=(value:unknown):MessageKey=>errors.includes(value as MessageKey)?value as MessageKey:'authority.unavailable';
type Outcome={ok:true;data:AuthorityResult}|{ok:false;key:MessageKey;unknown:boolean};
/** One authority command; an unconfirmed outcome keeps its operation ID for an exact retry. */
export async function authoritySend(householdId:string,session:Session,action:string,body:Record<string,unknown>):Promise<Outcome>{
 const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);
 try{
  const r=await fetch(`/api/households/${householdId}/authority/${action}`,{method:'POST',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});
  const data=await r.json();
  return r.ok?{ok:true,data:data as AuthorityResult}:{ok:false,key:errorKey(data.messageKey),unknown:r.status>=500};
 }catch{return {ok:false,key:'authority.unknown',unknown:true};}
 finally{clearTimeout(deadline);}
}
/** Who holds authority over whom; loaded with the workspace and after each change. */
export function useAuthority(householdId:string,reload:number){
 const [data,setData]=useState<AuthorityResult>(),[failed,setFailed]=useState(false);
 useEffect(()=>{
  let gone=false;const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  fetch(`/api/households/${householdId}/authority`,{cache:'no-store',signal:controller.signal}).then(async r=>{const body=await r.json();if(!r.ok)throw body;if(!gone){setData(body as AuthorityResult);setFailed(false);}})
   .catch(()=>{if(!gone)setFailed(true);}).finally(()=>clearTimeout(deadline));
  return()=>{gone=true;controller.abort();clearTimeout(deadline);};
 },[householdId,reload]);
 return {data,failed};
}
/** Runs one command with retry-safe operation IDs and reports the outcome. */
function useCommand(householdId:string,session:Session,onDone:(notice:MessageKey)=>void){
 const [busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),operation=useRef<{key:string;id:string}|undefined>(undefined);
 async function run(action:string,body:Record<string,unknown>,notice:MessageKey='authority.saved'){
  if(busy)return false;setBusy(true);setError(undefined);
  const key=action+JSON.stringify(body);if(operation.current?.key!==key)operation.current={key,id:crypto.randomUUID()};
  try{const result=await authoritySend(householdId,session,action,{operationId:operation.current.id,...body});
   if(result.ok){operation.current=undefined;onDone(notice);return true;}
   setError(result.key);if(!result.unknown)operation.current=undefined;return false;
  }finally{setBusy(false);}
 }
 return {busy,error,run};
}
function LinkPage({link,data,householdId,session,language,format,timeZone,onClose,onChanged}:{link:AuthorityLink;data:AuthorityResult;householdId:string;session:Session;language:string;format:string;timeZone:string;onClose:()=>void;onChanged:(notice:MessageKey)=>void}){
 const t=createTranslator(language),{busy,error,run}=useCommand(householdId,session,onChanged),[confirmEnd,setConfirmEnd]=useState(false);
 const [delegate,setDelegate]=useState(''),[tasks,setTasks]=useState(true),[approve,setApprove]=useState(false),[outcomes,setOutcomes]=useState(false),[until,setUntil]=useState(''),[transferTo,setTransferTo]=useState('');
 const delegations=(data.delegations??[]).filter(d=>d.linkId===link.linkId),subRank=data.members?.find(m=>m.membershipId===link.subId)?.rank??null;
 // Rights only go to members ranked above the sub (the server checks this too).
 const above=(rank:number|null)=>rank===null||(subRank!==null&&rank<subRank);
 const candidates=(data.members??[]).filter(m=>m.membershipId!==link.domId&&m.membershipId!==link.subId&&above(m.rank)&&!delegations.some(d=>d.delegateId===m.membershipId));
 const manages=link.isPrimary||link.legacy,canTransfer=link.isPrimary||!link.subHasPrimary;
 const transferCandidates=(data.members??[]).filter(m=>m.membershipId!==link.subId&&(link.isPrimary?m.membershipId!==link.domId:true)&&above(m.rank));
 const openTransfer=(data.transfers??[]).find(x=>x.subId===link.subId);
 const {name:title,usedLabel}=linkName(link);
 const settings={linkId:link.linkId,version:link.version,private:link.private,canSpendPoints:link.canSpendPoints,canPropose:link.canPropose};
 return <Layer title={title||t('authority.newMember')} backLabel={t('nav.back')} onClose={onClose}>
  <p className="muted">{[usedLabel?undefined:link.label,t(link.role==='dom'?'authority.youAreDom':link.role==='sub'?'authority.youAreSub':'authority.viewOnly'),t(stateKey(link)),link.isPrimary&&t('authority.primary')].filter(Boolean).join(t('catalog.separator'))}</p>
  {link.state==='active'&&link.role==='dom'&&<p className="muted">{t(link.isPrimary?'authority.primaryHelp':link.legacy?'authority.legacyHelp':'authority.secondaryHelp')}</p>}
  {error&&<p role="alert">{t(error)}</p>}
  {link.role==='sub'&&link.state==='invited'&&<div className="notice" role="group"><p>{t('authority.acceptNotice')}</p>
   <div className="workspace-actions"><button type="button" disabled={busy} onClick={()=>{void run('linkAccept',{linkId:link.linkId,version:link.version});}}>{t('authority.accept')}</button>
   <button type="button" className="secondary" disabled={busy} onClick={()=>{void run('linkDecline',{linkId:link.linkId,version:link.version});}}>{t('exchange.decline')}</button></div></div>}
  {link.role==='dom'&&link.state==='active'&&<>
   <h3>{t('authority.settings')}</h3>
   <form className="quick-form" onSubmit={e=>e.preventDefault()}>
    <label className="check"><input type="checkbox" disabled={busy} checked={link.private} onChange={e=>{void run('linkSettings',{...settings,private:e.target.checked});}}/>{t('authority.private')}</label>
    <label className="check"><input type="checkbox" disabled={busy} checked={link.canSpendPoints} onChange={e=>{void run('linkSettings',{...settings,canSpendPoints:e.target.checked});}}/>{t('authority.canSpendPoints')}</label>
    <label className="check"><input type="checkbox" disabled={busy} checked={link.canPropose} onChange={e=>{void run('linkSettings',{...settings,canPropose:e.target.checked});}}/>{t('authority.canPropose')}</label>
    {manages&&<label>{t('authority.subRank')}<select disabled={busy} value={subRank??''} onChange={e=>{void run('rankSet',{subjectId:link.subId,rank:e.target.value?Number(e.target.value):null});}}>
     <option value="">{t('authority.noRank')}</option>{Array.from({length:10},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}</option>)}</select></label>}
   </form>
   {manages&&<><h3>{t('authority.delegations')}</h3><Hint label={t('hint.more')}>{t('authority.delegationHelp')}</Hint>
   {!!delegations.length&&<ul className="card-list">{delegations.map(d=><li key={d.delegationId}><span className="grow"><span>{d.delegateName||t('partner.unnamed')}</span>
    <span className="muted">{[d.tasks&&t('authority.area.tasks'),d.approve&&t('authority.area.approve'),d.outcomes&&t('authority.area.outcomes')].filter(Boolean).join(t('catalog.separator'))}{d.endsAt&&<>{t('catalog.separator')}{t('authority.until')} <time dateTime={d.endsAt}>{formatTime(new Date(d.endsAt),format,timeZone)}</time></>}</span></span>
    <button type="button" className="secondary" disabled={busy} onClick={()=>{void run('delegationRevoke',{delegationId:d.delegationId,version:d.version});}}>{t('authority.revoke')}</button></li>)}</ul>}
   {!!candidates.length&&<form className="quick-form" onSubmit={e=>{e.preventDefault();if(!delegate)return;const end=until?new Date(until):null;
     void run('delegationSet',{linkId:link.linkId,delegateId:delegate,version:'0',tasks,approve,outcomes,endsAt:end&&Number.isFinite(end.getTime())?end.toISOString():null}).then(ok=>{if(ok){setDelegate('');setUntil('');}});}}>
    <label>{t('authority.delegateTo')}<select required disabled={busy} value={delegate} onChange={e=>setDelegate(e.target.value)}><option value="">{t('authority.choose')}</option>{candidates.map(m=><option key={m.membershipId} value={m.membershipId}>{m.name||t('partner.unnamed')}</option>)}</select></label>
    <label className="check"><input type="checkbox" disabled={busy} checked={tasks} onChange={e=>setTasks(e.target.checked)}/>{t('authority.area.tasks')}</label>
    <label className="check"><input type="checkbox" disabled={busy} checked={approve} onChange={e=>setApprove(e.target.checked)}/>{t('authority.area.approve')}</label>
    <label className="check"><input type="checkbox" disabled={busy} checked={outcomes} onChange={e=>setOutcomes(e.target.checked)}/>{t('authority.area.outcomes')}</label>
    <label>{t('authority.untilOptional')}<input type="datetime-local" disabled={busy} value={until} onChange={e=>setUntil(e.target.value)}/></label>
    <button type="submit" disabled={busy||!delegate||(!tasks&&!approve&&!outcomes)}>{t('authority.delegate')}</button>
   </form>}
   {!candidates.length&&<p className="muted">{t('authority.noDelegates')}</p>}</>}
   {canTransfer&&!openTransfer&&<><h3>{t(link.isPrimary?'authority.transfer':'authority.choosePrimary')}</h3><Hint label={t('hint.more')}>{t('authority.transferHelp')}</Hint>
    <form className="quick-form" onSubmit={e=>{e.preventDefault();if(transferTo)void run('transferPropose',{subId:link.subId,toId:transferTo},'authority.transferProposed').then(ok=>{if(ok)setTransferTo('');});}}>
     <label>{t('authority.newPrimary')}<select required disabled={busy} value={transferTo} onChange={e=>setTransferTo(e.target.value)}><option value="">{t('authority.choose')}</option>
      {transferCandidates.map(m=><option key={m.membershipId} value={m.membershipId}>{m.membershipId===data.actorMembershipId?t('board.you'):m.name||t('partner.unnamed')}</option>)}</select></label>
     <button type="submit" disabled={busy||!transferTo}>{t('authority.propose')}</button>
    </form></>}
   {openTransfer&&<ul className="menu"><TransferRow transfer={openTransfer} householdId={householdId} session={session} language={language} onChanged={onChanged}/></ul>}
  </>}
  {link.role!=='viewer'&&link.state==='active'&&(confirmEnd?<div className="notice" role="group"><p>{t(link.role==='sub'?'authority.endNoticeSub':'authority.endNoticeDom')}</p>
   <button type="button" className="danger" disabled={busy} onClick={()=>{void run('linkEnd',{linkId:link.linkId,version:link.version});}}>{t('authority.end')}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setConfirmEnd(false)}>{t('onboarding.cancel')}</button></div>
   :<button type="button" className="secondary" disabled={busy} onClick={()=>setConfirmEnd(true)}>{t('authority.end')}</button>)}
  {link.role==='dom'&&link.state==='invited'&&<button type="button" className="secondary" disabled={busy} onClick={()=>{void run('linkEnd',{linkId:link.linkId,version:link.version});}}>{t('authority.cancelInvite')}</button>}
 </Layer>;
}
function InvitePage({data,householdId,session,language,onClose,onChanged}:{data:AuthorityResult;householdId:string;session:Session;language:string;onClose:()=>void;onChanged:(notice:MessageKey)=>void}){
 const t=createTranslator(language),{busy,error,run}=useCommand(householdId,session,onChanged),[sub,setSub]=useState(''),[label,setLabel]=useState('');
 const taken=new Set((data.links??[]).filter(l=>l.role==='dom').map(l=>l.subId));
 const candidates=(data.members??[]).filter(m=>m.membershipId!==data.actorMembershipId&&!taken.has(m.membershipId));
 return <Layer title={t('authority.invite')} backLabel={t('nav.back')} onClose={onClose}>
  <p className="muted">{t('authority.inviteHelp')}</p>
  {!candidates.length?<p>{t('authority.noCandidates')}</p>:<form className="quick-form" onSubmit={e=>{e.preventDefault();if(sub)void run('linkInvite',{subId:sub,label:label.trim()},'authority.invitedNotice');}}>
   <label>{t('authority.sub')}<select required disabled={busy} value={sub} onChange={e=>setSub(e.target.value)}><option value="">{t('authority.choose')}</option>{candidates.map(m=><option key={m.membershipId} value={m.membershipId}>{m.name||t('partner.unnamed')}</option>)}</select></label>
   <label>{t('authority.label')}<input maxLength={80} autoComplete="off" disabled={busy} value={label} onChange={e=>setLabel(e.target.value)}/></label>
   {error&&<p role="alert">{t(error)}</p>}
   <button type="submit" disabled={busy||!sub}>{t('authority.sendInvite')}</button>
  </form>}
 </Layer>;
}
/** The person on the other side of a link. A Dom sees the name they gave the sub when the sub
 *  has not chosen a name in this dynamic yet. */
function linkName(link:AuthorityLink):{name:string;usedLabel:boolean}{
 if(link.role==='sub')return {name:link.domName,usedLabel:false};
 if(link.role==='dom')return link.subName?{name:link.subName,usedLabel:false}:{name:link.label,usedLabel:!!link.label};
 return {name:link.domName&&link.subName?`${link.domName} → ${link.subName}`:'',usedLabel:false};
}
/** State from the reader's side: a sub sees an open request as "asks to be your Dom". */
function stateKey(link:AuthorityLink):MessageKey{
 if(link.state!=='invited')return 'authority.active';
 return link.role==='sub'?'authority.asksToBeYourDom':'authority.invited';
}
function LinkRow({link,language,onOpen}:{link:AuthorityLink;language:string;onOpen:()=>void}){
 const t=createTranslator(language),{name,usedLabel}=linkName(link);
 return <li><button type="button" onClick={onOpen}><span className="grow"><span>{name||t('authority.newMember')}</span><span className="muted">{[usedLabel?undefined:link.label,t(stateKey(link)),link.isPrimary&&t('authority.primary'),link.legacy&&t('authority.noPrimary')].filter(Boolean).join(t('catalog.separator'))}</span></span>
  {link.role==='sub'&&link.state==='invited'&&<span className="dot" aria-label={t('today.attention')}/>}<Icon name="chevron"/></button></li>;
}
/** Doms and subs: links, invitations, delegation, ranking and household visibility. */
export function AuthorityView({householdId,session,language,format,timeZone,data,onChanged}:{householdId:string;session:Session;language:string;format:string;timeZone:string;data?:AuthorityResult;onChanged:()=>void}){
 const t=createTranslator(language),[openId,setOpenId]=useState<string>(),[inviting,setInviting]=useState(false),[notice,setNotice]=useState<MessageKey>();
 const {busy,error,run}=useCommand(householdId,session,message=>{setNotice(message);onChanged();});
 if(!data)return <Skeleton count={3} label={t('workspace.loading')}/>;
 const links=data.links??[],mine=links.filter(l=>l.role==='dom'),doms=links.filter(l=>l.role==='sub'),others=links.filter(l=>l.role==='viewer'),open=links.find(l=>l.linkId===openId);
 const done=(message:MessageKey)=>{setOpenId(undefined);setInviting(false);setNotice(message);onChanged();};
 const ranked=(data.members??[]).filter(m=>m.rank!==null).sort((a,b)=>(a.rank??0)-(b.rank??0)||a.name.localeCompare(b.name));
 return <section className="plain">
  <Hint label={t('hint.more')}>{t('authority.help')}</Hint>
  {notice&&<p role="status">{t(notice)}</p>}{error&&<p role="alert">{t(error)}</p>}
  {!!(data.transfers??[]).length&&<><h2 className="group-title">{t('authority.transfers')}</h2><ul className="menu">{(data.transfers??[]).map(x=><TransferRow key={x.transferId} transfer={x} householdId={householdId} session={session} language={language} onChanged={done}/>)}</ul></>}
  <div className="workspace-actions"><button type="button" onClick={()=>{setNotice(undefined);setInviting(true);}}><Icon name="plus"/>{t('authority.invite')}</button></div>
  <h2 className="group-title">{t('authority.yourSubs')}</h2>
  {mine.length?<ul className="menu">{mine.map(l=><LinkRow key={l.linkId} link={l} language={language} onOpen={()=>setOpenId(l.linkId)}/>)}</ul>:<p className="muted">{t('authority.noSubs')}</p>}
  {!!doms.length&&<><h2 className="group-title">{t('authority.yourDoms')}</h2><ul className="menu">{doms.map(l=><LinkRow key={l.linkId} link={l} language={language} onOpen={()=>setOpenId(l.linkId)}/>)}</ul></>}
  {!!others.length&&<><h2 className="group-title">{t('authority.household')}</h2><ul className="menu">{others.map(l=><LinkRow key={l.linkId} link={l} language={language} onOpen={()=>setOpenId(l.linkId)}/>)}</ul></>}
  {ranked.length>0&&<><h2 className="group-title">{t('authority.ranking')}</h2><ol className="card-list ranking">{ranked.map(m=><li key={m.membershipId}><span className="badge-letter" aria-hidden="true">{m.rank}</span><span className="grow">{m.name||t('partner.unnamed')}</span></li>)}</ol></>}
  {data.canSetVisibility&&<label className="check"><input type="checkbox" disabled={busy} checked={!!data.subsVisible} onChange={e=>{void run('visibilitySet',{subsVisible:e.target.checked,version:data.settingsVersion});}}/>{t('authority.subsVisible')}</label>}
  {open&&<LinkPage link={open} data={data} householdId={householdId} session={session} language={language} format={format} timeZone={timeZone} onClose={()=>setOpenId(undefined)} onChanged={done}/>}
  {inviting&&<InvitePage data={data} householdId={householdId} session={session} language={language} onClose={()=>setInviting(false)} onChanged={done}/>}
 </section>;
}
/** Invitations waiting for your answer, for Today. */
export function pendingInvites(data?:AuthorityResult){return (data?.links??[]).filter(l=>l.role==='sub'&&l.state==='invited');}
/** Transfers waiting for your acceptance, for Today. */
export function pendingTransfers(data?:AuthorityResult){return (data?.transfers??[]).filter(x=>x.canAccept);}
/** One open primary-Dom transfer: who it moves to, who still has to accept, and your actions. */
export function TransferRow({transfer,householdId,session,language,onChanged}:{transfer:AuthorityTransfer;householdId:string;session:Session;language:string;onChanged:(notice:MessageKey)=>void}){
 const t=createTranslator(language),{busy,error,run}=useCommand(householdId,session,onChanged),body={transferId:transfer.transferId,version:transfer.version};
 const waiting=[!transfer.toAccepted&&transfer.toName,!transfer.subAccepted&&transfer.subName].filter(Boolean).join(t('catalog.separator'));
 return <li className="transfer-row"><span className="grow"><span>{t('authority.transferTitle',{sub:transfer.subName||t('partner.unnamed'),to:transfer.toName||t('partner.unnamed')})}</span>
  <span className="muted">{t('authority.transferWaiting',{names:waiting||'–'})}</span>{error&&<span role="alert">{t(error)}</span>}</span>
  <span className="row-actions">{transfer.canAccept&&<><button type="button" disabled={busy} onClick={()=>{void run('transferAccept',body,'authority.transferAccepted');}}>{t('authority.accept')}</button>
   <button type="button" className="secondary" disabled={busy} onClick={()=>{void run('transferDecline',body,'authority.saved');}}>{t('exchange.decline')}</button></>}
   {transfer.canCancel&&<button type="button" className="secondary" disabled={busy} onClick={()=>{void run('transferCancel',body,'authority.saved');}}>{t('onboarding.cancel')}</button>}</span></li>;
}
export function InviteRows({data,householdId,session,language,format,timeZone,onChanged}:{data?:AuthorityResult;householdId:string;session:Session;language:string;format:string;timeZone:string;onChanged:(notice:MessageKey)=>void}){
 const [openId,setOpenId]=useState<string>(),invites=pendingInvites(data),open=invites.find(l=>l.linkId===openId);
 return <>{invites.map(l=><LinkRow key={l.linkId} link={l} language={language} onOpen={()=>setOpenId(l.linkId)}/>)}
  {pendingTransfers(data).map(x=><TransferRow key={x.transferId} transfer={x} householdId={householdId} session={session} language={language} onChanged={onChanged}/>)}
  {open&&data&&<LinkPage link={open} data={data} householdId={householdId} session={session} language={language} format={format} timeZone={timeZone} onClose={()=>setOpenId(undefined)} onChanged={notice=>{setOpenId(undefined);onChanged(notice);}}/>}</>;
}
/** Points and punishments for someone you hold authority over. */
export function OutcomeActions({power,name,householdId,session,language,onChanged}:{power:AuthorityPower;name:string;householdId:string;session:Session;language:string;onChanged:(notice:MessageKey)=>void}){
 const t=createTranslator(language),[mode,setMode]=useState<'points'|'punishment'>(),{busy,error,run}=useCommand(householdId,session,notice=>{setMode(undefined);onChanged(notice);});
 const [amount,setAmount]=useState(5),[sign,setSign]=useState<1|-1>(1),[reason,setReason]=useState(''),[title,setTitle]=useState(''),[description,setDescription]=useState('');
 if(!power.outcomes)return null;
 return <>
  <button type="button" className="secondary" onClick={()=>setMode('points')}>{t('authority.points')}</button>
  <button type="button" className="secondary" onClick={()=>setMode('punishment')}>{t('authority.punishment')}</button>
  {mode==='points'&&<Layer title={t('authority.pointsFor',{name:name||t('partner.unnamed')})} backLabel={t('nav.back')} onClose={()=>setMode(undefined)}>
   <p className="muted">{t('authority.balance')} <strong>{power.points}</strong></p>
   <form className="quick-form" onSubmit={e=>{e.preventDefault();void run('pointsAdjust',{subjectId:power.membershipId,points:sign*amount,reason:reason.trim()});}}>
    <fieldset className="rating" disabled={busy}><legend>{t('authority.direction')}</legend>
     <label><input type="radio" name="sign" checked={sign===1} onChange={()=>setSign(1)}/>{t('authority.give')}</label>
     <label><input type="radio" name="sign" checked={sign===-1} onChange={()=>setSign(-1)}/>{t('authority.take')}</label></fieldset>
    <label>{t('authority.amount')}<input type="number" inputMode="numeric" min={1} max={10000} required disabled={busy} value={amount} onChange={e=>setAmount(Number(e.target.value))}/></label>
    <label>{t('authority.reasonOptional')}<input maxLength={200} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    {error&&<p role="alert">{t(error)}</p>}
    <button type="submit" disabled={busy||!(amount>=1)}>{t('authority.savePoints')}</button>
   </form>
  </Layer>}
  {mode==='punishment'&&<Layer title={t('authority.punishmentFor',{name:name||t('partner.unnamed')})} backLabel={t('nav.back')} onClose={()=>setMode(undefined)}>
   <form className="quick-form" onSubmit={e=>{e.preventDefault();void run('punishmentGive',{subjectId:power.membershipId,title:title.trim(),description:description.trim(),exchangeId:null},'authority.punishmentGiven');}}>
    <PunishmentPicker householdId={householdId} language={language} onPick={item=>{setTitle(item.title);setDescription(item.description);}}/>
    <label>{t('library.title')}<input required maxLength={120} disabled={busy} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>{t('library.body')}<textarea maxLength={500} disabled={busy} value={description} onChange={e=>setDescription(e.target.value)}/></label>
    <p className="muted">{t('authority.punishmentHelp')}</p>
    {error&&<p role="alert">{t(error)}</p>}
    <button type="submit" disabled={busy||!title.trim()}>{t('authority.givePunishment')}</button>
   </form>
  </Layer>}
 </>;
}
