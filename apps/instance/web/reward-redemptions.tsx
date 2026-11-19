import React,{useEffect,useState} from 'react';
import {createTranslator} from '../../../packages/i18n/index.js';
import type {CatalogDetail,CatalogResult,Redemption,RewardOption} from '../../../packages/auth/catalog.js';

const stateLabels={
 offered:'catalog.redemptionOffered',requested:'catalog.redemptionRequested',fulfilled:'catalog.redemptionFulfilled',
 cancelled:'catalog.redemptionCancelled',declined:'catalog.redemptionDeclined',reversed:'catalog.redemptionReversed',expired:'catalog.redemptionExpired'
} as const;
const actions={
 redemptionRequest:'catalog.requestReward',redemptionFulfill:'catalog.fulfillReward',redemptionCancel:'catalog.cancelReward',
 redemptionDecline:'catalog.declineReward',redemptionReverse:'catalog.reverseReward'
} as const;
type Action=keyof typeof actions;

function availableActions(item:Redemption):Action[]{
 if(item.state==='offered')return item.role==='recipient'?['redemptionRequest','redemptionDecline']:['redemptionCancel'];
 if(item.state==='requested')return item.role==='issuer'?['redemptionFulfill','redemptionDecline','redemptionCancel']:['redemptionCancel'];
 if(item.state==='fulfilled'&&item.role==='issuer')return ['redemptionReverse'];
 return [];
}

