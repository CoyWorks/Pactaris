import React,{useEffect,useMemo,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import {calendarMarkKind,type CalendarMarkKind,type Planner,type PlannerItem,type PlannerKind} from '../../../packages/auth/workspace.js';
import {Icon} from './navigation.js';

// Planner (docs/PLANNER.md): everything with a date for one person, read-only. Dates are local
// calendar days in the dynamic's time zone; the server limits a request to 42 days.
/** Sets whether an item's title is hidden in calendar subscriptions (docs/CALENDAR_FEED.md). */
export async function markCalendar(householdId:string,csrfToken:string,kind:CalendarMarkKind,resourceId:string,hidden:boolean):Promise<boolean>{
 try{const r=await fetch('/api/households/'+householdId+'/calendar-mark',{method:'POST',headers:{'content-type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({kind,resourceId,hidden})});return r.ok;}
 catch{return false;}
}
/** The checkbox on create forms. Only shown and stored when ticked; the default is a visible title. */
export function CalendarPrivacyField({language,checked,disabled,onChange}:{language:string;checked:boolean;disabled?:boolean;onChange:(value:boolean)=>void}){
 const t=createTranslator(language);
 return <><label className="check"><input type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/>{t('calendar.hideTitle')}</label>
  <p className="muted">{t('calendar.hideTitleHelp')}</p></>;
}
export type PlannerTarget='tasks'|'participantTasks'|'habits'|'checkins'|'home'|'authority';
type Mode='agenda'|'week'|'month';

export const dayIn=(zone:string,at=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
export const addDays=(day:string,n:number)=>{const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const weekStart=(day:string)=>{const d=new Date(day+'T00:00:00Z');return addDays(day,-((d.getUTCDay()+6)%7));};
const monthStart=(day:string)=>day.slice(0,8)+'01';
const asDate=(day:string)=>new Date(day+'T12:00:00Z');

const kindLabel:Record<PlannerKind,MessageKey>={task:'planner.kindTask',taskSeries:'planner.kindTask',partnerTask:'planner.kindShared',partnerSeries:'planner.kindShared',
 habit:'planner.kindHabit',routineHabit:'planner.kindHabit',ritual:'planner.kindRitual',checkin:'planner.kindCheckin'};
export function plannerTarget(item:PlannerItem,self:boolean):PlannerTarget{
 if(item.kind==='task'||item.kind==='taskSeries')return 'tasks';
 if(item.kind==='partnerTask'||item.kind==='partnerSeries')return 'participantTasks';
 if(item.kind==='habit')return self?'home':'authority';
 return item.kind==='routineHabit'?'habits':'checkins';
}

export function usePlanner(householdId:string,from:string,days:number,person:string|undefined,zone:string,reload:unknown){
 const [data,setData]=useState<Planner>(),[failed,setFailed]=useState(false),[loading,setLoading]=useState(true);
 useEffect(()=>{
  let live=true;setLoading(true);setFailed(false);
  const query=new URLSearchParams({from,days:String(days),timeZone:zone,...(person?{person}:{})});
  void fetch('/api/households/'+householdId+'/planner?'+query.toString(),{cache:'no-store'})
   .then(r=>r.ok?r.json() as Promise<{planner:Planner}>:Promise.reject(new Error('planner')))
   .then(body=>{if(live)setData(body.planner);}).catch(()=>{if(live)setFailed(true);}).finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;};
 },[householdId,from,days,person,zone,reload]);
 return {data,failed,loading};
}

function Badges({item,language}:{item:PlannerItem;language:string}){
 const t=createTranslator(language),badges:MessageKey[]=[];
 if(item.onBreak)badges.push('planner.onBreak');
 if(item.overdue)badges.push('planner.overdue');
 if(['done','reached'].includes(item.state))badges.push('planner.done');
 if(item.state==='missed')badges.push('planner.missed');
 if(item.state==='submitted')badges.push('planner.submitted');
 return badges.length?<span className="planner-badges">{badges.map(k=><span key={k} className={'planner-badge '+k.split('.')[1]}>{t(k)}</span>)}</span>:null;
}

/** Moving one-off items: drag to a day, or the move button with a date field (also on phones). */
type Mover={can:(item:PlannerItem)=>boolean;today:string;dragging?:PlannerItem;drag:(item?:PlannerItem)=>void;to:(item:PlannerItem,day:string)=>void};
function ItemRow({item,language,format,zone,onOpen,withDate=false,onToggleHidden,mover}:{item:PlannerItem;language:string;format:string;zone:string;onOpen:(item:PlannerItem)=>void;withDate?:boolean;onToggleHidden?:(item:PlannerItem)=>void;mover?:Mover}){
 const t=createTranslator(language),[picking,setPicking]=useState(false),movable=!!mover?.can(item);
 const time=withDate?new Intl.DateTimeFormat(format,{day:'numeric',month:'short',timeZone:'UTC'}).format(asDate(item.day))
  :item.at?new Intl.DateTimeFormat(format,{hour:'2-digit',minute:'2-digit',timeZone:zone}).format(new Date(item.at)):t('planner.anyTime');
 return <li className={'planner-row'+(movable?' movable':'')+(mover?.dragging===item?' dragging':'')} draggable={movable}
  onDragStart={movable?e=>{e.dataTransfer.setData('text/plain',item.id);e.dataTransfer.effectAllowed='move';mover!.drag(item);}:undefined}
  onDragEnd={movable?()=>mover!.drag(undefined):undefined}>
  <button type="button" className={'planner-item'+(item.onBreak?' muted-item':'')} onClick={()=>onOpen(item)}>
  <span className="planner-time">{time}</span>
  <span className="grow"><strong>{item.title}</strong><span className="muted">{t(kindLabel[item.kind])}{item.hidden&&<span className="planner-hidden">{t('calendar.hidden')}</span>}</span></span>
  <Badges item={item} language={language}/>
 </button>{movable&&<button type="button" className="icon-button planner-move" aria-expanded={picking} aria-label={t('planner.move')} title={t('planner.move')} onClick={()=>setPicking(v=>!v)}><Icon name="move"/></button>}
 {onToggleHidden&&<button type="button" className="icon-button planner-eye" aria-pressed={item.hidden} aria-label={t(item.hidden?'calendar.showAction':'calendar.hideAction')} title={t(item.hidden?'calendar.showAction':'calendar.hideAction')} onClick={()=>onToggleHidden(item)}><Icon name={item.hidden?'eyeOff':'eye'}/></button>}
 {picking&&mover&&<label className="planner-move-date">{t('planner.moveDate')}<input type="date" min={mover.today} defaultValue={item.day} autoFocus
  onChange={e=>{if(e.target.value&&e.target.value!==item.day){setPicking(false);mover.to(item,e.target.value);}}}/></label>}</li>;
}

/** Drop handlers for a day: only days from today on accept a dragged item. */
const dropOn=(mover:Mover|undefined,day:string)=>mover?.dragging&&day>=mover.today?{
 onDragOver:(e:React.DragEvent)=>{e.preventDefault();e.dataTransfer.dropEffect='move';},
 onDrop:(e:React.DragEvent)=>{e.preventDefault();const item=mover.dragging!;mover.drag(undefined);mover.to(item,day);}}:{};
function DayList({day,items,today,language,format,zone,onOpen,showEmpty,onToggleHidden,mover}:{day:string;items:PlannerItem[];today:string;language:string;format:string;zone:string;onOpen:(item:PlannerItem)=>void;showEmpty:boolean;onToggleHidden?:(item:PlannerItem)=>void;mover?:Mover}){
 const t=createTranslator(language);
 if(!items.length&&!showEmpty&&!(mover?.dragging&&day>=today))return null;
 const label=new Intl.DateTimeFormat(format,{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'}).format(asDate(day));
 return <section className={'planner-day'+(mover?.dragging&&day>=today?' drop-target':'')} aria-label={label} {...dropOn(mover,day)}>
  <h3>{day===today?t('planner.todayLabel',{date:label}):label}</h3>
  {items.length?<ul className="planner-list">{items.map(item=><ItemRow key={item.kind+item.id+item.day} item={item} language={language} format={format} zone={zone} onOpen={onOpen} onToggleHidden={onToggleHidden} mover={mover}/>)}</ul>
   :<p className="muted">{t('planner.nothing')}</p>}
 </section>;
}

/** Tasks → Calendar: agenda (next 7 days), week or month, for yourself or someone you hold task authority over. */
export function PlannerView({householdId,csrfToken,language,format,timeZone,reload,onOpen,initialMode='agenda'}:{householdId:string;csrfToken:string;language:string;format:string;timeZone:string;reload:unknown;onOpen:(target:PlannerTarget)=>void;initialMode?:Mode}){
 const t=createTranslator(language),today=dayIn(timeZone);
 const [mode,setMode]=useState<Mode>(initialMode),[anchor,setAnchor]=useState(today),[person,setPerson]=useState<string>(),[selected,setSelected]=useState<string>();
 const lookBack=mode==='agenda'?14:0;
 const range=useMemo(()=>mode==='agenda'?{from:addDays(anchor,-14),days:21}:mode==='week'?{from:weekStart(anchor),days:7}:{from:weekStart(monthStart(anchor)),days:42},[mode,anchor]);
 const [marks,setMarks]=useState<Record<string,boolean>>({}),[markError,setMarkError]=useState(false);
 const [tick,setTick]=useState(0),[dragging,setDragging]=useState<PlannerItem>(),[moveMessage,setMoveMessage]=useState<MessageKey>();
 const planner=usePlanner(householdId,range.from,range.days,person,timeZone,String(reload)+':'+tick);
 const {failed,loading}=planner;
 const data=useMemo(()=>planner.data&&{...planner.data,items:planner.data.items.map(i=>i.id in marks?{...i,hidden:marks[i.id]!}:i)},[planner.data,marks]);
 const byDay=useMemo(()=>{const map=new Map<string,PlannerItem[]>();for(const item of data?.items??[]){const list=map.get(item.day)??[];list.push(item);map.set(item.day,list);}return map;},[data]);
 const days=Array.from({length:range.days-lookBack},(_,i)=>addDays(range.from,i+lookBack));
 const overdue=lookBack?(data?.items??[]).filter(i=>i.day<days[0]!&&i.overdue):[];
 const self=!person||data?.people.find(p=>p.id===person)?.self===true;
 const open=(item:PlannerItem)=>onOpen(plannerTarget(item,self));
 // Own one-off tasks in your own calendar, and tasks you gave in the calendar of the person who has them.
 const mover:Mover={today,dragging,drag:setDragging,
  can:item=>!item.projected&&!!item.at&&!['done','declined','cancelled','archived'].includes(item.state)&&(item.kind==='task'?self:item.kind==='partnerTask'&&!self),
  to:(item,day)=>{if(day===item.day)return;setMoveMessage(undefined);
   void fetch('/api/households/'+householdId+'/planner/move',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({kind:item.kind,itemId:item.id,day,timeZone})})
    .then(async r=>{if(r.ok){setMoveMessage('planner.moved');setTick(v=>v+1);return;}
     const key=((await r.json().catch(()=>({}))) as {messageKey?:string}).messageKey;
     setMoveMessage(key==='workspace.horizon'||key==='workspace.paused'?key:'planner.moveFailed');})
    .catch(()=>setMoveMessage('planner.moveFailed'));}};
 const anyMovable=(data?.items??[]).some(mover.can);
 const toggle=self?(item:PlannerItem)=>{const next=!item.hidden;setMarkError(false);setMarks(m=>({...m,[item.id]:next}));
  void markCalendar(householdId,csrfToken,calendarMarkKind(item.kind),item.id,next).then(ok=>{if(!ok){setMarks(m=>({...m,[item.id]:!next}));setMarkError(true);}});}:undefined;
 const step=mode==='month'?null:7;
 const move=(direction:1|-1)=>{
  if(step)setAnchor(a=>addDays(a,direction*step));
  else setAnchor(a=>{const d=new Date(monthStart(a)+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+direction);return d.toISOString().slice(0,10);});
  setSelected(undefined);
 };
 const title=mode==='month'?new Intl.DateTimeFormat(format,{month:'long',year:'numeric',timeZone:'UTC'}).format(asDate(monthStart(anchor)))
  :new Intl.DateTimeFormat(format,{day:'numeric',month:'short',timeZone:'UTC'}).formatRange(asDate(days[0]!),asDate(days[days.length-1]!));
 const inMonth=(day:string)=>day.slice(0,7)===anchor.slice(0,7);
 return <section className="plain planner">
  <div className="chips" role="group" aria-label={t('planner.view')}>
   {(['agenda','week','month'] as const).map(m=><button type="button" key={m} aria-pressed={mode===m} onClick={()=>{setMode(m);setSelected(undefined);}}>{t(({agenda:'planner.agenda',week:'planner.week',month:'planner.month'} as const)[m])}</button>)}
  </div>
  {(data?.people.length??0)>1&&<label className="planner-person">{t('planner.person')}
   <select value={person??''} onChange={e=>{setPerson(e.target.value||undefined);setSelected(undefined);}}>
    {data!.people.map(p=><option key={p.id} value={p.self?'':p.id}>{p.self?t('planner.me'):p.name}</option>)}
   </select></label>}
  <div className="planner-nav">
   <button type="button" className="icon-button" aria-label={t('planner.previous')} onClick={()=>move(-1)}><Icon name="back"/></button>
   <strong aria-live="polite">{title}</strong>
   <button type="button" className="icon-button" aria-label={t('planner.next')} onClick={()=>move(1)}><Icon name="chevron"/></button>
   <button type="button" className="link-button" disabled={anchor===today} onClick={()=>{setAnchor(today);setSelected(undefined);}}>{t('planner.today')}</button>
  </div>
  {failed&&<p role="alert">{t('planner.failed')}</p>}
  {markError&&<p role="alert">{t('calendar.failed')}</p>}
  {moveMessage&&<p role={moveMessage==='planner.moved'?'status':'alert'}>{t(moveMessage)}</p>}
  {anyMovable&&<p className="muted planner-hint">{t('planner.moveHint')}</p>}
  {loading&&!data&&<p role="status">{t('portal.loading')}</p>}
  {data&&mode!=='month'&&<>
   {overdue.length>0&&<section className="planner-day" aria-label={t('planner.overdueTitle')}><h3>{t('planner.overdueTitle')}</h3><ul className="planner-list">{overdue.map(item=><ItemRow key={item.kind+item.id+item.day} item={item} language={language} format={format} zone={timeZone} onOpen={open} onToggleHidden={toggle} mover={mover} withDate/>)}</ul></section>}
   {mode==='agenda'&&!days.some(d=>(byDay.get(d)??[]).length)&&<div className="empty-card"><p>{t('planner.emptyWeek')}</p></div>}
   {days.map(day=><DayList key={day} day={day} items={byDay.get(day)??[]} today={today} language={language} format={format} zone={timeZone} onOpen={open} onToggleHidden={toggle} mover={mover} showEmpty={mode==='week'}/>)}
  </>}
  {data&&mode==='month'&&<>
   <div className="planner-month" role="grid" aria-label={title}>
    {days.slice(0,7).map(day=><span key={'h'+day} className="planner-weekday" role="columnheader">{new Intl.DateTimeFormat(format,{weekday:'short',timeZone:'UTC'}).format(asDate(day))}</span>)}
    {days.map(day=>{const items=byDay.get(day)??[],label=new Intl.DateTimeFormat(format,{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'}).format(asDate(day));
     return <button type="button" role="gridcell" key={day} aria-label={label+(items.length?', '+t('planner.itemCount',{count:String(items.length)}):'')} aria-pressed={selected===day}
      className={'planner-cell'+(inMonth(day)?'':' outside')+(day===today?' today':'')+(dragging&&day>=today?' drop-target':'')} onClick={()=>setSelected(day)} {...dropOn(mover,day)}>
      <span className="planner-date">{Number(day.slice(8))}</span>
      <span className="planner-dots" aria-hidden="true">{items.slice(0,3).map(i=><span key={i.kind+i.id} className={'dot'+(i.overdue?' overdue':'')}/>)}{items.length>3&&<span className="more">{t('planner.more',{count:String(items.length-3)})}</span>}</span>
     </button>;})}
   </div>
   {selected&&<DayList day={selected} items={byDay.get(selected)??[]} today={today} language={language} format={format} zone={timeZone} onOpen={open} onToggleHidden={toggle} mover={mover} showEmpty/>}
  </>}
 {self&&<CalendarSubscription householdId={householdId} csrfToken={csrfToken} language={language} format={format}/>}
 </section>;
}

/** Today: a compact strip of the coming seven days. Tapping it opens Tasks → Calendar. */
export function WeekGlance({householdId,language,format,timeZone,reload,onOpen}:{householdId:string;language:string;format:string;timeZone:string;reload:unknown;onOpen:()=>void}){
 const t=createTranslator(language),today=dayIn(timeZone);
 const {data}=usePlanner(householdId,today,7,undefined,timeZone,reload);
 if(!data)return null;
 const days=Array.from({length:7},(_,i)=>addDays(today,i));
 const count=(day:string)=>data.items.filter(i=>i.day===day&&!i.onBreak).length;
 return <section className="plain week-glance">
  <div className="section-head"><h2>{t('planner.comingWeek')}</h2><button type="button" className="link-button" onClick={onOpen}>{t('planner.openCalendar')}</button></div>
  <ol className="glance-days">{days.map(day=>{const n=count(day),overdue=data.items.some(i=>i.day===day&&i.overdue);
   return <li key={day}><button type="button" onClick={onOpen} aria-label={new Intl.DateTimeFormat(format,{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'}).format(asDate(day))+', '+t('planner.itemCount',{count:String(n)})} className={day===today?'today':''}>
    <span className="muted">{new Intl.DateTimeFormat(format,{weekday:'short',timeZone:'UTC'}).format(asDate(day))}</span>
    <strong>{Number(day.slice(8))}</strong>
    <span className={'glance-count'+(overdue?' overdue':'')+(n?'':' empty')}>{n||'·'}</span>
   </button></li>;})}</ol>
 </section>;
}

type FeedState={active:boolean;createdAt:string|null;lastUsedAt:string|null;url?:string;webcalUrl?:string};
/** The private ICS link for this account and dynamic: create, renew or stop it. The link is shown only once. */
function CalendarSubscription({householdId,csrfToken,language,format}:{householdId:string;csrfToken:string;language:string;format:string}){
 const t=createTranslator(language),[state,setState]=useState<FeedState>(),[busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
 useEffect(()=>{let live=true;void fetch('/api/households/'+householdId+'/calendar-feed',{cache:'no-store'}).then(r=>r.ok?r.json() as Promise<FeedState>:undefined).then(v=>{if(live&&v)setState(v);}).catch(()=>undefined);return()=>{live=false;};},[householdId]);
 async function send(method:'POST'|'DELETE'){
  if(busy)return;setBusy(true);setMessage(undefined);
  try{const r=await fetch('/api/households/'+householdId+'/calendar-feed',{method,headers:{'X-CSRF-Token':csrfToken}});if(!r.ok)throw Error('feed');
   setState(await r.json() as FeedState);if(method==='DELETE')setMessage('calendar.revoked');}
  catch{setMessage('calendar.failed');}finally{setBusy(false);}
 }
 async function copy(url:string){try{await navigator.clipboard.writeText(url);setMessage('calendar.copied');}catch{setMessage('calendar.failed');}}
 if(!state)return null;
 const lastUsed=state.lastUsedAt?t('calendar.lastUsed',{time:new Intl.DateTimeFormat(format,{dateStyle:'medium',timeStyle:'short'}).format(new Date(state.lastUsedAt))}):t('calendar.neverUsed');
 return <section className="calendar-subscription">
  <h2>{t('calendar.subscribeTitle')}</h2>
  <p className="muted">{t('calendar.subscribeHelp')}</p>
  {state.url&&state.webcalUrl&&<div className="notice">
   <p>{t('calendar.linkOnce')}</p>
   <input readOnly value={state.url} aria-label={t('calendar.subscribeTitle')} onFocus={e=>e.target.select()}/>
   <div className="calendar-actions">
    <button type="button" onClick={()=>{void copy(state.url!);}}>{t('calendar.copy')}</button>
    <a className="button" href={'https://calendar.google.com/calendar/r?cid='+encodeURIComponent(state.webcalUrl)} target="_blank" rel="noopener noreferrer">{t('calendar.google')}</a>
    <a className="button" href={state.webcalUrl}>{t('calendar.apple')}</a>
    <a className="button" href={'https://outlook.live.com/calendar/0/addfromweb?url='+encodeURIComponent(state.url)+'&name=Pactaris'} target="_blank" rel="noopener noreferrer">{t('calendar.outlook')}</a>
   </div>
  </div>}
  {state.active&&!state.url&&<p>{t('calendar.active')} <span className="muted">{lastUsed}</span></p>}
  {message&&<p role="status">{t(message)}</p>}
  <div className="calendar-actions">
   {!state.active?<button type="button" disabled={busy} onClick={()=>{void send('POST');}}>{t('calendar.create')}</button>
    :<><button type="button" className="secondary" disabled={busy} onClick={()=>{void send('POST');}}>{t('calendar.renew')}</button>
     <button type="button" className="danger" disabled={busy} onClick={()=>{void send('DELETE');}}>{t('calendar.revoke')}</button></>}
  </div>
  {state.active&&<p className="muted">{t('calendar.renewHelp')}</p>}
 </section>;
}
