import {InvitationMail,loadInvitationMail} from './invitation-mail.js';
import { loadGatewayConfig } from '../../packages/config/index.js';
import { database } from '../../packages/db/index.js';
import { requireSchema } from '../../packages/db/migrations.js';
import {GatewayMembers} from './members.js';
import { GatewayInvitations } from './invitations.js';
import { PgGatewayStore } from './store.js';
import { writeFile,rename,mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DelegationSigner } from '../../packages/auth/delegation.js';
import { PrivateCommandClient,PrivateHouseholdClient,PrivateInvitationClient,PrivateMemberClient } from '../../packages/routing/private-client.js';
import { OnboardingService,PgOnboardingStore } from './onboarding.js';
const config=loadGatewayConfig(process.env.APP_CONFIG??'',process.argv.includes('--development')),db=database(config);
const store=new PgGatewayStore(db.pool,()=>requireSchema(db.pool,'gateway'));let stopped=false;
const onboarding=new OnboardingService(new PgOnboardingStore(db.pool,config.onboarding.maxOwnedHouseholds,new PrivateHouseholdClient(new DelegationSigner(config))),new PrivateCommandClient(new DelegationSigner(config)));
const invitationSigner=new DelegationSigner(config),invitations=new GatewayInvitations(db.pool,store,new PrivateHouseholdClient(invitationSigner),new PrivateInvitationClient(invitationSigner),loadInvitationMail(config,db.pool));
const members=new GatewayMembers(db.pool,store,new PrivateHouseholdClient(invitationSigner),new PrivateMemberClient(invitationSigner));
async function tick(){
  if(stopped)return;let state='ready';
  let invitationMail:Awaited<ReturnType<typeof InvitationMail.metrics>>|null=null;
  try{await store.probe();await store.cleanup();await onboarding.reconcile();await invitations.reconcile();await members.reconcile();await InvitationMail.expire(db.pool);if(config.invitationMailFile)invitationMail=await InvitationMail.metrics(db.pool);}catch{state='unavailable';}
  await mkdir(dirname(config.worker.heartbeatFile),{recursive:true,mode:0o700});
  const file=config.worker.heartbeatFile+'.tmp';await writeFile(file,JSON.stringify({component:'worker',state,checkedAt:new Date().toISOString(),invitationMail}),{mode:0o600});await rename(file,config.worker.heartbeatFile);
  if(!stopped)try{await invitations.deliverMail();}catch{process.stderr.write(JSON.stringify({code:'invitation.mail_deferred'})+'\n');}
  if(!stopped)setTimeout(()=>{void tick().catch(fail);},config.worker.intervalSeconds*1000);
}
function fail(){process.stderr.write(JSON.stringify({code:'gateway.worker_failed'})+'\n');process.exit(1);}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopped=true;void db.close().then(()=>process.exit(0));});
void tick().catch(fail);