export function RewardRedemptions({base,csrfToken,language,format,detail,refresh,blocked,onAction}:{
 base:string;csrfToken:string;language:string;format:string;detail?:CatalogDetail;refresh:number;blocked:boolean;
 onAction:(action:string,body:Record<string,unknown>)=>void;
}){
 const t=createTranslator(language);
 const number=new Intl.NumberFormat(format);
 const [result,setResult]=useState<CatalogResult>();
 const [options,setOptions]=useState<CatalogResult>();
 const [failed,setFailed]=useState(false);
 const [optionsFailed,setOptionsFailed]=useState(false);
 const [cursor,setCursor]=useState<string>();
 const [optionsCursor,setOptionsCursor]=useState<string>();
 const [show,setShow]=useState(false);
 const [selected,setSelected]=useState('');
 const [reload,setReload]=useState(0);
 const offerable=detail?.state==='draft'&&!detail.historical&&detail.points!==null;
 const offerId=offerable?detail?.itemId:undefined;
 const version=offerable?detail?.version:undefined;
 const offerKind=detail?.kind??'reward';
 useEffect(()=>{setOptions(undefined);setShow(false);setOptionsCursor(undefined);setSelected('');},[offerId,version,refresh]);

 function read(action:string,after:string|undefined,signal:AbortSignal){
  return fetch(base+action,{method:'POST',cache:'no-store',signal,
   headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
   body:JSON.stringify({operationId:crypto.randomUUID(),...(after?{after}:{}),...(action==='redemptionOptions'?{activity:offerKind==='consequence'?'consequence':'reward'}:{})})})
   .then(response=>{if(!response.ok)throw Error('catalog.unavailable');return response.json() as Promise<CatalogResult>;});
 }
 useEffect(()=>{
  let stale=false;
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),12000);
  void read('redemptionList',cursor,controller.signal)
   .then(data=>{if(!stale){setResult(data);setFailed(false);}})
   .catch(()=>{if(!stale){setResult(undefined);setFailed(true);}})
   .finally(()=>clearTimeout(deadline));
  return()=>{stale=true;controller.abort();clearTimeout(deadline);};
 },[base,csrfToken,cursor,refresh,reload]);

 useEffect(()=>{
  if(!show||!offerId)return;
  let stale=false;
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),12000);
  void read('redemptionOptions',optionsCursor,controller.signal)
   .then(data=>{if(!stale){setOptions(data);setOptionsFailed(false);}})
   .catch(()=>{if(!stale){setOptions(undefined);setOptionsFailed(true);}})
   .finally(()=>clearTimeout(deadline));
  return()=>{stale=true;controller.abort();clearTimeout(deadline);};
 },[base,csrfToken,offerId,offerKind,show,optionsCursor,reload]);

 const key=(option:RewardOption)=>option.agreementId+':'+option.memberId;
 const recipient=options?.rewardOptions?.find(option=>key(option)===selected);
 return <section>
  <h3>{t('catalog.redemptions')}</h3>
  {offerable&&detail&&<>
   <button type="button" disabled={blocked} aria-expanded={show} onClick={()=>setShow(!show)}>{t(offerKind==='reward'?'catalog.offerReward':'catalog.offerOutcome')}</button>
   {show&&<form onSubmit={event=>{
    event.preventDefault();
    if(recipient)onAction('redemptionOffer',{itemId:detail.itemId,itemVersion:detail.version,agreementId:recipient.agreementId,
     agreementVersion:recipient.version,recipientId:recipient.memberId});
   }}>
    <p>{t(offerKind==='consequence'?'catalog.consequenceOfferHelp':'catalog.offerRewardHelp')}</p>
    {optionsFailed&&<p role="alert">{t('catalog.unavailable')}</p>}
    {options?.rewardOptions?.length===0&&<p>{t('catalog.noRewardScope')}</p>}
    {options?.rewardOptions?.length?<label>{t('catalog.rewardScope')}<select value={selected} disabled={blocked} required
     onChange={event=>setSelected(event.target.value)}>
     <option value="">{t('catalog.rewardScope')}</option>
     {options.rewardOptions.map(option=><option value={key(option)} key={key(option)}>
      {option.label} · {option.memberName||t('partner.unnamed')}
     </option>)}
    </select></label>:null}
    {options?.nextCursor&&<button type="button" onClick={()=>{setSelected('');setOptionsCursor(options.nextCursor!);}}>{t('portal.more')}</button>}
    {optionsCursor&&<button type="button" onClick={()=>{setSelected('');setOptionsCursor(undefined);}}>{t('workspace.firstPage')}</button>}
    <button type="submit" disabled={blocked||!recipient}>{t(offerKind==='reward'?'catalog.offerReward':'catalog.offerOutcome')}</button>
   </form>}
  </>}
  {failed&&<p role="alert">{t('catalog.unavailable')}</p>}
  {result?.redemptions?.length===0&&<p>{t('catalog.noRedemptions')}</p>}
  <ul>{result?.redemptions?.map(item=><li key={item.redemptionId}>
   <h4>{item.title}</h4><p>{item.description}</p>
   <p>{t(stateLabels[item.state])} · {item.kind==='consequence'?t('catalog.noPointEffect'):t(item.kind==='grant'?'catalog.pointCredit':'catalog.pointCost',{count:number.format(item.points)})}</p>
   {availableActions(item).map(action=><button key={action} type="button" disabled={blocked}
    onClick={()=>onAction(action,{redemptionId:item.redemptionId,version:item.version})}>{t(action==='redemptionFulfill'?(item.kind==='grant'?'catalog.fulfillGrant':item.kind==='consequence'?'catalog.recordConsequence':actions[action]):
     action==='redemptionRequest'&&item.kind!=='reward'?'catalog.acceptOutcome':
     action==='redemptionReverse'?(item.kind==='grant'?'catalog.reverseCredit':item.kind==='consequence'?'catalog.correctOutcome':actions[action]):actions[action])}</button>)}
  </li>)}</ul>
  {result?.nextCursor&&<button type="button" onClick={()=>setCursor(result.nextCursor!)}>{t('portal.more')}</button>}
  {cursor&&<button type="button" onClick={()=>setCursor(undefined)}>{t('workspace.firstPage')}</button>}
  <button type="button" onClick={()=>setReload(value=>value+1)}>{t('members.refresh')}</button>
 </section>;
}
