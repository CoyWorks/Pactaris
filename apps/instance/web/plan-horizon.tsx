import React,{createContext,useContext,useEffect,useState} from 'react';

// How far ahead dates may be planned on the dynamic's plan (docs/HOUSEHOLD_PLANS.md, `plan.horizon.days`).
// The workspace provides it once; date fields use it as their `max`, so a date beyond the plan cannot be
// picked. The server still checks. A date that was already set further ahead (before a downgrade) stays a
// valid value, because keeping a date is allowed.
const PlanHorizon=createContext<number|undefined>(undefined);
const cache=new Map<string,{at:number;days:Promise<number|undefined>}>();

function horizonDays(householdId:string):Promise<number|undefined>{
 const hit=cache.get(householdId);
 if(hit&&Date.now()-hit.at<300_000)return hit.days;
 const days=fetch('/api/households/'+householdId+'/plan?brief=1',{cache:'no-store'})
  .then(r=>r.ok?r.json() as Promise<{limits?:Record<string,number>}>:undefined)
  .then(v=>{const d=v?.limits?.['plan.horizon.days'];return Number.isInteger(d)&&d!>0?d:undefined;})
  .catch(()=>undefined);
 cache.set(householdId,{at:Date.now(),days});
 return days;
}

export function PlanHorizonProvider({householdId,children}:{householdId:string;children:React.ReactNode}){
 const [days,setDays]=useState<number>();
 useEffect(()=>{let live=true;void horizonDays(householdId).then(d=>{if(live)setDays(d);});return()=>{live=false;};},[householdId]);
 return <PlanHorizon.Provider value={days}>{children}</PlanHorizon.Provider>;
}

const pad=(n:number)=>String(n).padStart(2,'0');
const localDate=(d:Date)=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const localDateTime=(d:Date)=>localDate(d)+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
/** The later of two values in the same format (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` sort as text). */
const later=(a:string|undefined,b:string|undefined)=>!a?undefined:!b||a>=b?a:b;

/** The latest value a date field may hold: now plus the horizon, or the value the item already had if
 *  that is later. `withTime` gives `YYYY-MM-DDTHH:mm` (datetime-local), otherwise `YYYY-MM-DD`. Pure, for tests. */
export function horizonLimit(days:number|undefined,now:Date,keep:string|null|undefined,withTime:boolean):string|undefined{
 if(days===undefined)return undefined;
 const end=new Date(now.getTime()+days*86_400_000);
 return later(withTime?localDateTime(end):localDate(end),keep??undefined);
}
/** `max` for a `date` input; `keep` is the value the item already had, which stays allowed. */
export function useHorizonDate(keep?:string|null):string|undefined{return horizonLimit(useContext(PlanHorizon),new Date(),keep,false);}
/** `max` for a `datetime-local` input; `keep` is the value the item already had, which stays allowed. */
export function useHorizonDateTime(keep?:string|null):string|undefined{return horizonLimit(useContext(PlanHorizon),new Date(),keep,true);}
