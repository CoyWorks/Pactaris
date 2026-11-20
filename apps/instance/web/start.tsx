import React,{useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import {Icon} from './navigation.js';
const storageKey=(householdId:string)=>'pactaris.start.'+householdId;
function stored(householdId:string){try{return window.localStorage.getItem(storageKey(householdId));}catch{return null;}}
function store(householdId:string,value:string){try{window.localStorage.setItem(storageKey(householdId),value);}catch{/* storage is a convenience */}}
/** Three steps for a new owner: invite, link as Dom and sub, give a first task. Hidden once done or dismissed on this device. */
export function GettingStarted({householdId,language,invited,linked,onInvite,onLink,onTask}:{householdId:string;language:string;invited:boolean;linked:boolean;onInvite:()=>void;onLink:()=>void;onTask:()=>void}){
 const t=createTranslator(language),[state,setState]=useState(()=>typeof window==='undefined'?null:stored(householdId));
 if(state==='hidden'||(state==='task'&&linked))return null;
 const steps:{key:MessageKey;done:boolean;go:()=>void}[]=[
  {key:'start.invite',done:invited,go:onInvite},
  {key:'start.link',done:linked,go:onLink},
  {key:'start.task',done:state==='task',go:()=>{store(householdId,'task');setState('task');onTask();}},
 ];
 return <section className="start-card" aria-labelledby={'start-'+householdId}>
  <div className="section-head"><h2 id={'start-'+householdId}>{t('start.title')}</h2><button type="button" className="link-button" onClick={()=>{store(householdId,'hidden');setState('hidden');}}>{t('start.hide')}</button></div>
  <ol className="menu">{steps.map((step,i)=><li key={step.key}><button type="button" disabled={step.done||(i===2&&!linked)} onClick={step.go}>
   <span className={'step-mark'+(step.done?' done':'')} aria-hidden="true">{step.done?<Icon name="check"/>:i+1}</span>
   <span className="grow"><span>{t(step.key)}</span>{step.done&&<span className="muted">{t('start.done')}</span>}</span>{!step.done&&<Icon name="chevron"/>}</button></li>)}</ol>
 </section>;
}
