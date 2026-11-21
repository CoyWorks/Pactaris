import React,{useEffect,useRef,useState} from 'react';
const event='pactaris:navigate';
/** Moves within the single-page app without a full reload. */
export function navigate(to:string,replace=false){
 if(to===window.location.pathname+window.location.search)return;
 if(replace)window.history.replaceState(null,'',to);else window.history.pushState(null,'',to);
 window.dispatchEvent(new Event(event));
 if(!replace)window.scrollTo(0,0);
}
export function useLocation(){
 const read=()=>typeof window==='undefined'?{path:'/',search:''}:{path:window.location.pathname,search:window.location.search};
 const [location,setLocation]=useState(read);
 useEffect(()=>{
  const update=()=>setLocation(read());
  window.addEventListener('popstate',update);window.addEventListener(event,update);
  return()=>{window.removeEventListener('popstate',update);window.removeEventListener(event,update);};
 },[]);
 return location;
}
/** A real link that keeps in-app navigation for ordinary clicks. */
export function Link({to,children,...rest}:{to:string;children:React.ReactNode}&Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>,'href'>){
 return <a {...rest} href={to} onClick={e=>{
  rest.onClick?.(e);
  if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
  e.preventDefault();navigate(to);
 }}>{children}</a>;
}
/** Short help that stays out of the way until asked for. */
/** Success notices ("the server confirmed…") clear themselves after a few seconds so they do not linger
 *  into the next screen. Notices that need action, such as an unknown outcome, stay. */
export function useFleetingNotice(notice:string|undefined,clear:()=>void,ms=5000){
 useEffect(()=>{
  if(!notice||!/\.(confirmed|saved)$/.test(notice))return;
  const timer=setTimeout(clear,ms);return()=>clearTimeout(timer);
 },[notice]);// eslint-disable-line react-hooks/exhaustive-deps
}
export function Hint({label,children}:{label:string;children:React.ReactNode}){
 return <details className="hint"><summary>{label}</summary><p>{children}</p></details>;
}
/** Bottom sheet for short choices; Escape and the backdrop close it. */
export function Sheet({title,closeLabel,onClose,children}:{title:string;closeLabel:string;onClose:()=>void;children:React.ReactNode}){
 const box=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};
  window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
 },[onClose]);
 // Move focus into the sheet on open and give it back to the opener on close.
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null;
  const first=box.current?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea,.sheet-body button,a[href]');
  (first??box.current)?.focus();
  return()=>{previous?.focus?.();};
 },[]);
 return <div className="sheet-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
  <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={box} tabIndex={-1}>
   <div className="sheet-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label={closeLabel} onClick={onClose}><Icon name="close"/></button></div>
   {children}
  </div>
 </div>;
}
const paths={
 today:<><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
 tasks:<><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/></>,
 routines:<><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></>,
 library:<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6.5A2.5 2.5 0 0 0 4 21.5z"/>,
 dynamic:<><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M15 14.5c2.8 0 5 2.2 5 5"/></>,
 shield:<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>,
 plus:<path d="M12 5v14M5 12h14"/>,
 close:<path d="M6 6l12 12M18 6L6 18"/>,
 back:<path d="M15 6l-6 6 6 6"/>,
 chevron:<path d="M9 6l6 6-6 6"/>,
 check:<path d="M5 12l5 5 9-10"/>,
 bell:<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></>,
 down:<path d="M6 9l6 6 6-6"/>,
 logout:<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></>,
};
export type IconName=keyof typeof paths;
export function Icon({name}:{name:IconName}){
 return <svg className="icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
// Open layers, newest last: Escape closes only the top one.
const layers:(()=>void)[]=[];
if(typeof window!=='undefined')window.addEventListener('keydown',e=>{if(e.key==='Escape'&&layers.length)layers[layers.length-1]!();});
/** Full-screen detail or form page above a section; Back and Escape close it. */
export function Layer({title,backLabel,onClose,status,children}:{title:string;backLabel:string;onClose:()=>void;status?:React.ReactNode;children:React.ReactNode}){
 const close=useRef(onClose);close.current=onClose;
 const heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null,entry=()=>close.current();
  layers.push(entry);document.body.classList.add('layer-open');heading.current?.focus();
  return()=>{layers.splice(layers.indexOf(entry),1);if(!layers.length)document.body.classList.remove('layer-open');previous?.focus?.();};
 },[]);
 return <div className="layer" role="dialog" aria-modal="true" aria-label={title}>
  <div className="layer-bar"><button type="button" className="icon-button" aria-label={backLabel} onClick={()=>close.current()}><Icon name="back"/></button><h2 ref={heading} tabIndex={-1}>{title}</h2></div>
  <div className="layer-body">{status}{children}</div>
 </div>;
}
