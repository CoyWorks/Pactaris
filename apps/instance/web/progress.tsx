import React,{useEffect,useId,useState} from 'react';
import {createTranslator} from '../../../packages/i18n/index.js';
import type {AuthorityResult,ProgressPerson} from '../../../packages/auth/authority.js';
import {Hint} from './navigation.js';
import {Skeleton} from './today-habits.js';

export type Progress=Pick<AuthorityResult,'today'|'people'|'subsVisible'>;
/** Last 14 days for yourself and the people you may see. Reloads when `reload` changes. */
export function useProgress(householdId:string,reload:unknown){
 const [data,setData]=useState<Progress>(),[failed,setFailed]=useState(false);
 useEffect(()=>{
  let gone=false;const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  fetch(`/api/households/${householdId}/authority/progress`,{cache:'no-store',signal:controller.signal})
   .then(async r=>{const body=await r.json() as AuthorityResult;if(!r.ok)throw body;if(!gone){setData(body);setFailed(false);}})
   .catch(()=>{if(!gone)setFailed(true);}).finally(()=>clearTimeout(deadline));
  return()=>{gone=true;controller.abort();clearTimeout(deadline);};
 },[householdId,reload]);
 return {data,failed};
}
const sum=(values:number[])=>values.reduce((a,b)=>a+b,0);
/** Totals for the last 7 days and the 7 days before. */
export function week(person:ProgressPerson){
 const last=(v:number[])=>sum(v.slice(7)),before=(v:number[])=>sum(v.slice(0,7));
 return {tasks:last(person.tasks),tasksBefore:before(person.tasks),points:last(person.points),pointsBefore:before(person.points),reached:last(person.reached),missed:last(person.missed)};
}
function days(today:string){
 const end=Date.parse(today+'T00:00:00Z');
 return Array.from({length:14},(_,i)=>new Date(end-(13-i)*86400000).toISOString().slice(0,10));
}
function signed(value:number,format:string){return new Intl.NumberFormat(format,{signDisplay:'exceptZero'}).format(value);}

