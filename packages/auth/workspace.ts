import {containsDisguisedText} from './text.js';
import {validTaskSchedule,type TaskSchedule} from './partner.js';
import {uuid} from './delegation.js';
import type {WorkspaceAction} from './workspace-actions.js';
export {workspaceActions,isWorkspaceAction,type WorkspaceAction} from './workspace-actions.js';
export class WorkspaceError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'capacity'|'paused'|'horizon'|'unavailable'){super('workspace.'+kind);}}
export type TaskFields={title:string;description:string;priority:'low'|'normal'|'high';dueAt:string|null;assignment:'unassigned'|'self'};
export type TaskSummary=Omit<TaskFields,'description'>&{taskId:string;version:string;state:'open'|'done'|'archived'};
export type TaskDetail=TaskSummary&{description:string};
export type PointsSettings={enabled:boolean;label:string|null};
export type PersonalSeries={seriesId:string;version:string;state:'active'|'blocked'|'finished'|'stopped';fields:TaskFields;schedule:TaskSchedule};
export const plannerKinds=['task','taskSeries','partnerTask','partnerSeries','habit','routineHabit','ritual','checkin','session'] as const;
export type PlannerKind=typeof plannerKinds[number];
/** One dated entry. `projected`: a future occurrence that does not exist yet; `onBreak`: a planned habit break. */
export type PlannerItem={kind:PlannerKind;id:string;day:string;at:string|null;title:string;state:string;overdue:boolean;projected:boolean;onBreak:boolean;hidden:boolean;
 /** Duration in minutes; only play sessions have one. */
 minutes?:number};
/** Play sessions (docs/PLAY_SESSIONS.md): a private note in one's own calendar, optionally shared with linked members. */
export type PlaySessionFields={title:string;startsAt:string;durationMinutes:number;location:string;withWhom:string};
export type PlaySessionMember={membershipId:string;name:string;canEdit:boolean;preparation:string;aftercare:string};
export type PlaySession=PlaySessionFields&{sessionId:string;version:string;access:'owner'|'edit'|'view';ownerName:string;preparation:string;aftercare:string;members:PlaySessionMember[];hidden:boolean};
export const sessionNoteMax=2000;
/** What `calendarMark` names: routines (habit, ritual, check-in) share one kind. */
export const calendarMarkKinds=['task','taskSeries','partnerTask','partnerSeries','habit','routine','session'] as const;
export type CalendarMarkKind=typeof calendarMarkKinds[number];
export const calendarMarkKind=(kind:PlannerKind):CalendarMarkKind=>kind==='routineHabit'||kind==='ritual'||kind==='checkin'?'routine':kind;
export type Planner={from:string;days:number;timeZone:string;personId:string;people:{id:string;name:string;self:boolean}[];items:PlannerItem[]};
export const plannerMaxDays=42;
const calendarDay=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
export function validTimeZone(v:unknown):v is string{
 if(typeof v!=='string'||v.length>100||!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(v))return false;
 try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}
}
export {calendarDay as validCalendarDay};
/** The Plan panel: the caller's own use (per-person limits) or the dynamic's use, with the limit. */
export type PlanUsage=Record<string,{used:number;limit:number}>;
/** Items paused by the plan that the caller may choose for, grouped by kind and person. */
export const planFreezeKinds=['series','habit','routine','shop'] as const;
export type PlanFreezeKind=typeof planFreezeKinds[number];
export type PlanFrozenGroup={kind:PlanFreezeKind;personId:string|null;personName:string|null;limit:number;items:{id:string;title:string;frozen:boolean}[]};
export type WorkspaceResult={session?:PlaySession;sessionId?:string;planner?:Planner;usage?:PlanUsage;frozen?:PlanFrozenGroup[];householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';taskId?:string;task?:TaskDetail;
 household?:{name:string;timeZone:string;version:string;canEdit:boolean;status:'active'|'paused';epoch:string;memberEpoch:string;selfPaused:boolean;memberCount:number};
 series?:PersonalSeries[];pointsSettings?:PointsSettings;hasUnreadTaskInbox?:boolean;changeCursor?:string;changed?:('workspace'|'tasks'|'notices'|'routines'|'library'|'dynamic'|'catalog')[];counts?:{open:number;done:number;overdue:number;unassigned:number};tasks?:TaskSummary[];nextCursor?:string|null};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const version=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]{0,14}$/.test(v);
