import React,{useEffect,useState} from 'react';
import {WholeNumber} from './whole-number.js';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';

// Household plans (docs/HOUSEHOLD_PLANS.md). Every member sees the level, until when, its monthly price,
// how it is paid (subscription with its holder, or prepaid) and who added how many months. Only the price of
// the current level is shown; the owner sees a new level's price in a quote before changing to it.
type Tier='free'|'level1'|'level2';
type PaidTier=Exclude<Tier,'free'>;
type Price={amount:number;currency:string};
export type PlanView={tier:Tier;paidUntil:string|null;kind:'free'|'prepaid'|'subscription';
 subscription:{holderName:string|null;state:'active'|'paused';tier:PaidTier;mine:boolean}|null;
 price:Price|null;canChangeLevel:boolean;version:string;
 extraMembers:number;limits:Record<string,number>;history:{name:string|null;months:number;tier:PaidTier;source:'prepaid'|'subscription'|'operator'|'level';at:string}[];paymentsAvailable:boolean;
 subscriptionId?:string|null;provider?:string|null;providerRef?:string|null};
type Quote={tier:PaidTier;price:Price|null;paidUntil:string|null;needsPayment:boolean;version:string};
const money=(p:Price,language:string)=>new Intl.NumberFormat(language,{style:'currency',currency:p.currency}).format(p.amount/100);
const tierLabel:Record<Tier,MessageKey>={free:'plan.free',level1:'plan.level1',level2:'plan.level2'};
const limitRows:[string,MessageKey][]=[['members.active.max','plan.limitMembers'],['oneoff.open.max','plan.limitOneOff'],['series.active.max','plan.limitSeries'],
 ['habits.assigned.max','plan.limitHabits'],['plan.horizon.days','plan.limitHorizon'],['shop.items.max','plan.limitShop']];

function Summary({plan,language,format,timeZone}:{plan:PlanView;language:string;format:string;timeZone:string}){
 const t=createTranslator(language);
 return <>
  <p><strong>{t(tierLabel[plan.tier])}</strong>{plan.paidUntil&&<span className="muted"> {t('plan.until',{date:formatTime(new Date(plan.paidUntil),format,timeZone)})}</span>}</p>
  {plan.price&&<p>{t('plan.perMonth',{price:money(plan.price,language)})}</p>}
  {plan.kind==='subscription'&&plan.subscription&&<p className="muted">{t(plan.subscription.state==='paused'?'plan.subscriptionPaused':'plan.subscriptionBy',{name:plan.subscription.holderName??t('plan.formerMember')})}</p>}
  {plan.kind==='prepaid'&&<p className="muted">{t('plan.prepaid')}</p>}
  <dl className="plan-limits">{limitRows.map(([key,label])=><React.Fragment key={key}><dt>{t(label)}</dt><dd>{plan.limits[key]}</dd></React.Fragment>)}</dl>
  {plan.extraMembers>0&&<p className="muted">{t('plan.extraMembers',{count:String(plan.extraMembers)})}</p>}
 </>;
}

function History({plan,language,format,timeZone}:{plan:PlanView;language:string;format:string;timeZone:string}){
 const t=createTranslator(language);
 if(!plan.history.length)return <p className="muted">{t('plan.historyEmpty')}</p>;
 return <ul className="card-list">{plan.history.map((h,i)=><li key={i} className="row"><span className="grow">
  <span>{h.source==='level'?t('plan.historyLevel',{name:h.name??t('plan.formerMember'),tier:t(tierLabel[h.tier])})
   :h.source==='operator'?t('plan.historyOperator',{months:h.months,tier:t(tierLabel[h.tier])})
   :h.source==='subscription'?t('plan.historySubscription',{name:h.name??t('plan.formerMember'),months:h.months,tier:t(tierLabel[h.tier])})
   :t('plan.historyPrepaid',{name:h.name??t('plan.formerMember'),months:h.months,tier:t(tierLabel[h.tier])})}</span>
  <span className="muted">{formatTime(new Date(h.at),format,timeZone)}</span></span></li>)}</ul>;
}

