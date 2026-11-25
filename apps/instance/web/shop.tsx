import React,{useEffect,useRef,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {AuthorityResult,ShopFields,ShopItem,ShopOffer} from '../../../packages/auth/authority.js';
import {Hint,Layer} from './navigation.js';
import {Skeleton} from './today-habits.js';
import {authoritySend} from './authority.js';
type Session={csrfToken:string};
export type Shop=Pick<AuthorityResult,'balance'|'canSpend'|'pointsEnabled'|'offers'|'items'|'requests'|'purchases'>;
/** Rewards you can buy, your own rewards and punishments, and purchases waiting for you. */
export function useShop(householdId:string,reload:unknown){
 const [data,setData]=useState<Shop>(),[failed,setFailed]=useState(false),[change,setChange]=useState(0);
 useEffect(()=>{const changed=(event:Event)=>{if((event as CustomEvent<string>).detail===householdId)setChange(v=>v+1);};window.addEventListener('pactaris:dynamicChanges',changed);return()=>window.removeEventListener('pactaris:dynamicChanges',changed);},[householdId]);
 useEffect(()=>{
  let gone=false;const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  fetch(`/api/households/${householdId}/authority/shop`,{cache:'no-store',signal:controller.signal})
   .then(async r=>{const body=await r.json();if(!r.ok)throw body;if(!gone){setData(body as Shop);setFailed(false);}})
   .catch(()=>{if(!gone)setFailed(true);}).finally(()=>clearTimeout(deadline));
  return()=>{gone=true;controller.abort();clearTimeout(deadline);};
 },[householdId,reload,change]);
 return {data,failed};
}
/** Your punishment list, for picking one while giving a punishment, recording a breach or setting a habit. */
export function PunishmentPicker({householdId,language,onPick}:{householdId:string;language:string;onPick:(item:ShopItem)=>void}){
 const t=createTranslator(language),{data}=useShop(householdId,0),items=(data?.items??[]).filter(i=>i.kind==='consequence');
 if(!items.length)return null;
 return <fieldset className="picker"><legend>{t('shop.fromList')}</legend><div className="chips">{items.map(item=><button type="button" key={item.itemId} onClick={()=>onPick(item)}>{item.title}</button>)}</div></fieldset>;
}
const stateKeys={requested:'shop.stateRequested',fulfilled:'shop.stateGranted',declined:'shop.stateDeclined',cancelled:'shop.stateCancelled',reversed:'shop.stateReversed',expired:'shop.stateExpired'} as const;
type Editor={item?:ShopItem;fields:ShopFields;listed:boolean;autoGrant:boolean;weeklyLimit:number|null};
export function ShopView({householdId,session,language,format,timeZone,isDom,onChanged}:{householdId:string;session:Session;language:string;format:string;timeZone:string;isDom:boolean;onChanged:()=>void}){
 const t=createTranslator(language),[reload,setReload]=useState(0),{data,failed}=useShop(householdId,reload),number=new Intl.NumberFormat(format);
 const [busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>(),[confirm,setConfirm]=useState<string>(),[editor,setEditor]=useState<Editor>();
 const operation=useRef<{key:string;id:string}|undefined>(undefined);
 async function run(action:string,body:Record<string,unknown>,done:MessageKey,module:'authority'|'catalog'='authority'){
  if(busy)return;setBusy(true);setError(undefined);setNotice(undefined);
  const key=module+action+JSON.stringify(body);if(operation.current?.key!==key)operation.current={key,id:crypto.randomUUID()};
  try{
   let ok:boolean,failure:MessageKey='authority.unavailable',unknown=false;
   if(module==='authority'){const r=await authoritySend(householdId,session,action,{operationId:operation.current.id,...body});ok=r.ok;if(!r.ok){failure=action==='shopBuy'&&r.key==='authority.capacity'?'shop.limitReached':action==='shopBuy'&&r.key==='authority.conflict'?'shop.changed':r.key;unknown=r.unknown;}}
   else{
    const r=await fetch(`/api/households/${householdId}/catalog/${action}`,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId:operation.current.id,...body})}).catch(()=>undefined);
    ok=!!r?.ok;unknown=!r||r.status>=500;if(!ok)failure=unknown?'authority.unknown':'shop.changed';
   }
   if(ok){operation.current=undefined;setConfirm(undefined);setEditor(undefined);setNotice(done);setReload(v=>v+1);onChanged();}
   else{setError(failure);if(!unknown)operation.current=undefined;}
  }finally{setBusy(false);}
 }
 if(failed)return <p role="alert">{t('authority.unavailable')}</p>;
 if(!data)return <Skeleton count={3} label={t('workspace.loading')}/>;
 const offers=data.offers??[],mine=data.items??[],requests=data.requests??[],purchases=data.purchases??[],balance=Number(data.balance??'0');
 const rewards=mine.filter(i=>i.kind==='reward'),punishments=mine.filter(i=>i.kind==='consequence');
 const blocked=(offer:ShopOffer)=>!data.canSpend?'shop.spendingOff':offer.points>balance?'shop.notEnough':offer.weeklyLimit!==null&&offer.usedThisWeek>=offer.weeklyLimit?'shop.limitReached':undefined;
 const open=(item?:ShopItem,kind:ShopFields['kind']='reward')=>setEditor(item?{item,fields:{kind:item.kind,title:item.title,description:item.description,points:item.points},listed:item.listed,autoGrant:item.autoGrant,weeklyLimit:item.weeklyLimit}
  :{fields:{kind,title:'',description:'',points:kind==='reward'?10:0},listed:kind==='reward',autoGrant:false,weeklyLimit:null});
 const status=<>{error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}</>;
 return <section className="plain">
  {!editor&&status}
  {(offers.length>0||purchases.length>0||!isDom)&&<>
   <h3>{t('shop.spend')}</h3>
   <p className="muted">{t('authority.balance')} <strong>{number.format(balance)}</strong></p>
   {!data.canSpend&&<p className="muted">{t('shop.spendingOff')}</p>}
   <ul className="card-list">{offers.map(offer=>{const reason=blocked(offer);return <li key={offer.itemId} className="shop-row">
    <span className="grow"><span className="row-title">{offer.title}</span>
     <span className="muted">{[t('shop.cost',{points:number.format(offer.points)}),offer.holderName,offer.weeklyLimit!==null&&t('shop.limitUsed',{used:String(offer.usedThisWeek),limit:String(offer.weeklyLimit)}),offer.autoGrant&&t('shop.instant')].filter(Boolean).join(t('catalog.separator'))}</span>
     {offer.description&&<span className="muted">{offer.description}</span>}
     {reason&&data.canSpend&&<span className="muted">{t(reason)}</span>}</span>
    {confirm===offer.itemId?<span className="row-actions"><button type="button" disabled={busy} onClick={()=>{void run('shopBuy',{itemId:offer.itemId,version:offer.version},offer.autoGrant?'shop.bought':'shop.requested');}}>{t('shop.confirmBuy')}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm(undefined)}>{t('onboarding.cancel')}</button></span>
     :<button type="button" disabled={busy||!!reason} onClick={()=>setConfirm(offer.itemId)}>{t('shop.buy')}</button>}
   </li>;})}</ul>
   {!offers.length&&<p className="muted">{t('shop.noOffers')}</p>}
   {purchases.length>0&&<><h4>{t('shop.yourPurchases')}</h4><ul className="card-list">{purchases.map(p=><li key={p.redemptionId} className="shop-row"><span className="grow"><span>{p.title}</span><span className="muted">{[t(stateKeys[p.state]),t('shop.cost',{points:number.format(p.points)})].join(t('catalog.separator'))}{t('catalog.separator')}<time dateTime={p.createdAt}>{formatTime(new Date(p.createdAt),format,timeZone)}</time></span></span>
    {p.state==='requested'&&<button type="button" className="secondary" disabled={busy} onClick={()=>{void run('redemptionCancel',{redemptionId:p.redemptionId,version:p.version},'shop.cancelled','catalog');}}>{t('shop.cancel')}</button>}</li>)}</ul></>}
  </>}
  {requests.length>0&&<><h3>{t('shop.toGrant')}</h3><ul className="card-list">{requests.map(r=><li key={r.redemptionId} className="shop-row">
   <span className="grow"><span className="row-title">{r.title}</span><span className="muted">{[r.buyerName||t('partner.unnamed'),t('shop.cost',{points:number.format(r.points)})].join(t('catalog.separator'))}</span></span>
   <span className="row-actions"><button type="button" disabled={busy} onClick={()=>{void run('redemptionFulfill',{redemptionId:r.redemptionId,version:r.version},'shop.granted','catalog');}}>{t('shop.grant')}</button>
    <button type="button" className="secondary" disabled={busy} onClick={()=>{void run('redemptionDecline',{redemptionId:r.redemptionId,version:r.version},'shop.declined','catalog');}}>{t('shop.decline')}</button></span>
  </li>)}</ul></>}
  {(isDom||mine.length>0)&&<>
   <h3>{t('shop.yourRewards')}</h3><Hint label={t('hint.more')}>{t('shop.rewardsHelp')}</Hint>
   {data.pointsEnabled===false&&<p className="muted">{t('workspace.pointsDisabled')}</p>}
   <ItemList items={rewards} language={language} format={format} onOpen={item=>open(item)}/>
   <button type="button" className="secondary" disabled={busy} onClick={()=>open(undefined,'reward')}>{t('shop.addReward')}</button>
   <h3>{t('shop.yourPunishments')}</h3><Hint label={t('hint.more')}>{t('shop.punishmentsHelp')}</Hint>
   <ItemList items={punishments} language={language} format={format} onOpen={item=>open(item)}/>
   <button type="button" className="secondary" disabled={busy} onClick={()=>open(undefined,'consequence')}>{t('shop.addPunishment')}</button>
  </>}
  {editor&&<Layer title={t(editor.fields.kind==='reward'?(editor.item?'shop.editReward':'shop.addReward'):(editor.item?'shop.editPunishment':'shop.addPunishment'))} backLabel={t('nav.back')} onClose={()=>setEditor(undefined)} status={status}>
   <form className="quick-form" onSubmit={e=>{e.preventDefault();const f=editor.fields;void run('shopSave',{itemId:editor.item?.itemId??null,version:editor.item?.version??null,
     fields:{...f,title:f.title.trim(),description:f.description.trim()},listed:f.kind==='reward'&&editor.listed,autoGrant:f.kind==='reward'&&editor.listed&&editor.autoGrant,weeklyLimit:f.kind==='reward'&&editor.listed?editor.weeklyLimit:null},'authority.saved');}}>
    <label>{t('library.title')}<input required maxLength={120} autoComplete="off" disabled={busy} value={editor.fields.title} onChange={e=>setEditor({...editor,fields:{...editor.fields,title:e.target.value}})}/></label>
    <label>{t('library.body')}<textarea maxLength={500} disabled={busy} value={editor.fields.description} onChange={e=>setEditor({...editor,fields:{...editor.fields,description:e.target.value}})}/></label>
    {editor.fields.kind==='reward'&&<>
     <label>{t('shop.price')}<input type="number" inputMode="numeric" min={0} max={10000} required disabled={busy} value={editor.fields.points} onChange={e=>setEditor({...editor,fields:{...editor.fields,points:Number(e.target.value)}})}/></label>
     <label className="check"><input type="checkbox" disabled={busy} checked={editor.listed} onChange={e=>setEditor({...editor,listed:e.target.checked})}/>{t('shop.listed')}</label>
     {editor.listed&&<>
      <label className="check"><input type="checkbox" disabled={busy} checked={editor.autoGrant} onChange={e=>setEditor({...editor,autoGrant:e.target.checked})}/>{t('shop.autoGrant')}</label>
      <label>{t('shop.weeklyLimit')}<input type="number" inputMode="numeric" min={1} max={100} disabled={busy} value={editor.weeklyLimit??''} onChange={e=>setEditor({...editor,weeklyLimit:e.target.value===''?null:Number(e.target.value)})}/></label>
     </>}
    </>}
    <button type="submit" disabled={busy||!editor.fields.title.trim()||(editor.fields.kind==='reward'&&!(editor.fields.points>=0))}>{t('shop.save')}</button>
    {editor.item&&<button type="button" className="secondary" disabled={busy} onClick={()=>{if(editor.item)void run('shopArchive',{itemId:editor.item.itemId,version:editor.item.version},'shop.removed');}}>{t('shop.remove')}</button>}
   </form>
  </Layer>}
 </section>;
}
function ItemList({items,language,format,onOpen}:{items:ShopItem[];language:string;format:string;onOpen:(item:ShopItem)=>void}){
 const t=createTranslator(language),number=new Intl.NumberFormat(format);
 if(!items.length)return <p className="muted">{t('shop.none')}</p>;
 return <ul className="menu">{items.map(item=><li key={item.itemId}><button type="button" onClick={()=>onOpen(item)}><span className="grow"><span>{item.title}</span>
  {item.kind==='reward'&&<span className="muted">{[t('shop.cost',{points:number.format(item.points)}),t(item.listed?'shop.inShop':'shop.notInShop'),item.listed&&item.autoGrant&&t('shop.instant'),item.listed&&item.weeklyLimit!==null&&t('shop.perWeek',{limit:String(item.weeklyLimit)})].filter(Boolean).join(t('catalog.separator'))}</span>}
  {item.kind==='consequence'&&item.description&&<span className="muted">{item.description}</span>}</span></button></li>)}</ul>;
}