/** One series of daily values as columns from a single baseline. Hover or focus a day to read it; the table view holds every value. */
function DailyBars({title,values,dates,format}:{title:string;values:number[];dates:string[];format:string}){
 const [active,setActive]=useState<number>(),id=useId();
 const width=308,height=96,top=8,bottom=height-18,band=width/14,bar=Math.min(14,band-6),r=4;
 const hi=Math.max(0,...values),lo=Math.min(0,...values),span=Math.max(1,hi-lo),scale=(bottom-top)/span,zero=top+hi*scale;
 const day=new Intl.DateTimeFormat(format,{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'}),number=new Intl.NumberFormat(format);
 const label=(i:number)=>day.format(new Date(dates[i]+'T00:00:00Z'));
 const column=(i:number,value:number)=>{
  const x=i*band+(band-bar)/2,h=Math.abs(value)*scale;
  if(!value)return null;
  const rr=Math.min(r,h,bar/2);
  // Rounded at the data end, square at the baseline.
  return value>0
   ?<path d={`M${x},${zero}V${zero-h+rr}Q${x},${zero-h} ${x+rr},${zero-h}H${x+bar-rr}Q${x+bar},${zero-h} ${x+bar},${zero-h+rr}V${zero}Z`}/>
   :<path d={`M${x},${zero}V${zero+h-rr}Q${x},${zero+h} ${x+rr},${zero+h}H${x+bar-rr}Q${x+bar},${zero+h} ${x+bar},${zero+h-rr}V${zero}Z`}/>;
 };
 return <figure className="daily-bars" aria-labelledby={id}>
  <figcaption id={id}>{title}</figcaption>
  <p className="chart-readout" aria-live="polite">{active===undefined?' ':<><time dateTime={dates[active]}>{label(active)}</time> <strong>{number.format(values[active]!)}</strong></>}</p>
  <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={title} onPointerLeave={()=>setActive(undefined)}>
   <line className="chart-grid" x1={0} x2={width} y1={top} y2={top}/>
   <text className="chart-tick" x={0} y={top-1}>{number.format(hi)}</text>
   {lo<0&&<text className="chart-tick" x={0} y={bottom+10}>{number.format(lo)}</text>}
   {values.map((value,i)=><g key={dates[i]} className={'chart-column'+(active===i?' active':'')} tabIndex={0} role="img" aria-label={`${label(i)}: ${number.format(value)}`}
     onPointerEnter={()=>setActive(i)} onFocus={()=>setActive(i)} onBlur={()=>setActive(undefined)}>
    <rect className="chart-hit" x={i*band} y={0} width={band} height={height}/>{column(i,value)}
   </g>)}
   <line className="chart-axis" x1={0} x2={width} y1={zero} y2={zero}/>
   <text className="chart-tick" x={band/2} y={height-2} textAnchor="start">{label(0)}</text>
   <text className="chart-tick" x={width} y={height-2} textAnchor="end">{label(13)}</text>
  </svg>
 </figure>;
}
function Stat({label,value,note}:{label:string;value:string;note?:string}){
 return <div><strong>{value}</strong><span>{label}</span>{note&&<span className="stat-note">{note}</span>}</div>;
}
/** Weekly totals, two daily charts and a table view for one person. */
export function PersonProgress({person,today,language,format}:{person:ProgressPerson;today:string;language:string;format:string}){
 const t=createTranslator(language),w=week(person),dates=days(today),number=new Intl.NumberFormat(format);
 const day=new Intl.DateTimeFormat(format,{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
 return <div className="progress">
  <h4>{t('progress.thisWeek')}</h4>
  <div className="workspace-stats">
   <Stat label={t('progress.tasksDone')} value={number.format(w.tasks)} note={w.tasks!==w.tasksBefore?t('progress.change',{change:signed(w.tasks-w.tasksBefore,format)}):undefined}/>
   <Stat label={t('progress.points')} value={signed(w.points,format)}/>
   <Stat label={t('progress.openTasks')} value={number.format(person.openTasks)}/>
   <Stat label={t('progress.reached')} value={number.format(w.reached)}/>
   <Stat label={t('progress.missed')} value={number.format(w.missed)}/>
  </div>
  <DailyBars title={t('progress.tasksChart')} values={person.tasks} dates={dates} format={format}/>
  <DailyBars title={t('progress.pointsChart')} values={person.points} dates={dates} format={format}/>
  <Hint label={t('hint.more')}>{t('progress.pointsHelp')}</Hint>
  <details className="chart-table"><summary>{t('progress.table')}</summary>
   <table><thead><tr><th scope="col">{t('progress.day')}</th><th scope="col">{t('progress.tasksDone')}</th><th scope="col">{t('progress.points')}</th><th scope="col">{t('progress.reached')}</th><th scope="col">{t('progress.missed')}</th></tr></thead>
    <tbody>{dates.map((d,i)=><tr key={d}><th scope="row"><time dateTime={d}>{i===13?t('progress.today'):day.format(new Date(d+'T00:00:00Z'))}</time></th><td>{number.format(person.tasks[i]!)}</td><td>{signed(person.points[i]!,format)}</td><td>{number.format(person.reached[i]!)}</td><td>{number.format(person.missed[i]!)}</td></tr>)}</tbody></table>
  </details>
 </div>;
}
/** Everyone you may see, ordered by rank, with their last 7 days. */
export function BoardView({progress,failed,language,format}:{progress?:Progress;failed:boolean;language:string;format:string}){
 const t=createTranslator(language),[open,setOpen]=useState<string>(),number=new Intl.NumberFormat(format);
 if(failed)return <p role="alert">{t('progress.unavailable')}</p>;
 if(!progress?.people||!progress.today)return <Skeleton count={3} label={t('workspace.loading')}/>;
 const people=progress.people,detail=people.find(p=>p.membershipId===open);
 return <section className="plain">
  <Hint label={t('hint.more')}>{t('board.help')}</Hint>
  {!progress.subsVisible&&<p className="muted">{t('board.hidden')}</p>}
  {!people.length?<p className="muted">{t('board.empty')}</p>:<div className="board-scroll"><table className="board">
   <thead><tr><th scope="col">{t('board.rank')}</th><th scope="col">{t('board.person')}</th><th scope="col">{t('progress.tasksDone')}</th><th scope="col">{t('progress.points')}</th><th scope="col">{t('progress.reached')}</th><th scope="col">{t('progress.missed')}</th><th scope="col">{t('progress.openTasks')}</th><th scope="col">{t('board.balance')}</th></tr></thead>
   <tbody>{people.map(person=>{const w=week(person);return <tr key={person.membershipId} aria-current={person.self?'true':undefined}>
    <td>{person.rank??'–'}</td>
    <th scope="row"><button type="button" className="link-button" aria-expanded={open===person.membershipId} onClick={()=>setOpen(open===person.membershipId?undefined:person.membershipId)}>{person.name||t('partner.unnamed')}</button>
     <span className="muted">{[person.self&&t('board.you'),person.doms.join(', ')].filter(Boolean).join(t('catalog.separator'))}</span></th>
    <td>{number.format(w.tasks)}</td><td>{signed(w.points,format)}</td><td>{number.format(w.reached)}</td><td>{number.format(w.missed)}</td><td>{number.format(person.openTasks)}</td><td>{number.format(Number(person.balance))}</td>
   </tr>;})}</tbody></table></div>}
  {detail&&<section><h3>{detail.name||t('partner.unnamed')}</h3><PersonProgress person={detail} today={progress.today} language={language} format={format}/></section>}
 </section>;
}
