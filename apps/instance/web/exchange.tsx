import React,{useCallback,useEffect,useRef,useState} from 'react';
import {PunishmentPicker} from './shop.js';
import {PersonProgress,type Progress} from './progress.js';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {AgreementReview,ExchangeItem,ExchangeKind,ExchangePerson,ExchangeResult,TermKey,Terms} from '../../../packages/auth/exchange.js';
import type {PartnerSummary} from '../../../packages/auth/partner.js';
import {Hint,Icon,Layer} from './navigation.js';
import {Skeleton} from './today-habits.js';
import type {AuthorityResult} from '../../../packages/auth/authority.js';
import {InviteRows,OutcomeActions,authoritySend,pendingInvites,pendingTransfers} from './authority.js';
import {PersonHabits} from './assigned-habits.js';
import type {AssignedHabit} from '../../../packages/auth/authority.js';
const kindKeys:Record<ExchangeKind,MessageKey>={permission:'exchange.kind.permission',proposal:'exchange.kind.proposal',journal:'exchange.kind.journal',breach:'exchange.kind.breach'};
const stateKeys:Record<ExchangeItem['state'],MessageKey>={open:'exchange.state.open',recorded:'exchange.state.recorded',expired:'exchange.state.expired',approved:'exchange.state.approved',declined:'exchange.state.declined',acknowledged:'exchange.state.acknowledged'};
const errors:MessageKey[]=['exchange.invalid','exchange.denied','exchange.conflict','exchange.paused','exchange.capacity','exchange.horizon','exchange.unavailable','errors.rateLimited','errors.request'];
const errorKey=(value:unknown):MessageKey=>errors.includes(value as MessageKey)?value as MessageKey:'exchange.unavailable';
type Session={csrfToken:string};
type Outcome={ok:true;data:ExchangeResult}|{ok:false;key:MessageKey;unknown:boolean};
/** One exchange command; an unconfirmed outcome keeps its operation ID for an exact retry. */
async function send(householdId:string,session:Session,action:string,body:Record<string,unknown>):Promise<Outcome>{
 const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);
 try{
  const r=await fetch(`/api/households/${householdId}/exchange/${action}`,{method:'POST',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});
  const data=await r.json();
  return r.ok?{ok:true,data:data as ExchangeResult}:{ok:false,key:errorKey(data.messageKey),unknown:r.status>=500};
 }catch{return {ok:false,key:'exchange.unknown',unknown:true};}
 finally{clearTimeout(deadline);}
}
async function read(path:string,signal:AbortSignal){const r=await fetch(path,{cache:'no-store',signal}),data=await r.json();if(!r.ok)throw data;return data as ExchangeResult;}
/** Open exchanges and the people you can exchange with; loaded with the workspace and after each change. */
export function useExchange(householdId:string,reload:number){
 const [data,setData]=useState<ExchangeResult>(),[failed,setFailed]=useState(false);
 useEffect(()=>{
  let gone=false;const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  read(`/api/households/${householdId}/exchange?box=open`,controller.signal).then(r=>{if(!gone){setData(r);setFailed(false);}}).catch(()=>{if(!gone)setFailed(true);}).finally(()=>clearTimeout(deadline));
  return()=>{gone=true;controller.abort();clearTimeout(deadline);};
 },[householdId,reload]);
 return {data,failed};
}
/** Household words for navigation; empty until loaded or when none are set. */
export function useTerms(householdId:string,reload:number){
 const [terms,setTerms]=useState<ExchangeResult>();
 useEffect(()=>{
  let gone=false;const controller=new AbortController();
  read(`/api/households/${householdId}/exchange/terms`,controller.signal).then(r=>{if(!gone)setTerms(r);}).catch(()=>{});
  return()=>{gone=true;controller.abort();};
 },[householdId,reload]);
 return terms;
}
function Row({item,language,format,timeZone,onOpen}:{item:ExchangeItem;language:string;format:string;timeZone:string;onOpen:()=>void}){
 const t=createTranslator(language);
 return <li><button type="button" onClick={onOpen}><span className="grow"><span>{item.title}</span>
  <span className="muted">{[t(kindKeys[item.kind]),item.counterpartName||t('partner.unnamed'),t(stateKeys[item.state])].join(t('catalog.separator'))}{item.dueAt&&item.state==='open'&&<>{t('catalog.separator')}<time dateTime={item.dueAt}>{formatTime(new Date(item.dueAt),format,timeZone)}</time></>}</span></span>
  {!item.mine&&item.state==='open'&&<span className="dot" aria-label={t('today.attention')}/>}<Icon name="chevron"/></button></li>;
}
/** Detail page with the decision, acknowledgement or withdrawal that applies to this person. */
export function ExchangeDetail({item,householdId,session,language,format,timeZone,onClose,onChanged}:{item:ExchangeItem;householdId:string;session:Session;language:string;format:string;timeZone:string;onClose:()=>void;onChanged:(notice:MessageKey)=>void}){
 const t=createTranslator(language),[response,setResponse]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[confirmWithdraw,setConfirmWithdraw]=useState(false),operation=useRef<{key:string;id:string}|undefined>(undefined);
 const open=item.state==='open',decide=!item.mine&&open&&item.kind!=='breach',ack=item.kind==='journal'||item.kind==='breach';
 const withdrawable=item.mine&&(ack||open);
 async function run(action:'exchangeDecide'|'exchangeWithdraw',extra:Record<string,unknown>){
  if(busy)return;setBusy(true);setError(undefined);
  const key=action+JSON.stringify(extra);if(operation.current?.key!==key)operation.current={key,id:crypto.randomUUID()};
  try{
   const result=await send(householdId,session,action,{operationId:operation.current.id,exchangeId:item.id,version:item.version,...extra});
   if(result.ok){onChanged('exchange.saved');return;}
   setError(result.key);if(!result.unknown)operation.current=undefined;
  }finally{setBusy(false);}
 }
 return <Layer title={item.title} backLabel={t('nav.back')} onClose={onClose}>
  <p className="muted">{[t(kindKeys[item.kind]),t(item.mine?'exchange.sentTo':'exchange.receivedFrom'),item.counterpartName||t('partner.unnamed')].join(t('catalog.separator'))}</p>
  <p className="muted"><time dateTime={item.createdAt}>{formatTime(new Date(item.createdAt),format,timeZone)}</time></p>
  {item.body&&<p className="document-body">{item.body}</p>}
  {item.dueAt&&<p className="muted">{t('exchange.dueAt')} <time dateTime={item.dueAt}>{formatTime(new Date(item.dueAt),format,timeZone)}</time></p>}
  <p><strong>{t(stateKeys[item.state])}</strong></p>
  {item.response&&<><h3>{t('exchange.reply')}</h3><p className="document-body">{item.response}</p></>}
  {error&&<p role="alert">{t(error)}</p>}
  {decide&&<form className="quick-form" onSubmit={e=>e.preventDefault()}>
   <label>{t('exchange.replyOptional')}<textarea maxLength={500} disabled={busy} value={response} onChange={e=>{setResponse(e.target.value);operation.current=undefined;}}/></label>
   <div className="workspace-actions">{ack?<button type="button" disabled={busy} onClick={()=>{void run('exchangeDecide',{decision:'acknowledge',response:response.trim()});}}>{t('exchange.acknowledge')}</button>:<>
    <button type="button" disabled={busy} onClick={()=>{void run('exchangeDecide',{decision:'approve',response:response.trim()});}}>{t(item.kind==='proposal'?'exchange.accept':'exchange.approve')}</button>
    <button type="button" className="secondary" disabled={busy} onClick={()=>{void run('exchangeDecide',{decision:'decline',response:response.trim()});}}>{t('exchange.decline')}</button></>}</div>
  </form>}
  {withdrawable&&(confirmWithdraw?<div className="notice" role="group"><p>{t(ack?'exchange.withdrawText':'exchange.withdrawRequest')}</p>
   <button type="button" className="danger" disabled={busy} onClick={()=>{void run('exchangeWithdraw',{});}}>{t('exchange.withdraw')}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setConfirmWithdraw(false)}>{t('onboarding.cancel')}</button></div>
   :<button type="button" className="secondary" disabled={busy} onClick={()=>setConfirmWithdraw(true)}>{t('exchange.withdraw')}</button>)}
 </Layer>;
}
const directions:Record<ExchangeKind,(p:ExchangePerson)=>boolean>={permission:p=>p.holder,journal:p=>p.holder,breach:p=>p.subject,proposal:()=>true};
/** Create page; the recipient list follows who may receive this kind. */
export function ExchangeForm({people,householdId,session,language,initial,onClose,onSaved}:{people:ExchangePerson[];householdId:string;session:Session;language:string;initial?:{kind?:ExchangeKind;recipientId?:string};onClose:()=>void;onSaved:(notice:MessageKey)=>void}){
 const t=createTranslator(language);
 const kinds=(Object.keys(kindKeys) as ExchangeKind[]).filter(k=>people.some(directions[k]));
 const [kind,setKind]=useState<ExchangeKind>(initial?.kind&&kinds.includes(initial.kind)?initial.kind:kinds[0]??'proposal');
 const recipients=people.filter(directions[kind]);
 const [recipient,setRecipient]=useState(initial?.recipientId&&recipients.some(p=>p.membershipId===initial.recipientId)?initial.recipientId:recipients[0]?.membershipId??'');
 const [title,setTitle]=useState(''),[body,setBody]=useState(''),[due,setDue]=useState(''),[punishment,setPunishment]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[retry,setRetry]=useState(false),operation=useRef<string|undefined>(undefined);
 const edit=<T,>(set:(v:T)=>void)=>(v:T)=>{set(v);operation.current=undefined;setRetry(false);};
 useEffect(()=>{if(!recipients.some(p=>p.membershipId===recipient))setRecipient(recipients[0]?.membershipId??'');},[kind]);// eslint-disable-line react-hooks/exhaustive-deps
 async function submit(e:React.FormEvent){
  e.preventDefault();if(busy||!recipient)return;setBusy(true);setError(undefined);
  const operationId=operation.current??=crypto.randomUUID(),dueAt=kind==='permission'&&due?new Date(due):null;
  try{
   const result=await send(householdId,session,'exchangeCreate',{operationId,kind,recipientId:recipient,title:title.trim(),body:body.trim(),dueAt:dueAt&&Number.isFinite(dueAt.getTime())?dueAt.toISOString():null});
   if(result.ok){
    if(kind==='breach'&&punishment.trim()){
     const given=await authoritySend(householdId,session,'punishmentGive',{operationId:crypto.randomUUID(),subjectId:recipient,title:punishment.trim(),description:'',exchangeId:result.data.exchangeId??null});
     onSaved(given.ok?'authority.breachWithPunishment':'authority.punishmentFailed');return;
    }
    onSaved('exchange.saved');return;
   }
   setError(result.key);setRetry(result.unknown);if(!result.unknown)operation.current=undefined;
  }finally{setBusy(false);}
 }
 return <Layer title={t('exchange.new')} backLabel={t('nav.back')} onClose={onClose}>
  {!kinds.length?<p>{t('exchange.noPeople')}</p>:<form className="quick-form" onSubmit={e=>{void submit(e);}}>
   <fieldset className="rating" disabled={busy}><legend>{t('exchange.type')}</legend>{kinds.map(k=><label key={k}><input type="radio" name="kind" checked={kind===k} onChange={()=>edit(setKind)(k)}/>{t(kindKeys[k])}</label>)}</fieldset>
   <label>{t('exchange.to')}<select required disabled={busy} value={recipient} onChange={e=>edit(setRecipient)(e.target.value)}>{recipients.map(p=><option key={p.membershipId} value={p.membershipId}>{p.name||t('partner.unnamed')}</option>)}</select></label>
   <label>{t('library.title')}<input required maxLength={120} autoComplete="off" disabled={busy} value={title} onChange={e=>edit(setTitle)(e.target.value)}/></label>
   <label>{t('library.body')}<textarea maxLength={600} disabled={busy} value={body} onChange={e=>edit(setBody)(e.target.value)}/></label>
   {kind==='permission'&&<label>{t('exchange.dueAtOptional')}<input type="datetime-local" disabled={busy} value={due} onChange={e=>edit(setDue)(e.target.value)}/></label>}
   {kind==='breach'&&<><label>{t('authority.punishmentOptional')}<input maxLength={120} autoComplete="off" disabled={busy} value={punishment} onChange={e=>edit(setPunishment)(e.target.value)}/></label><PunishmentPicker householdId={householdId} language={language} onPick={item=>edit(setPunishment)(item.title)}/><p className="muted">{t('exchange.breachNotice')}</p></>}
   {error&&<p role="alert">{t(error)}</p>}
   <button type="submit" disabled={busy||!title.trim()||!recipient}>{t(busy?'onboarding.saving':retry?'onboarding.retry':'exchange.send')}</button>
  </form>}
 </Layer>;
}
/** Requests, proposals, journal entries and breach records you sent or received. */
export function ExchangeView({householdId,session,language,format,timeZone,people,onChanged}:{householdId:string;session:Session;language:string;format:string;timeZone:string;people:ExchangePerson[];onChanged:()=>void}){
 const t=createTranslator(language),[box,setBox]=useState<'open'|'all'>('open'),[pages,setPages]=useState<ExchangeResult[]>(),[refresh,setRefresh]=useState(0),[failed,setFailed]=useState(false),[openId,setOpenId]=useState<string>(),[creating,setCreating]=useState(false),[notice,setNotice]=useState<MessageKey>();
 useEffect(()=>{
  let gone=false;const controller=new AbortController();setPages(undefined);
  read(`/api/households/${householdId}/exchange?box=${box}`,controller.signal).then(r=>{if(!gone){setPages([r]);setFailed(false);}}).catch(()=>{if(!gone)setFailed(true);});
  return()=>{gone=true;controller.abort();};
 },[householdId,box,refresh]);
 const more=useCallback(async()=>{
  const last=pages?.[pages.length-1];if(!last?.nextCursor)return;
  try{const r=await read(`/api/households/${householdId}/exchange?box=${box}&before=${encodeURIComponent(last.nextCursor)}`,new AbortController().signal);setPages(p=>[...(p??[]),r]);}catch{setFailed(true);}
 },[pages,householdId,box]);
 const items=pages?.flatMap(p=>p.exchanges??[])??[],open=items.find(i=>i.id===openId);
 const done=(message:MessageKey)=>{setOpenId(undefined);setCreating(false);setNotice(message);setRefresh(v=>v+1);onChanged();};
 return <section className="plain">
  <Hint label={t('hint.more')}>{t('exchange.help')}</Hint>
  {notice&&<p role="status">{t(notice)}</p>}
  <div className="workspace-actions"><button type="button" onClick={()=>{setNotice(undefined);setCreating(true);}}><Icon name="plus"/>{t('exchange.new')}</button></div>
  <div className="chips">{(['open','all'] as const).map(value=><button type="button" key={value} aria-pressed={box===value} onClick={()=>setBox(value)}>{t(value==='open'?'exchange.boxOpen':'exchange.boxAll')}</button>)}</div>
  {failed?<p role="alert">{t('exchange.unavailable')}</p>:!pages?<Skeleton count={3} label={t('workspace.loading')}/>:!items.length?<p className="muted">{t('exchange.empty')}</p>:
   <ul className="menu">{items.map(item=><Row key={item.id} item={item} language={language} format={format} timeZone={timeZone} onOpen={()=>setOpenId(item.id)}/>)}</ul>}
  {pages?.[pages.length-1]?.nextCursor&&<button type="button" className="secondary" onClick={()=>{void more();}}>{t('portal.more')}</button>}
  {open&&<ExchangeDetail item={open} householdId={householdId} session={session} language={language} format={format} timeZone={timeZone} onClose={()=>setOpenId(undefined)} onChanged={done}/>}
  {creating&&<ExchangeForm people={people} householdId={householdId} session={session} language={language} onClose={()=>setCreating(false)} onSaved={done}/>}
 </section>;
}
/** Today: what others are waiting on you for, and agreement reviews that are due. */
export function Attention({householdId,session,language,format,timeZone,data,authority,reload,onChanged,onReviews}:{householdId:string;session:Session;language:string;format:string;timeZone:string;data?:ExchangeResult;authority?:AuthorityResult;reload:number;onChanged:(notice:MessageKey)=>void;onReviews:()=>void}){
 const t=createTranslator(language),[openId,setOpenId]=useState<string>(),[reviews,setReviews]=useState<AgreementReview[]>([]);
 useEffect(()=>{
  let gone=false;const controller=new AbortController();
  read(`/api/households/${householdId}/exchange/reviews`,controller.signal).then(r=>{if(!gone)setReviews((r.reviews??[]).filter(x=>x.due));}).catch(()=>{});
  return()=>{gone=true;controller.abort();};
 },[householdId,reload]);
 const waiting=(data?.exchanges??[]).filter(item=>!item.mine&&(item.state==='open'||item.state==='recorded')),open=waiting.find(i=>i.id===openId);
 if(!waiting.length&&!reviews.length&&!pendingInvites(authority).length&&!pendingTransfers(authority).length)return null;
 return <>
  <div className="section-head"><h2>{t('today.attention')}</h2></div>
  <ul className="menu">
   <InviteRows data={authority} householdId={householdId} session={session} language={language} format={format} timeZone={timeZone} onChanged={onChanged}/>
   {waiting.map(item=><Row key={item.id} item={item} language={language} format={format} timeZone={timeZone} onOpen={()=>setOpenId(item.id)}/>)}
   {reviews.map(review=><li key={review.agreementId}><button type="button" onClick={onReviews}><span className="grow"><span>{review.relationshipLabel}</span><span className="muted">{t('reviews.due')}</span></span><Icon name="chevron"/></button></li>)}
  </ul>
  {open&&<ExchangeDetail item={open} householdId={householdId} session={session} language={language} format={format} timeZone={timeZone} onClose={()=>setOpenId(undefined)} onChanged={notice=>{setOpenId(undefined);onChanged(notice);}}/>}
 </>;
}
/** For a person you hold task authority over: what is waiting, to review and overdue. Only data they already share with you. */
export function Overview({householdId,session,language,format,timeZone,data,authority,habits,progress,onAssign,onChanged}:{householdId:string;session:Session;language:string;format:string;timeZone:string;data?:ExchangeResult;authority?:AuthorityResult;habits?:AssignedHabit[];progress?:Progress;onAssign:(person?:string,task?:string)=>void;onChanged:(notice:MessageKey)=>void}){
 const t=createTranslator(language),[tasks,setTasks]=useState<PartnerSummary[]>(),[openId,setOpenId]=useState<string>(),[breachFor,setBreachFor]=useState<string>();
 useEffect(()=>{
  let gone=false;const controller=new AbortController();
  fetch(`/api/households/${householdId}/participant-tasks/partnerList`,{method:'POST',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),filter:'active'})})
   .then(async r=>{const body=await r.json();if(!r.ok)throw body;if(!gone)setTasks(body.tasks??[]);}).catch(()=>{if(!gone)setTasks([]);});
  return()=>{gone=true;controller.abort();};
 },[householdId,session.csrfToken,data]);
 const names=new Map((authority?.members??[]).map(m=>[m.membershipId,m] as const)),now=Date.now();
 const subjects=(authority?.powers??[]).map(p=>({membershipId:p.membershipId,name:names.get(p.membershipId)?.name??'',rank:names.get(p.membershipId)?.rank??null,power:p}));
 const waiting=(data?.exchanges??[]).filter(item=>!item.mine&&item.state==='open'),open=waiting.find(i=>i.id===openId);
 if(!data||!tasks||!authority)return <Skeleton count={3} label={t('workspace.loading')}/>;
 if(!subjects.length)return <p className="muted">{t('overview.empty')}</p>;
 return <section className="plain">{subjects.map(person=>{
  const theirs=tasks.filter(task=>task.role==='creator'&&task.assigneeId===person.membershipId);
  const review=theirs.filter(task=>task.state==='submitted'),overdue=theirs.filter(task=>task.dueAt&&Date.parse(task.dueAt)<now&&!['done','declined','cancelled','submitted'].includes(task.state));
  const asks=waiting.filter(item=>item.counterpartId===person.membershipId);
  return <div className="person-card" key={person.membershipId}>
   <div className="dynamic-card"><span className="badge-letter" aria-hidden="true">{(person.name||'?').slice(0,1).toUpperCase()}</span><span className="grow"><strong>{person.name||t('partner.unnamed')}</strong><span className="muted">{[person.rank!==null&&t('authority.rankNumber',{rank:String(person.rank)}),person.power.outcomes&&t('authority.pointsBalance',{points:person.power.points})].filter(Boolean).join(t('catalog.separator'))}</span></span></div>
   <div className="workspace-stats"><div><strong>{asks.length}</strong><span>{t('overview.waiting')}</span></div><div><strong>{review.length}</strong><span>{t('overview.toReview')}</span></div><div><strong>{overdue.length}</strong><span>{t('overview.overdue')}</span></div></div>
   {!!(asks.length||review.length||overdue.length)&&<ul className="menu">
    {asks.map(item=><Row key={item.id} item={item} language={language} format={format} timeZone={timeZone} onOpen={()=>setOpenId(item.id)}/>)}
    {[...review,...overdue].map(task=><li key={task.taskId}><button type="button" onClick={()=>onAssign(undefined,task.taskId)}><span className="grow"><span>{task.title}</span><span className="muted">{t(task.state==='submitted'?'overview.toReview':'overview.overdue')}</span></span><Icon name="chevron"/></button></li>)}
   </ul>}
   <div className="workspace-actions">{person.power.tasks&&<button type="button" className="secondary" onClick={()=>onAssign(person.membershipId)}>{t('overview.assign')}</button>}{(data.people??[]).some(p=>p.membershipId===person.membershipId&&p.subject)&&<button type="button" className="secondary" onClick={()=>setBreachFor(person.membershipId)}>{t('overview.recordBreach')}</button>}
    {person.power.tasks&&<PersonHabits habits={habits} subjectId={person.membershipId} name={person.name} householdId={householdId} session={session} language={language} timeZone={timeZone} canOutcomes={person.power.outcomes} onChanged={onChanged}/>}
    <OutcomeActions power={person.power} name={person.name} householdId={householdId} session={session} language={language} onChanged={onChanged}/></div>
   {(()=>{const mine=progress?.people?.find(p=>p.membershipId===person.membershipId);return mine&&progress?.today?<details className="settings-group"><summary>{t('progress.title')}</summary><PersonProgress person={mine} today={progress.today} language={language} format={format}/></details>:null;})()}
  </div>;
 })}
  {open&&<ExchangeDetail item={open} householdId={householdId} session={session} language={language} format={format} timeZone={timeZone} onClose={()=>setOpenId(undefined)} onChanged={notice=>{setOpenId(undefined);onChanged(notice);}}/>}
  {breachFor&&<ExchangeForm people={data.people??[]} householdId={householdId} session={session} language={language} initial={{kind:'breach',recipientId:breachFor}} onClose={()=>setBreachFor(undefined)} onSaved={notice=>{setBreachFor(undefined);onChanged(notice);}}/>}
 </section>;
}
const intervals=[1,3,6,12] as const;
const intervalKeys:Record<typeof intervals[number],MessageKey>={1:'reviews.month1',3:'reviews.month3',6:'reviews.month6',12:'reviews.month12'};
/** Agreed review rhythm per agreement: a shared reminder, never an expiry. */
export function ReviewsView({householdId,session,language,format}:{householdId:string;session:Session;language:string;format:string}){
 const t=createTranslator(language),[reviews,setReviews]=useState<AgreementReview[]>(),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>();
 useEffect(()=>{
  let gone=false;const controller=new AbortController();
  read(`/api/households/${householdId}/exchange/reviews`,controller.signal).then(r=>{if(!gone)setReviews(r.reviews??[]);}).catch(()=>{if(!gone)setError('exchange.unavailable');});
  return()=>{gone=true;controller.abort();};
 },[householdId,refresh]);
 const date=(value:string)=>new Intl.DateTimeFormat(format,{dateStyle:'medium',timeZone:'UTC'}).format(new Date(value+'T00:00:00Z'));
 async function run(action:'reviewSet'|'reviewDone',review:AgreementReview,extra:Record<string,unknown>={}){
  if(busy)return;setBusy(true);setError(undefined);setNotice(undefined);
  try{const result=await send(householdId,session,action,{operationId:crypto.randomUUID(),agreementId:review.agreementId,version:review.version,...extra});
   if(result.ok){setNotice('exchange.saved');setRefresh(v=>v+1);}else setError(result.key);}finally{setBusy(false);}
 }
 return <section className="plain">
  <Hint label={t('hint.more')}>{t('reviews.help')}</Hint>
  {error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}
  {!reviews?<Skeleton count={2} label={t('workspace.loading')}/>:!reviews.length?<p className="muted">{t('reviews.empty')}</p>:
   <ul className="card-list">{reviews.map(review=><li key={review.agreementId} className="review-row"><span className="grow">
    <span>{review.relationshipLabel}</span>
    <span className="muted">{review.nextReview?<>{t('reviews.next')} <time dateTime={review.nextReview}>{date(review.nextReview)}</time></>:t('reviews.none')}{review.lastReviewed&&<>{t('catalog.separator')}{t('reviews.last')} <time dateTime={review.lastReviewed}>{date(review.lastReviewed)}</time></>}</span>
    <select aria-label={t('reviews.every')} disabled={busy} value={review.intervalMonths??''} onChange={e=>{void run('reviewSet',review,{intervalMonths:e.target.value?Number(e.target.value):null});}}>
     <option value="">{t('reviews.none')}</option>{intervals.map(n=><option key={n} value={n}>{t(intervalKeys[n])}</option>)}
    </select></span>
    {review.intervalMonths&&<button type="button" className={review.due?undefined:'secondary'} disabled={busy} onClick={()=>{void run('reviewDone',review);}}>{t('reviews.markDone')}</button>}
   </li>)}</ul>}
 </section>;
}
/** Owners and admins rename navigation sections for this dynamic. */
export function TermsForm({householdId,session,language,terms,onSaved}:{householdId:string;session:Session;language:string;terms?:ExchangeResult;onSaved:()=>void}){
 const t=createTranslator(language),labels:Record<TermKey,MessageKey>={tasks:'workspace.tasks',routines:'workspace.routines',library:'workspace.library',dynamic:'workspace.dynamic'};
 const [value,setValue]=useState<Terms>(terms?.terms??{}),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>();
 useEffect(()=>{setValue(terms?.terms??{});},[terms]);
 if(!terms?.canEdit)return null;
 async function save(e:React.FormEvent){
  e.preventDefault();if(busy||!terms)return;setBusy(true);setError(undefined);setNotice(undefined);
  const clean=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,(v??'').trim()]).filter(([,v])=>v));
  try{const result=await send(householdId,session,'termsSet',{operationId:crypto.randomUUID(),terms:clean,version:terms.termsVersion});
   if(result.ok){setNotice('exchange.saved');onSaved();}else setError(result.key);}finally{setBusy(false);}
 }
 return <form onSubmit={e=>{void save(e);}}><h3>{t('terms.title')}</h3><Hint label={t('hint.more')}>{t('terms.help')}</Hint>
  {(Object.keys(labels) as TermKey[]).map(key=><label key={key}>{t(labels[key])}<input maxLength={24} autoComplete="off" disabled={busy} placeholder={t(labels[key])} value={value[key]??''} onChange={e=>setValue(v=>({...v,[key]:e.target.value}))}/></label>)}
  {error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}
  <button type="submit" disabled={busy}>{t('workspace.saveSettings')}</button>
 </form>;
}
