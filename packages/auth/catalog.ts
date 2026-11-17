import {uuid} from './delegation.js';
import {documentText,documentVersion} from './library.js';
import type {CatalogAction} from './catalog-actions.js';
export {catalogActions,isCatalogAction,type CatalogAction} from './catalog-actions.js';
export type CatalogFields={title:string;description:string;category:string;points:number|null;position:number};
export type CatalogSummary=CatalogFields&{itemId:string;version:string;state:'draft'|'archived'};
export type CatalogDetail=CatalogSummary&{historical:boolean};
export type CatalogResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';itemId?:string;items?:CatalogSummary[];item?:CatalogDetail;nextCursor?:string|null};
export class CatalogError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'unavailable'){super('catalog.'+kind);}}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function catalogInput(action:CatalogAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(!object(value)||!uuid(value.operationId))throw new CatalogError('invalid');const keys=['operationId'];
 if(action==='catalogList')keys.push('filter',...('after'in value?['after']:[]));
 else if(action==='catalogCreate')keys.push('fields');
 else {keys.push('itemId');if(action!=='catalogRead'||'version'in value)keys.push('version');if(action==='catalogUpdate')keys.push('fields');}
 if(Object.keys(value).sort().join(',')!==keys.sort().join(',')||('itemId'in value&&!uuid(value.itemId))||('version'in value&&!documentVersion(value.version)))throw new CatalogError('invalid');
 if(action==='catalogList'&&(!(typeof value.filter==='string'&&['current','archived'].includes(value.filter))||('after'in value&&(typeof value.after!=='string'||!/^\d{1,6}:[a-f0-9-]{36}$/i.test(value.after)||!uuid(value.after.split(':')[1])))))throw new CatalogError('invalid');
 if('fields'in value){const f=value.fields;if(!object(f)||Object.keys(f).sort().join(',')!=='category,description,points,position,title'||!documentText(f.title,120)||!documentText(f.description,500,true,true)||!documentText(f.category,60,true)||!Number.isInteger(f.position)||Number(f.position)<0||Number(f.position)>999999||(f.points!==null&&(!Number.isInteger(f.points)||Number(f.points)<0||Number(f.points)>1000000)))throw new CatalogError('invalid');}
 return {...value,operationId:value.operationId.toLowerCase(),...('itemId'in value?{itemId:(value.itemId as string).toLowerCase()}:{}),...('after'in value?{after:(value.after as string).toLowerCase()}: {})};
}