/** Dynamic → Settings: the plan, adding months, the owner's level change and the list of who added time. */
export function PlanPanel({householdId,csrfToken,language,format,timeZone}:{householdId:string;csrfToken:string;language:string;format:string;timeZone:string}){
 const t=createTranslator(language),[plan,setPlan]=useState<PlanView>(),[months,setMonths]=useState(1),[target,setTarget]=useState<PaidTier>('level1'),[quote,setQuote]=useState<Quote>(),[busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
 function load(){return fetch('/api/households/'+householdId+'/plan',{cache:'no-store'}).then(r=>r.ok?r.json() as Promise<PlanView>:undefined);}
 function show(v:PlanView){setPlan(v);setTarget(v.tier==='level1'?'level2':'level1');}
 useEffect(()=>{let live=true;void load().then(v=>{if(live&&v)show(v);}).catch(()=>undefined);return()=>{live=false;};},[householdId]);
 async function post(action:'extend'|'cancel'|'quote'|'level',body:unknown,done?:MessageKey){
  if(busy)return;setBusy(true);setMessage(undefined);
  try{const r=await fetch('/api/households/'+householdId+'/plan/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify(body)});
   const data=await r.json() as PlanView&Quote&{messageKey?:string};
   if(r.ok){if(action==='quote')setQuote(data);else{show(data);setQuote(undefined);if(done)setMessage(done);}return;}
   const known:MessageKey[]=['plan.paymentsUnavailable','plan.notHolder','plan.levelRequired','plan.ownerOnly','plan.quoteChanged'];
   setMessage(known.includes(data.messageKey as MessageKey)?data.messageKey as MessageKey:'plan.failed');
   if(data.messageKey==='plan.quoteChanged'){setQuote(undefined);const v=await load();if(v)show(v);}}
  catch{setMessage('plan.failed');}finally{setBusy(false);}
 }
 if(!plan)return null;
 const others=(['level1','level2'] as PaidTier[]).filter(x=>x!==plan.tier);
 const alert=message==='plan.failed'||message==='plan.notHolder'||message==='plan.ownerOnly'||message==='plan.quoteChanged';
 return <section className="plan-panel">
  <h3>{t('plan.title')}</h3>
  <Summary plan={plan} language={language} format={format} timeZone={timeZone}/>
  {plan.tier!=='free'?<form className="plan-extend" onSubmit={e=>{e.preventDefault();void post('extend',{months},'plan.extended');}}>
   <h4>{t('plan.extendTitle')}</h4>
   <p className="muted">{t('plan.extendHint',{tier:t(tierLabel[plan.tier])})}</p>
   <label>{t('plan.months')}<WholeNumber min={1} max={60} disabled={busy} value={months} onChange={setMonths}/></label>
   <button type="submit" disabled={busy}>{t('plan.extend')}</button>
   {!plan.paymentsAvailable&&<p className="muted">{t('plan.paymentsSoon')}</p>}
  </form>:!plan.canChangeLevel&&<p className="muted">{t('plan.freeMember')}</p>}
  {plan.canChangeLevel&&<div className="plan-change">
   <h4>{t('plan.changeTitle')}</h4>
   {quote?<div className="notice" role="region" aria-label={t('plan.quoteTitle',{tier:t(tierLabel[quote.tier])})}>
     <p><strong>{t('plan.quoteTitle',{tier:t(tierLabel[quote.tier])})}</strong></p>
     <p>{quote.price?t('plan.quotePrice',{price:money(quote.price,language)}):t('plan.quoteNoPrice')}</p>
     {quote.paidUntil&&<p className="muted">{t('plan.quoteUntil',{date:formatTime(new Date(quote.paidUntil),format,timeZone)})}</p>}
     {quote.needsPayment&&<p className="muted">{t('plan.quotePayment')}{!plan.paymentsAvailable&&<> {t('plan.paymentsSoon')}</>}</p>}
     <div className="calendar-actions">
      <button type="button" disabled={busy||(quote.needsPayment&&!plan.paymentsAvailable)} onClick={()=>{void post('level',{tier:quote.tier,version:quote.version},'plan.changed');}}>{t('plan.confirmChange')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={()=>setQuote(undefined)}>{t('plan.keepLevel')}</button>
     </div>
    </div>
   :<form onSubmit={e=>{e.preventDefault();void post('quote',{tier:target});}}>
     <p className="muted">{t('plan.changeHint')}</p>
     {others.length>1?<label>{t('plan.level')}<select value={target} disabled={busy} onChange={e=>setTarget(e.target.value as PaidTier)}>{others.map(x=><option key={x} value={x}>{t(tierLabel[x])}</option>)}</select></label>
      :<p>{t(tierLabel[others[0]!])}</p>}
     <button type="submit" disabled={busy}>{t('plan.seePrice')}</button>
    </form>}
  </div>}
  {plan.subscription?.mine&&<button type="button" className="danger" disabled={busy} onClick={()=>{void post('cancel',{},'plan.cancelled');}}>{t('plan.cancelSubscription')}</button>}
  {message&&<p role={alert?'alert':'status'}>{t(message)}</p>}
  <h4>{t('plan.historyTitle')}</h4>
  <History plan={plan} language={language} format={format} timeZone={timeZone}/>
 </section>;
}

/** Operator console: one dynamic's plan, granting months, extra member places and subscription control. */
export function OperatorPlan({householdId,csrf,language,format,timeZone,onChanged}:{householdId:string;csrf:string;language:string;format:string;timeZone:string;onChanged?:()=>void}){
 const t=createTranslator(language),[plan,setPlan]=useState<PlanView>(),[tier,setTier]=useState<PaidTier>('level1'),[months,setMonths]=useState(1),[extra,setExtra]=useState(0),[busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
 useEffect(()=>{let live=true;void fetch('/api/operator/households/'+householdId+'/plan',{cache:'no-store'}).then(r=>r.ok?r.json() as Promise<PlanView>:undefined).then(v=>{if(live&&v){setPlan(v);setExtra(v.extraMembers);}}).catch(()=>{if(live)setMessage('plan.failed');});return()=>{live=false;};},[householdId]);
 async function change(body:Record<string,unknown>){
  if(busy)return;setBusy(true);setMessage(undefined);
  try{const r=await fetch('/api/operator/households/'+householdId+'/plan',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
   if(!r.ok){setMessage(r.status===409?'plan.conflict':'plan.failed');return;}setPlan(await r.json() as PlanView);setMessage('plan.saved');onChanged?.();}
  catch{setMessage('plan.failed');}finally{setBusy(false);}
 }
 if(!plan)return message?<p role="alert">{t(message)}</p>:null;
 return <section className="plan-panel">
  <Summary plan={plan} language={language} format={format} timeZone={timeZone}/>
  {plan.subscription&&<div className="notice"><p>{t('plan.operatorSubscription',{state:t(plan.subscription.state==='paused'?'plan.statePaused':'plan.stateActive'),provider:plan.provider??'—'})}</p>
   <div className="calendar-actions">
    {plan.subscription.state==='active'?<button type="button" disabled={busy} onClick={()=>{void change({action:'pause'});}}>{t('plan.pause')}</button>
     :<button type="button" disabled={busy} onClick={()=>{void change({action:'resume'});}}>{t('plan.resume')}</button>}
    <button type="button" className="danger" disabled={busy} onClick={()=>{void change({action:'stop'});}}>{t('plan.stop')}</button>
   </div></div>}
  <form onSubmit={e=>{e.preventDefault();void change({action:'grant',tier,months});}}>
   <h4>{t('plan.grantTitle')}</h4>
   <label>{t('plan.level')}<select value={tier} disabled={busy} onChange={e=>setTier(e.target.value as PaidTier)}><option value="level1">{t('plan.level1')}</option><option value="level2">{t('plan.level2')}</option></select></label>
   <label>{t('plan.months')}<WholeNumber min={1} max={60} disabled={busy} value={months} onChange={setMonths}/></label>
   <button type="submit" disabled={busy}>{t('plan.grant')}</button>
  </form>
  <form onSubmit={e=>{e.preventDefault();void change({action:'members',extra});}}>
   <h4>{t('plan.extraTitle')}</h4>
   <label>{t('plan.extraLabel')}<WholeNumber min={0} max={984} disabled={busy} value={extra} onChange={setExtra}/></label>
   <button type="submit" disabled={busy}>{t('plan.saveExtra')}</button>
  </form>
  {message&&<p role={message==='plan.saved'?'status':'alert'}>{t(message)}</p>}
  <h4>{t('plan.historyTitle')}</h4>
  <History plan={plan} language={language} format={format} timeZone={timeZone}/>
 </section>;
}
