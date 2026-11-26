// Private calendar subscriptions (docs/CALENDAR_FEED.md). A feed is a secret URL for one account and
// one dynamic; it shows that account's own planner as an ICS calendar. Titles marked hidden appear as
// "Pactaris". Nothing else (descriptions, other people, states) leaves Pactaris.
import {randomBytes} from 'node:crypto';
import type pg from 'pg';
import {hash} from './store.js';
import type {PlannerItem} from '../../packages/auth/workspace.js';

export const feedTokenValid=(value:string)=>/^[A-Za-z0-9_-]{43}$/.test(value);
export type FeedStatus={active:boolean;createdAt:string|null;lastUsedAt:string|null};

export class CalendarFeeds{
 constructor(private pool:pg.Pool){}
 async status(accountId:string,householdId:string):Promise<FeedStatus>{
  const r=await this.pool.query('SELECT created_at,last_used_at FROM pactaris.calendar_feeds WHERE account_id=$1 AND household_id=$2',[accountId,householdId]);
  const row=r.rows[0];return {active:!!row,createdAt:row?.created_at?.toISOString()??null,lastUsedAt:row?.last_used_at?.toISOString()??null};
 }
 /** Creates the feed or replaces its secret; the previous link stops working at once. */
 async issue(accountId:string,householdId:string):Promise<string>{
  const token=randomBytes(32).toString('base64url');
  await this.pool.query(`INSERT INTO pactaris.calendar_feeds(account_id,household_id,token_hash) VALUES($1,$2,$3)
   ON CONFLICT(account_id,household_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,created_at=now(),last_used_at=NULL`,[accountId,householdId,hash(token)]);
  return token;
 }
 async revoke(accountId:string,householdId:string){
  await this.pool.query('DELETE FROM pactaris.calendar_feeds WHERE account_id=$1 AND household_id=$2',[accountId,householdId]);
 }
 /** The account behind a link, if the link is current and the account active. */
 async resolve(token:string):Promise<{accountId:string;householdId:string;timeZone:string}|undefined>{
  if(!feedTokenValid(token))return;
  const r=await this.pool.query(`UPDATE pactaris.calendar_feeds f SET last_used_at=now() FROM pactaris.accounts a
   WHERE f.token_hash=$1 AND a.id=f.account_id AND a.status='active' RETURNING f.account_id,f.household_id,a.time_zone`,[hash(token)]);
  const row=r.rows[0];return row?{accountId:row.account_id,householdId:row.household_id,timeZone:row.time_zone??'UTC'}:undefined;
 }
}

const escapeText=(value:string)=>value.replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
const stamp=(date:Date)=>date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
const ymd=(day:string)=>day.replace(/-/g,'');
const nextDay=(day:string)=>{const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);};
/** RFC 5545 line folding: at most 75 octets per line, continuation lines start with a space. */
function fold(line:string):string{
 const out:string[]=[];let current='',size=0;
 for(const char of line){
  const bytes=Buffer.byteLength(char);
  if(size+bytes>(out.length?74:75)){out.push(current);current='';size=0;}
  current+=char;size+=bytes;
 }
 out.push(current);return out.join('\r\n ');
}

/** Builds the calendar. Breaks are left out; each occurrence has a stable UID so clients update it in place. */
export function icsCalendar(items:PlannerItem[],householdId:string,appOrigin:string,hiddenTitle:string,now=new Date()):string{
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//CoyWorks//Pactaris//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',
  'X-WR-CALNAME:Pactaris','REFRESH-INTERVAL;VALUE=DURATION:PT1H','X-PUBLISHED-TTL:PT1H'];
 const seen=new Set<string>();
 for(const item of items){
  if(item.onBreak)continue;
  const uid=`${item.kind}-${item.id}-${item.day}@pactaris.app`;
  if(seen.has(uid))continue;seen.add(uid);
  lines.push('BEGIN:VEVENT','UID:'+uid,'DTSTAMP:'+stamp(now));
  if(item.at){const start=new Date(item.at);lines.push('DTSTART:'+stamp(start),'DTEND:'+stamp(new Date(start.getTime()+30*60_000)));}
  else lines.push('DTSTART;VALUE=DATE:'+ymd(item.day),'DTEND;VALUE=DATE:'+ymd(nextDay(item.day)));
  lines.push('SUMMARY:'+escapeText(item.hidden?hiddenTitle:item.title),'TRANSP:'+(item.at?'OPAQUE':'TRANSPARENT'),
   'URL:'+escapeText(`${appOrigin}/households/${householdId}?view=calendar`),'END:VEVENT');
 }
 lines.push('END:VCALENDAR');
 return lines.map(fold).join('\r\n')+'\r\n';
}
