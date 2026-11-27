import {CalendarPrivacyField,markCalendar} from './planner.js';
import {WholeNumber} from './whole-number.js';
import React,{useEffect,useRef,useState} from 'react';
import {PunishmentPicker} from './shop.js';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import type {AssignedHabit,AuthorityResult,HabitFields} from '../../../packages/auth/authority.js';
import {Hint,Icon,Layer} from './navigation.js';
import {authoritySend} from './authority.js';
type Session={csrfToken:string};
const resultKeys:Record<AssignedHabit['results'][number]['result'],MessageKey>={reached:'habits.reached',missed:'habits.missed',skipped:'habits.skipped'};
/** Habits set by a Dom, for the people you hold authority over and for yourself. */
export function useAssignedHabits(householdId:string,reload:number){
 const [habits,setHabits]=useState<AssignedHabit[]>();
 useEffect(()=>{
  let gone=false;const controller=new AbortController();
  fetch(`/api/households/${householdId}/authority/habits`,{cache:'no-store',signal:controller.signal}).then(async r=>{const body=await r.json() as AuthorityResult;if(!r.ok)throw body;if(!gone)setHabits(body.habits??[]);})
   .catch(()=>{if(!gone)setHabits([]);});
  return()=>{gone=true;controller.abort();};
 },[householdId,reload]);
 return habits;
}
function Progress({habit,language}:{habit:AssignedHabit;language:string}){
 const t=createTranslator(language),percent=habit.mode==='minimum'?Math.min(100,Math.round(habit.currentTotal/Math.max(1,habit.target)*100)):Math.min(100,Math.round(habit.currentTotal/Math.max(1,habit.target||1)*100));
 return <><span className="habit-count">{t(habit.mode==='minimum'?'habits.progressMin':'habits.progressMax',{count:String(habit.currentTotal),target:String(habit.target)})}</span>
  <span className={'bar'+(habit.mode==='maximum'&&habit.currentTotal>habit.target?' over':'')} aria-hidden="true"><span style={{width:percent+'%'}}/></span></>;
}
function HabitBreaks({habit,householdId,session,language,onChanged}:{habit:AssignedHabit;householdId:string;session:Session;language:string;onChanged:()=>void}){
 const t=createTranslator(language),[open,setOpen]=useState(false),[start,setStart]=useState(''),[end,setEnd]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>();
 const operation=useRef<{key:string;id:string}|undefined>(undefined);
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:habit.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
 const part=(type:string)=>parts.find(p=>p.type===type)?.value??'';const today=[part('year'),part('month'),part('day')].join('-');
 async function send(action:'habitBreakAdd'|'habitBreakCancel',body:Record<string,string>){
  if(busy)return;setBusy(true);setError(undefined);const key=JSON.stringify([action,body]);
  if(operation.current?.key!==key)operation.current={key,id:crypto.randomUUID()};
  try{const result=await authoritySend(householdId,session,action,{operationId:operation.current.id,habitId:habit.habitId,...body});
   if(result.ok){operation.current=undefined;setStart('');setEnd('');onChanged();}else{setError(result.key);if(!result.unknown)operation.current=undefined;}}
  finally{setBusy(false);}
 }
 if(!habit.canPlanBreak)return null;
 return <div className="habit-breaks"><button type="button" className="secondary" onClick={()=>setOpen(!open)}>{t('habits.breaks')}</button>{open&&<div>
  <p className="muted">{t('habits.breakHelp')}</p>
  {habit.breaks.filter(b=>b.end>=today).map(b=><p key={b.id}>{b.start}{t('catalog.separator')}{b.end} {b.canCancel&&<button type="button" className="secondary" disabled={busy} onClick={()=>{void send('habitBreakCancel',{breakId:b.id});}}>{t('habits.cancelBreak')}</button>}</p>)}
  <label>{t('habits.breakStart')}<input type="date" min={today} value={start} disabled={busy} onChange={e=>setStart(e.target.value)}/></label>
  <label>{t('habits.breakEnd')}<input type="date" min={start||today} value={end} disabled={busy} onChange={e=>setEnd(e.target.value)}/></label>
  <button type="button" disabled={busy||!start||!end||end<start} onClick={()=>{void send('habitBreakAdd',{start,end});}}>{t('habits.planBreak')}</button>
  {error&&<p role="alert">{t(error)}</p>}
 </div>}</div>;
}
function HabitHistory({habit,householdId,session,language,onChanged}:{habit:AssignedHabit;householdId:string;session:Session;language:string;onChanged:()=>void}){
 const t=createTranslator(language),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>();
 const operation=useRef<{entryId:string;id:string}|undefined>(undefined);
 async function reverse(entryId:string){
  if(busy)return;setBusy(true);setError(undefined);if(operation.current?.entryId!==entryId)operation.current={entryId,id:crypto.randomUUID()};
  try{const r=await authoritySend(householdId,session,'habitReverse',{operationId:operation.current.id,entryId});if(r.ok){operation.current=undefined;onChanged();}else{setError(r.key);if(!r.unknown)operation.current=undefined;}}
  finally{setBusy(false);}
 }
 const fmt=new Intl.DateTimeFormat(language,{dateStyle:'medium',timeStyle:'short',timeZone:habit.timeZone});
 return <div><button type="button" className="secondary" aria-expanded={open} onClick={()=>setOpen(!open)}>{t('habits.history')}</button>{open&&<div>
  <h4>{t('habits.recentPeriods')}</h4><ul>{habit.results.map(r=><li key={r.periodStart}>{r.periodStart}{t('catalog.separator')}{t(resultKeys[r.result])}{t('catalog.separator')}{r.total}</li>)}</ul>
  <h4>{t('habits.recentEntries')}</h4><ul>{habit.entries.map(e=><li key={e.id}><time dateTime={e.occurredAt}>{fmt.format(new Date(e.occurredAt))}</time>{t('catalog.separator')}{e.count}{e.reversed&&<span>{t('routines.reversed')}</span>}{e.canReverse&&<button type="button" disabled={busy} onClick={()=>{void reverse(e.id);}}>{t('routines.reverse')}</button>}</li>)}</ul>
  {error&&<p role="alert">{t(error)}</p>}
 </div>}</div>;
}
/** Today, for the sub: habits a Dom set for you, with +1. */
export function TodayAssignedHabits({habits,me,householdId,session,language,onChanged}:{habits?:AssignedHabit[];me:string;householdId:string;session:Session;language:string;onChanged:()=>void}){
 const t=createTranslator(language),[busy,setBusy]=useState<string>(),[error,setError]=useState<MessageKey>();
 const mine=(habits??[]).filter(h=>h.subjectId===me&&h.state==='active');
 if(!mine.length)return null;
 async function add(habit:AssignedHabit){
  if(busy)return;setBusy(habit.habitId);setError(undefined);
  try{const result=await authoritySend(householdId,session,'habitRecord',{operationId:crypto.randomUUID(),habitId:habit.habitId,count:1});if(result.ok)onChanged();else setError(result.key);}
  finally{setBusy(undefined);}
 }
 return <>
  <div className="section-head"><h2>{t('habits.fromDom')}</h2></div>
  <div className="habit-tiles">{mine.map(habit=><div className="habit-tile" key={habit.habitId}>
   <span className="habit-name">{habit.title}</span><Progress habit={habit} language={language}/>
   <span className="muted">{[habit.holderName,habit.streaks.current>0&&t('habits.streak',{count:String(habit.streaks.current)})].filter(Boolean).join(t('catalog.separator'))}</span>
   <HabitBreaks habit={habit} householdId={householdId} session={session} language={language} onChanged={onChanged}/>
   <HabitHistory habit={habit} householdId={householdId} session={session} language={language} onChanged={onChanged}/>
   <button type="button" className="icon-button add-one" disabled={!!busy||!habit.canRecord} aria-label={t('today.addOne',{title:habit.title})} onClick={()=>{void add(habit);}}><Icon name="plus"/></button>
  </div>)}</div>
  {error&&<p role="alert">{t(error)}</p>}
 </>;
}
const empty=(timeZone:string):HabitFields=>({category:'',weekdays:[1,2,3,4,5,6,7],title:'',description:'',period:'daily',mode:'minimum',target:1,timeZone,rewardPoints:null,penaltyPoints:null,punishment:null,milestoneEvery:null,milestonePoints:null,extraPoints:null,extraLimit:null});
function HabitForm({habit,subjectId,householdId,session,language,timeZone,canOutcomes,onClose,onSaved}:{habit?:AssignedHabit;subjectId:string;householdId:string;session:Session;language:string;timeZone:string;canOutcomes:boolean;onClose:()=>void;onSaved:(notice:MessageKey)=>void}){
 const t=createTranslator(language),[fields,setFields]=useState<HabitFields>(habit?{category:habit.category??'',weekdays:habit.weekdays,title:habit.title,description:habit.description,period:habit.period,mode:habit.mode,target:habit.target,timeZone:habit.timeZone,rewardPoints:habit.rewardPoints,penaltyPoints:habit.penaltyPoints,punishment:habit.punishment,milestoneEvery:habit.milestoneEvery,milestonePoints:habit.milestonePoints,extraPoints:habit.extraPoints??null,extraLimit:habit.extraLimit??null}:empty(timeZone));
 const [busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[hide,setHide]=useState(false),operation=useRef<string|undefined>(undefined);
 const set=<K extends keyof HabitFields,>(key:K,value:HabitFields[K])=>{setFields(f=>({...f,[key]:value}));operation.current=undefined;};
 const number=(value:string)=>value===''?null:Math.max(1,Math.min(10000,Math.round(Number(value))));
 async function save(e:React.FormEvent){
  e.preventDefault();if(busy)return;setBusy(true);setError(undefined);
  const operationId=operation.current??=crypto.randomUUID();
  const clean={...fields,title:fields.title.trim(),description:fields.description.trim(),punishment:fields.punishment?.trim()||null};
  try{const result=await authoritySend(householdId,session,'habitSave',{operationId,habitId:habit?.habitId??null,subjectId:habit?null:subjectId,version:habit?.version??null,fields:clean});
   if(result.ok){
    if(!habit&&hide&&!await markCalendar(householdId,session.csrfToken,'habit',String(result.data.resourceId),true)){onSaved('calendar.markFailed');return;}
    onSaved('habits.saved');return;}setError(result.key);if(!result.unknown)operation.current=undefined;}
  finally{setBusy(false);}
 }
 return <Layer title={t(habit?'habits.edit':'habits.new')} backLabel={t('nav.back')} onClose={onClose}>
  <form className="quick-form" onSubmit={e=>{void save(e);}}>
   <label>{t('quick.habitTitle')}<input required maxLength={120} autoComplete="off" disabled={busy} value={fields.title} onChange={e=>set('title',e.target.value)}/></label>
   <label>{t('library.body')}<textarea maxLength={500} disabled={busy} value={fields.description} onChange={e=>set('description',e.target.value)}/></label>
   <label>{t('library.category')}<input maxLength={60} disabled={busy} value={fields.category??''} onChange={e=>set('category',e.target.value)}/></label>
   {!habit&&<label>{t('workspace.timeZone')}<input required maxLength={100} disabled={busy} value={fields.timeZone} onChange={e=>set('timeZone',e.target.value)}/></label>}
   {!habit&&<label>{t('routines.period')}<select disabled={busy} value={fields.period} onChange={e=>set('period',e.target.value as HabitFields['period'])}><option value="daily">{t('routines.daily')}</option><option value="weekly">{t('routines.weekly')}</option></select></label>}
   {fields.period==='daily'&&<fieldset disabled={busy||!!habit}><legend>{t('partner.weekdays')}</legend>
    {(['partner.monday','partner.tuesday','partner.wednesday','partner.thursday','partner.friday','partner.saturday','partner.sunday'] as const).map((key,index)=><label className="check" key={key}><input type="checkbox" checked={(fields.weekdays??[]).includes(index+1)} onChange={e=>set('weekdays',e.target.checked?[...(fields.weekdays??[]),index+1].sort((a,b)=>a-b):(fields.weekdays??[]).filter(d=>d!==index+1))}/>{t(key)}</label>)}
   </fieldset>}
   <fieldset className="rating" disabled={busy}><legend>{t('routines.goalMode')}</legend>
    <label><input type="radio" name="mode" checked={fields.mode==='minimum'} onChange={()=>set('mode','minimum')}/>{t('routines.minimum')}</label>
    <label><input type="radio" name="mode" checked={fields.mode==='maximum'} onChange={()=>{set('mode','maximum');set('extraPoints',null);set('extraLimit',null);}}/>{t('routines.maximum')}</label></fieldset>
   <label>{t('routines.target')}<input type="number" inputMode="numeric" min={fields.mode==='minimum'?1:0} max={1000} required disabled={busy} value={fields.target} onChange={e=>set('target',Number(e.target.value))}/></label>
   {canOutcomes&&<><h3>{t('habits.outcomes')}</h3><Hint label={t('hint.more')}>{t('habits.outcomesHelp')}</Hint>
    <label>{t('habits.rewardPoints')}<input type="number" inputMode="numeric" min={1} max={10000} disabled={busy} value={fields.rewardPoints??''} onChange={e=>set('rewardPoints',number(e.target.value))}/></label>
    <label>{t('habits.penaltyPoints')}<input type="number" inputMode="numeric" min={1} max={10000} disabled={busy} value={fields.penaltyPoints??''} onChange={e=>set('penaltyPoints',number(e.target.value))}/></label>
    <label>{t('habits.punishment')}<input maxLength={120} autoComplete="off" disabled={busy} value={fields.punishment??''} onChange={e=>set('punishment',e.target.value||null)}/></label>
    <PunishmentPicker householdId={householdId} language={language} onPick={item=>set('punishment',item.title)}/>
    <label className="check"><input type="checkbox" disabled={busy} checked={fields.milestoneEvery!==null} onChange={e=>{if(e.target.checked){set('milestoneEvery',7);set('milestonePoints',10);}else{set('milestoneEvery',null);set('milestonePoints',null);}}}/>{t('habits.milestoneEnable')}</label>
    {fields.milestoneEvery!==null&&<><Hint label={t('hint.more')}>{t('habits.milestoneHelp')}</Hint>
     <label>{t('habits.milestoneEvery')}<WholeNumber min={2} max={365} disabled={busy} value={fields.milestoneEvery} onChange={n=>set('milestoneEvery',n)}/></label>
     <label>{t('habits.milestonePoints')}<input type="number" inputMode="numeric" min={1} max={10000} required disabled={busy} value={fields.milestonePoints??''} onChange={e=>set('milestonePoints',number(e.target.value))}/></label></>}
    {fields.mode==='minimum'&&<><label className="check"><input type="checkbox" disabled={busy} checked={fields.extraPoints!=null} onChange={e=>{if(e.target.checked){set('extraPoints',1);set('extraLimit',5);}else{set('extraPoints',null);set('extraLimit',null);}}}/>{t('habits.extraEnable')}</label>
    {fields.extraPoints!=null&&<><Hint label={t('hint.more')}>{t('habits.extraHelp')}</Hint>
     <label>{t('habits.extraPoints')}<WholeNumber min={1} max={10000} disabled={busy} value={fields.extraPoints} onChange={n=>set('extraPoints',n)}/></label>
     <label>{t('habits.extraLimit')}<WholeNumber min={1} max={1000} disabled={busy} value={fields.extraLimit??5} onChange={n=>set('extraLimit',n)}/></label></>}</>}</>}
   {!habit&&<CalendarPrivacyField language={language} checked={hide} disabled={busy} onChange={setHide}/>}
   {error&&<p role="alert">{t(error)}</p>}
   <button type="submit" disabled={busy||!fields.title.trim()||(fields.period==='daily'&&!(fields.weekdays?.length))}>{t(busy?'onboarding.saving':'habits.save')}</button>
  </form>
 </Layer>;
}
/** People → Habits for one person: what the Dom set, the current period and recent results. */
export function PersonHabits({habits,subjectId,name,householdId,session,language,timeZone,canOutcomes,onChanged}:{habits?:AssignedHabit[];subjectId:string;name:string;householdId:string;session:Session;language:string;timeZone:string;canOutcomes:boolean;onChanged:(notice:MessageKey)=>void}){
 const t=createTranslator(language),[open,setOpen]=useState(false),[editing,setEditing]=useState<AssignedHabit|'new'>(),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>();
 const theirs=(habits??[]).filter(h=>h.subjectId===subjectId);
 async function state(habit:AssignedHabit,next:'active'|'paused'|'archived'){
  if(busy)return;setBusy(true);setError(undefined);
  try{const result=await authoritySend(householdId,session,'habitState',{operationId:crypto.randomUUID(),habitId:habit.habitId,version:habit.version,state:next});if(result.ok)onChanged('habits.saved');else setError(result.key);}
  finally{setBusy(false);}
 }
 return <>
  <button type="button" className="secondary" onClick={()=>setOpen(true)}>{t('habits.title')}{theirs.length?` (${theirs.length})`:''}</button>
  {open&&<Layer title={t('habits.for',{name:name||t('partner.unnamed')})} backLabel={t('nav.back')} onClose={()=>setOpen(false)}>
   {error&&<p role="alert">{t(error)}</p>}
   <div className="workspace-actions"><button type="button" onClick={()=>setEditing('new')}><Icon name="plus"/>{t('habits.new')}</button></div>
   {!theirs.length?<p className="muted">{t('habits.none')}</p>:<ul className="card-list">{theirs.map(habit=><li key={habit.habitId} className="habit-row"><span className="grow">
    <span>{habit.title}</span><Progress habit={habit} language={language}/>
    <span className="muted">{[t(habit.period==='daily'?'routines.daily':'routines.weekly'),habit.state==='paused'&&t('habits.paused'),habit.streaks.current>0&&t('habits.streak',{count:String(habit.streaks.current)}),habit.streaks.longest>1&&t('habits.streakBest',{count:String(habit.streaks.longest)}),...habit.results.slice(0,3).map(r=>t(resultKeys[r.result]))].filter(Boolean).join(t('catalog.separator'))}</span></span>
    <HabitBreaks habit={habit} householdId={householdId} session={session} language={language} onChanged={()=>onChanged('habits.saved')}/>
    <HabitHistory habit={habit} householdId={householdId} session={session} language={language} onChanged={()=>onChanged('habits.saved')}/>
    {habit.canEdit&&<span className="row-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>setEditing(habit)}>{t('workspace.edit')}</button>
     <button type="button" className="secondary" disabled={busy} onClick={()=>{void state(habit,habit.state==='active'?'paused':'active');}}>{t(habit.state==='active'?'habits.pause':'habits.resume')}</button>
     <button type="button" className="secondary" disabled={busy} onClick={()=>{void state(habit,'archived');}}>{t('workspace.archive')}</button></span>}
   </li>)}</ul>}
   {editing&&<HabitForm habit={editing==='new'?undefined:editing} subjectId={subjectId} householdId={householdId} session={session} language={language} timeZone={timeZone} canOutcomes={canOutcomes}
    onClose={()=>setEditing(undefined)} onSaved={notice=>{setEditing(undefined);onChanged(notice);}}/>}
  </Layer>}
 </>;
}
