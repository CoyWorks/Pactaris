import {containsDisguisedText} from './text.js';
import {validTaskSchedule,type TaskSchedule} from './partner.js';
import {uuid} from './delegation.js';
import type {WorkspaceAction} from './workspace-actions.js';
export {workspaceActions,isWorkspaceAction,type WorkspaceAction} from './workspace-actions.js';
export class WorkspaceError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'capacity'|'paused'|'unavailable'){super('workspace.'+kind);}}
export type TaskFields={title:string;description:string;priority:'low'|'normal'|'high';dueAt:string|null;assignment:'unassigned'|'self'};
export type TaskSummary=Omit<TaskFields,'description'>&{taskId:string;version:string;state:'open'|'done'|'archived'};
export type TaskDetail=TaskSummary&{description:string};
export type PointsSettings={enabled:boolean;label:string|null};
export type PersonalSeries={seriesId:string;version:string;state:'active'|'blocked'|'finished'|'stopped';fields:TaskFields;schedule:TaskSchedule};
export type WorkspaceResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';taskId?:string;task?:TaskDetail;
 household?:{name:string;timeZone:string;version:string;canEdit:boolean;status:'active'|'paused';epoch:string;memberEpoch:string;selfPaused:boolean;memberCount:number};
 series?:PersonalSeries[];pointsSettings?:PointsSettings;hasUnreadTaskInbox?:boolean;changeCursor?:string;changed?:('workspace'|'tasks'|'notices')[];counts?:{open:number;done:number;overdue:number;unassigned:number};tasks?:TaskSummary[];nextCursor?:string|null};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const version=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]{0,14}$/.test(v);
const text=(v:unknown,max:number,empty=false,multiline=false)=>typeof v==='string'&&(empty||v.length>0)&&[...v].length<=max&&v===v.trim()&&!(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u:/[\u0000-\u001f\u007f\uD800-\uDFFF]/u).test(v);
export function validPointsSettings(value:unknown):value is PointsSettings{
 return record(value)&&Object.keys(value).sort().join(',')==='enabled,label'&&typeof value.enabled==='boolean'
  &&(value.label===null||text(value.label,32));
}
export function workspaceInput(action:WorkspaceAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(containsDisguisedText(value))throw new WorkspaceError('invalid');
 if(!record(value)||!uuid(value.operationId))throw new WorkspaceError('invalid');
 const names=['operationId'];
 if(action==='workspaceChanges')names.push('cursor');
 if(action==='workspaceRead')names.push('filter',...('after'in value?['after']:[]));
 if(action==='personalSeriesList'&&'after'in value)names.push('after');
 if(action==='personalSeriesSave'){
  names.push('fields','schedule','epoch','memberEpoch');
  if('seriesId'in value)names.push('seriesId','version');
 }
 if(action==='personalSeriesStop')names.push('seriesId','version');
 if(action==='pointsConfigure')names.push('pointsSettings','version');
 if(action==='settingsUpdate')names.push('name','timeZone','version');
 if(action==='taskRead')names.push('taskId');
 if(['taskUpdate','taskComplete','taskArchive','taskReopen'].includes(action))names.push('taskId','version');
 if(action==='taskCreate'||action==='taskUpdate')names.push('fields','epoch','memberEpoch');
 if(action==='taskComplete')names.push('epoch','memberEpoch');
 if(Object.keys(value).sort().join(',')!==names.sort().join(',')||['taskId','after','seriesId'].some(k=>k in value&&!uuid(value[k]))||['version','epoch','memberEpoch'].some(k=>k in value&&!version(value[k])))throw new WorkspaceError('invalid');
 if(action==='workspaceChanges'&&value.cursor!==null&&!uuid(value.cursor))throw new WorkspaceError('invalid');
 if(action==='workspaceRead'&&!['open','done','archived'].includes(String(value.filter)))throw new WorkspaceError('invalid');
 if(action==='personalSeriesSave'&&(!validTaskSchedule(value.schedule)||!record(value.fields)||
  value.fields.assignment!=='self'||value.fields.dueAt!==null))throw new WorkspaceError('invalid');
 if(action==='pointsConfigure'&&!validPointsSettings(value.pointsSettings))throw new WorkspaceError('invalid');
 if(action==='settingsUpdate'){
  if(!text(value.name,120)||typeof value.timeZone!=='string'||value.timeZone.length>100||!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value.timeZone))throw new WorkspaceError('invalid');
  try{new Intl.DateTimeFormat('en',{timeZone:value.timeZone});}catch{throw new WorkspaceError('invalid');}
 }
 if('fields'in value){const f=value.fields;
  if(!record(f)||Object.keys(f).sort().join(',')!=='assignment,description,dueAt,priority,title'||!text(f.title,120)||!text(f.description,1000,true,true)||!['low','normal','high'].includes(String(f.priority))||!['self','unassigned'].includes(String(f.assignment))||
   (f.dueAt!==null&&(typeof f.dueAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(f.dueAt)||(!Number.isFinite(Date.parse(f.dueAt))||new Date(f.dueAt).toISOString()!==(f.dueAt.includes('.')?f.dueAt:f.dueAt.replace('Z','.000Z'))))))throw new WorkspaceError('invalid');
 }
 return value as Record<string,unknown>&{operationId:string};
}
