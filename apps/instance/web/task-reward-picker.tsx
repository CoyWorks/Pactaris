import React,{useState} from 'react';
import {createTranslator} from '../../../packages/i18n/index.js';
import type {CatalogResult,CatalogSummary} from '../../../packages/auth/catalog.js';
import type {TaskRewardReference} from '../../../packages/auth/partner.js';

export function TaskRewardPicker({householdId,csrfToken,language,value,change,disabled}:{
 householdId:string;csrfToken:string;language:string;value?:TaskRewardReference;
 change:(value:TaskRewardReference|undefined)=>void;disabled:boolean;
}){
 const t=createTranslator(language);
 const [items,setItems]=useState<CatalogSummary[]>([]),[cursor,setCursor]=useState<string|null>();
 const [failed,setFailed]=useState(false),[busy,setBusy]=useState(false);
 async function load(){
  setFailed(false);setBusy(true);
  try{
   const response=await fetch('/api/households/'+householdId+'/catalog/catalogList',{
     method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
     body:JSON.stringify({operationId:crypto.randomUUID(),filter:'current',...(cursor?{after:cursor}:{})})
   });
   if(!response.ok)throw Error('catalog.unavailable');
   const {items:page,nextCursor}=await response.json() as CatalogResult;
   setItems(previous=>cursor?[...previous,...(page??[])]:page??[]);
   setCursor(nextCursor??null);
  }catch{setFailed(true);}finally{setBusy(false);}
 }
 return <fieldset disabled={disabled||busy}>
  <legend>{t('partner.catalogReward')}</legend>
  <p>{t('partner.catalogRewardHelp')}</p>
  {failed&&<p role="alert">{t('errors.unavailable')}</p>}
  {cursor!==null&&<button type="button" onClick={()=>void load()}>{t(cursor?'portal.more':'partner.loadCatalogRewards')}</button>}
  {cursor===null&&!items.length&&<p>{t('partner.catalogRewardEmpty')}</p>}
  {items.map(item=><label key={item.itemId}>
    <input type="radio" name="task-catalog-reward" value={item.itemId}
      checked={value?.itemId===item.itemId&&value.version===item.version}
      onChange={()=>change({itemId:item.itemId,version:item.version})}/> {item.title}
  </label>)}
  {value&&<button type="button" onClick={()=>change(undefined)}>{t('partner.removeCatalogReward')}</button>}
 </fieldset>;
}
