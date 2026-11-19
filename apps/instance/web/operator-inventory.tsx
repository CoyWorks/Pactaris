import React,{useEffect,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

type RegistryStatus='active'|'disabled';
type Instance={id:string;status:RegistryStatus;activePlacements:string;disabledPlacements:string};
type Placement={householdId:string;status:RegistryStatus;version:string};
type Inventory={observedAt:string;nextCursor:string|null;instances?:Instance[];placements?:Placement[]};
const labels:Record<RegistryStatus,MessageKey>={active:'operator.registryActive',disabled:'operator.registryDisabled'};

export function OperatorInventory({language,refresh}:{language:string;refresh:number}){
  const t=createTranslator(language);
  const [selected,setSelected]=useState<string>(),[after,setAfter]=useState<string>();
  const [result,setResult]=useState<Inventory>(),[error,setError]=useState<MessageKey>();
  useEffect(()=>{
    const controller=new AbortController();
    const url=selected?'/api/operator/instances/'+selected+'/placements':'/api/operator/instances';
    setResult(undefined);setError(undefined);
    void fetch(url+(after?'?after='+encodeURIComponent(after):''),{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])})
      .then(async response=>{
        if(!response.ok)throw response.status;
        const data=await response.json() as Inventory;
        if(!controller.signal.aborted)setResult(data);
      }).catch(status=>{
        if(!controller.signal.aborted)setError(status===401||status===403?'operator.authenticationRequired':'errors.unavailable');
      });
    return()=>controller.abort();
  },[selected,after,refresh]);
  function open(id?:string){setResult(undefined);setAfter(undefined);setSelected(id);}
  return <section>
    <h2>{t('operator.inventoryTitle')}</h2>
    <p>{t('operator.inventoryRegistryOnly')}</p>
    {selected&&<button type="button" onClick={()=>open()}>{t('operator.inventoryBack')}</button>}
    {error&&<p role="alert">{t(error)}</p>}
    {!error&&!result&&<p role="status">{t('portal.loading')}</p>}
    {result&&<>
      <p>{t('operator.inventoryObserved')} <time dateTime={result.observedAt}>{new Date(result.observedAt).toLocaleString(language)}</time></p>
      {result.instances&&<ul className="task-list">{result.instances.map(row=><li key={row.id}>
        <code>{row.id}</code> <span>{t(labels[row.status])}</span>
        <dl><dt>{t('operator.inventoryActiveCount')}</dt><dd>{row.activePlacements}</dd><dt>{t('operator.inventoryDisabledCount')}</dt><dd>{row.disabledPlacements}</dd></dl>
        <button type="button" onClick={()=>open(row.id)}>{t('operator.inventoryHouseholds')}</button>
      </li>)}</ul>}
      {result.placements&&<ul className="task-list">{result.placements.map(row=><li key={row.householdId}>
        <code>{row.householdId}</code> <span>{t(labels[row.status])}</span>
      </li>)}</ul>}
      {(result.instances??result.placements)?.length===0&&<p>{t('operator.inventoryEmpty')}</p>}
      {after&&<button type="button" onClick={()=>setAfter(undefined)}>{t('workspace.firstPage')}</button>}
      {result.nextCursor&&<button type="button" onClick={()=>setAfter(result.nextCursor??undefined)}>{t('portal.more')}</button>}
    </>}
  </section>;
}
