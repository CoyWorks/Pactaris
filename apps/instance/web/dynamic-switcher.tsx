import React,{useEffect,useRef,useState} from 'react';
import {createTranslator} from '../../../packages/i18n/index.js';
import {Icon,navigate} from './navigation.js';

type Listing={households:{id:string;name:string}[];nextCursor?:string|null;partial?:boolean};
/** The dynamic name in the top bar opens a menu of the person's dynamics. Choosing one, including the
 *  current one, opens its Today page; the menu also leads to creating a new dynamic. */
export function DynamicSwitcher({householdId,name,language}:{householdId:string;name:string;language:string}){
 const t=createTranslator(language),[open,setOpen]=useState(false),[listing,setListing]=useState<Listing>(),[failed,setFailed]=useState(false);
 const box=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  if(!open)return;
  let gone=false;setFailed(false);
  void fetch('/api/households',{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('households');const body=await r.json() as Listing;if(!gone)setListing(body);}).catch(()=>{if(!gone)setFailed(true);});
  const outside=(e:MouseEvent)=>{if(box.current&&!box.current.contains(e.target as Node))setOpen(false);};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);button.current?.focus();}};
  document.addEventListener('mousedown',outside);document.addEventListener('keydown',key);
  return()=>{gone=true;document.removeEventListener('mousedown',outside);document.removeEventListener('keydown',key);};
 },[open]);
 useEffect(()=>{if(open)box.current?.querySelector<HTMLButtonElement>('.switcher-menu button')?.focus();},[open,listing]);
 function go(to:string){setOpen(false);navigate(to);}
 const households=listing?.households??[{id:householdId,name}];
 return <div className="switcher" ref={box}>
  <button type="button" ref={button} className="title-button" aria-haspopup="true" aria-expanded={open} aria-label={t('workspace.switch')} onClick={()=>setOpen(!open)}>
   <span>{name}</span><Icon name="down"/></button>
  {open&&<ul className="switcher-menu" aria-label={t('workspace.switchMenu')}>
   <li className="switcher-heading" aria-hidden="true">{t('workspace.switchMenu')}</li>
   {households.map(h=><li key={h.id}><button type="button" aria-current={h.id===householdId} onClick={()=>go('/households/'+h.id)}>
    <span className="grow">{h.name}</span>{h.id===householdId&&<Icon name="check"/>}</button></li>)}
   {(failed||listing?.nextCursor||listing?.partial)&&<li><button type="button" onClick={()=>go('/?all')}><span className="grow">{t('workspace.allDynamics')}</span><Icon name="chevron"/></button></li>}
   <li><button type="button" onClick={()=>go('/?all&create')}><Icon name="plus"/><span className="grow">{t('workspace.newDynamic')}</span></button></li>
  </ul>}
 </div>;
}
