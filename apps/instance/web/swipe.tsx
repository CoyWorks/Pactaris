import React,{useCallback,useEffect,useRef,useState} from 'react';
const threshold=88;
/** A list row that can be swiped right or left. Every swipe action also has a visible button elsewhere. */
export function SwipeRow({onRight,onLeft,rightLabel,leftLabel,className,children}:{onRight?:()=>void;onLeft?:()=>void;rightLabel?:string;leftLabel?:string;className?:string;children:React.ReactNode}){
 const [offset,setOffset]=useState(0),start=useRef<{x:number;y:number;id:number}|undefined>(undefined),swiping=useRef(false),moved=useRef(false);
 const limit=(dx:number)=>Math.max(onLeft?-140:0,Math.min(onRight?140:0,dx));
 return <li className={'swipe-row'+(className?' '+className:'')} data-direction={offset>0?'right':offset<0?'left':undefined}>
  {rightLabel&&onRight&&<span className="swipe-hint right" aria-hidden="true">{rightLabel}</span>}
  {leftLabel&&onLeft&&<span className="swipe-hint left" aria-hidden="true">{leftLabel}</span>}
  <div className="swipe-content" style={{transform:offset?`translateX(${offset}px)`:undefined,transition:start.current?'none':undefined}}
   onPointerDown={e=>{if(e.pointerType==='mouse'&&e.button!==0)return;start.current={x:e.clientX,y:e.clientY,id:e.pointerId};swiping.current=false;moved.current=false;}}
   onPointerMove={e=>{
    const s=start.current;if(!s||s.id!==e.pointerId)return;const dx=e.clientX-s.x,dy=e.clientY-s.y;
    if(!swiping.current){if(Math.abs(dy)>12&&Math.abs(dy)>Math.abs(dx)){start.current=undefined;return;}if(Math.abs(dx)<12)return;swiping.current=true;moved.current=true;e.currentTarget.setPointerCapture(e.pointerId);}
    setOffset(limit(dx));
   }}
   onPointerUp={()=>{const value=offset;start.current=undefined;swiping.current=false;setOffset(0);if(value>=threshold)onRight?.();else if(value<=-threshold)onLeft?.();}}
   onPointerCancel={()=>{start.current=undefined;swiping.current=false;setOffset(0);}}
   onClickCapture={e=>{if(moved.current){e.preventDefault();e.stopPropagation();moved.current=false;}}}>
   {children}
  </div>
 </li>;
}
type Pending={id:string;message:string;run:()=>void};
/** Delays an action a few seconds so it can be undone; it runs immediately when the page is hidden or left. */
export function useUndoable(delay=5000){
 const [pending,setPending]=useState<Pending>(),current=useRef<Pending|undefined>(undefined),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const flush=useCallback(()=>{
  if(timer.current)clearTimeout(timer.current);timer.current=undefined;
  const action=current.current;current.current=undefined;setPending(undefined);action?.run();
 },[]);
 const schedule=useCallback((next:Pending)=>{flush();current.current=next;setPending(next);timer.current=setTimeout(flush,delay);},[delay,flush]);
 const undo=useCallback(()=>{if(timer.current)clearTimeout(timer.current);timer.current=undefined;current.current=undefined;setPending(undefined);},[]);
 useEffect(()=>{
  const hidden=()=>{if(document.hidden)flush();};
  document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',flush);
  return()=>{document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',flush);flush();};
 },[flush]);
 return {pending,schedule,undo};
}
export function UndoToast({message,undoLabel,onUndo}:{message:string;undoLabel:string;onUndo:()=>void}){
 return <div className="toast" role="status"><span>{message}</span><button type="button" className="link-button" onClick={onUndo}>{undoLabel}</button></div>;
}