const text=(v:unknown,max:number,empty=false,multiline=false)=>typeof v==='string'&&(empty||v.length>0)&&[...v].length<=max&&v===v.trim()&&!(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u:/[\u0000-\u001f\u007f\uD800-\uDFFF]/u).test(v);
export function validPointsSettings(value:unknown):value is PointsSettings{
 return record(value)&&Object.keys(value).sort().join(',')==='enabled,label'&&typeof value.enabled==='boolean'
  &&(value.label===null||text(value.label,32));
}
/** A session's basics and linked members (notes are saved one at a time with sessionNote). */
export function validPlaySessionFields(f:unknown):f is PlaySessionFields{
 return record(f)&&Object.keys(f).sort().join(',')==='durationMinutes,location,startsAt,title,withWhom'&&text(f.title,120)
  &&typeof f.startsAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(f.startsAt)&&Number.isFinite(Date.parse(f.startsAt))
  &&Number.isInteger(f.durationMinutes)&&Number(f.durationMinutes)>=5&&Number(f.durationMinutes)<=1440&&text(f.location,200,true)&&text(f.withWhom,300,true);
}
function validSessionSave(v:Record<string,unknown>):boolean{
 const create=v.sessionId===null;
 if(create?v.version!==null:!uuid(v.sessionId)||!version(v.version))return false;
 if(!validPlaySessionFields(v.fields)||!Array.isArray(v.members)||v.members.length>20)return false;
 const ids=new Set<string>();
 for(const x of v.members){if(!record(x)||Object.keys(x).sort().join(',')!=='canEdit,membershipId'||!uuid(x.membershipId)||typeof x.canEdit!=='boolean'||ids.has(String(x.membershipId)))return false;ids.add(String(x.membershipId));}
 return true;
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
 if(action==='plannerRead')names.push('from','days','personId','timeZone');
 if(action==='calendarMark')names.push('kind','resourceId','hidden');
 if(action==='planSwap')names.push('kind','activateId','freezeId');
 if(action==='plannerMove')names.push('kind','itemId','day','timeZone');
 if(action==='sessionRead'||action==='sessionDelete')names.push('sessionId');
 if(action==='sessionSave')names.push('sessionId','version','fields','members');
 if(action==='sessionNote')names.push('sessionId','section','text');
 if(['taskUpdate','taskComplete','taskArchive','taskReopen'].includes(action))names.push('taskId','version');
 if(action==='taskCreate'||action==='taskUpdate')names.push('fields','epoch','memberEpoch');
 if(action==='taskComplete')names.push('epoch','memberEpoch');
 if(Object.keys(value).sort().join(',')!==names.sort().join(',')||['taskId','after','seriesId'].some(k=>k in value&&!uuid(value[k]))||['version','epoch','memberEpoch'].some(k=>k in value&&!(action==='sessionSave'&&k==='version')&&!version(value[k])))throw new WorkspaceError('invalid');
 if(action==='workspaceChanges'&&value.cursor!==null&&!uuid(value.cursor))throw new WorkspaceError('invalid');
 if(action==='sessionSave'&&!validSessionSave(value))throw new WorkspaceError('invalid');
 if((action==='sessionRead'||action==='sessionDelete'||action==='sessionNote')&&!uuid(value.sessionId))throw new WorkspaceError('invalid');
 if(action==='sessionNote'&&(!['preparation','aftercare'].includes(String(value.section))||!text(value.text,sessionNoteMax,true,true)||Buffer.byteLength(String(value.text))>3500))throw new WorkspaceError('invalid');
 if(action==='plannerMove'&&(!['task','partnerTask','session'].includes(String(value.kind))||!uuid(value.itemId)||!calendarDay(value.day)||!validTimeZone(value.timeZone)))throw new WorkspaceError('invalid');
 if(action==='planSwap'&&(!(planFreezeKinds as readonly string[]).includes(String(value.kind))||!uuid(value.activateId)||!uuid(value.freezeId)||value.activateId===value.freezeId))throw new WorkspaceError('invalid');
 if(action==='calendarMark'&&(!(calendarMarkKinds as readonly string[]).includes(String(value.kind))||!uuid(value.resourceId)||typeof value.hidden!=='boolean'))throw new WorkspaceError('invalid');
 if(action==='plannerRead'&&(!calendarDay(value.from)||!Number.isInteger(value.days)||Number(value.days)<1||Number(value.days)>plannerMaxDays||(value.personId!==null&&!uuid(value.personId))||!validTimeZone(value.timeZone)))throw new WorkspaceError('invalid');
 if(action==='workspaceRead'&&!['open','done','archived'].includes(String(value.filter)))throw new WorkspaceError('invalid');
 if(action==='personalSeriesSave'&&(!validTaskSchedule(value.schedule)||!record(value.fields)||
  value.fields.assignment!=='self'||value.fields.dueAt!==null))throw new WorkspaceError('invalid');
 if(action==='pointsConfigure'&&!validPointsSettings(value.pointsSettings))throw new WorkspaceError('invalid');
 if(action==='settingsUpdate'){
  if(!text(value.name,120)||typeof value.timeZone!=='string'||value.timeZone.length>100||!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value.timeZone))throw new WorkspaceError('invalid');
  try{new Intl.DateTimeFormat('en',{timeZone:value.timeZone});}catch{throw new WorkspaceError('invalid');}
 }
 if('fields'in value&&action!=='sessionSave'){const f=value.fields;
  if(!record(f)||Object.keys(f).sort().join(',')!=='assignment,description,dueAt,priority,title'||!text(f.title,120)||!text(f.description,1000,true,true)||!['low','normal','high'].includes(String(f.priority))||!['self','unassigned'].includes(String(f.assignment))||
   (f.dueAt!==null&&(typeof f.dueAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(f.dueAt)||(!Number.isFinite(Date.parse(f.dueAt))||new Date(f.dueAt).toISOString()!==(f.dueAt.includes('.')?f.dueAt:f.dueAt.replace('Z','.000Z'))))))throw new WorkspaceError('invalid');
 }
 return value as Record<string,unknown>&{operationId:string};
}
