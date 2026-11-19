import {useEffect,useState} from 'react';

const interval=60000;
const groupSize=8;

/** Ask for an unread summary only for currently listed, authorized households. */
export function useSelectorInbox(accountId:string|undefined,householdIds:string){
 const [result,setResult]=useState<{accountId:string;ids:string;unread:Set<string>;partial:boolean}>();
 useEffect(()=>{
  if(!accountId||!householdIds)return;
  const ids=householdIds.split(',');
  const currentAccount=accountId;
  let position=0,dead=false,terminal=false,active:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  let retryAt=0,errors=0;
  const schedule=(delay:number)=>{timer=setTimeout(()=>void load(),delay);};
  const suspend=()=>{
   clearTimeout(timer);
   const controller=active;
   active=undefined;
   controller?.abort();
  };
  async function load(){
   if(dead||terminal||active||document.hidden||!navigator.onLine)return;
   if(retryAt>Date.now()){schedule(retryAt-Date.now());return;}
   const group=ids.slice(position,position+groupSize);
   const controller=new AbortController();
   active=controller;
   const deadline=setTimeout(()=>controller.abort(),12000);
   function save(unread:string[],partial:boolean){
    setResult(previous=>{
     const set=new Set(previous&&previous.accountId===currentAccount&&previous.ids===householdIds?previous.unread:[]);
     for(const id of group)set.delete(id);
     for(const id of unread)if(group.includes(id))set.add(id);
     return {accountId:currentAccount,ids:householdIds,unread:set,partial};
    });
   }
   try{
    const response=await fetch('/api/account/task-inbox?households='+encodeURIComponent(group.join(',')),{cache:'no-store',signal:controller.signal});
    if(active!==controller)return;
    if(response.status===401){terminal=true;setResult(undefined);return;}
    if(response.status===429){
     const header=response.headers.get('Retry-After')??'';
     retryAt=Date.now()+Math.max(interval,/^\d+$/.test(header)?Math.min(Number(header)*1000,3600000):interval);
    }
    if(!response.ok)throw Error('inbox.selector');
    const data=await response.json() as {unread:string[];partial:boolean};
    if(active!==controller)return;
    if(!Array.isArray(data.unread)||typeof data.partial!=='boolean')throw Error('inbox.selector');
    errors=0;
    save(data.unread,data.partial);
    position=(position+groupSize>=ids.length)?0:position+groupSize;
   }catch{
    if(active===controller){
     errors=Math.min(errors+1,3);
     retryAt=Math.max(retryAt,Date.now()+interval*2**(errors-1));
     save([],true);
    }
   }finally{
    clearTimeout(deadline);
    if(active===controller){
     active=undefined;
     if(!terminal)schedule(Math.max(interval,retryAt-Date.now()));
    }
   }
  }
  function resume(){
   if(document.hidden||!navigator.onLine){suspend();return;}
   clearTimeout(timer);
   void load();
  }
  schedule(Math.floor(Math.random()*1000));
  document.addEventListener('visibilitychange',resume);
  window.addEventListener('online',resume);
  window.addEventListener('offline',resume);
  return()=>{
   dead=true;suspend();
   document.removeEventListener('visibilitychange',resume);
   window.removeEventListener('online',resume);
   window.removeEventListener('offline',resume);
  };
 },[accountId,householdIds]);
 return result?.accountId===accountId&&result?.ids===householdIds?result:undefined;
}
