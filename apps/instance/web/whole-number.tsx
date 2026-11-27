import React,{useEffect,useState} from 'react';

/** A whole-number field that can be cleared and retyped. The parent only receives values within
 *  [min,max]; the form's own required/min/max check stops a submit while the field is empty or out of
 *  range, and leaving the field puts the value back within bounds. */
export function WholeNumber({value,onChange,min,max,disabled,required=true,label}:{value:number;onChange:(n:number)=>void;min:number;max:number;disabled?:boolean;required?:boolean;label?:string}){
 const [text,setText]=useState(String(value));
 useEffect(()=>{setText(current=>Number(current)===value&&current!==''?current:String(value));},[value]);
 const valid=(n:number)=>Number.isInteger(n)&&n>=min&&n<=max;
 return <input type="number" inputMode="numeric" step={1} min={min} max={max} required={required} disabled={disabled} value={text} aria-label={label}
  onChange={e=>{const next=e.target.value.replace(/[^0-9]/g,'').slice(0,String(max).length);setText(next);const n=Number(next);if(next!==''&&valid(n))onChange(n);}}
  onBlur={()=>{const n=Math.round(Number(text)),fixed=text===''||!Number.isFinite(n)?value:Math.max(min,Math.min(max,n));setText(String(fixed));if(fixed!==value)onChange(fixed);}}/>;
}
