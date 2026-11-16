/** Explicit root-only registration for the known co-located pilot; not remote enrollment. */
import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import https from 'node:https';
import pg from 'pg';
import { parseConfig, parseGatewayConfig } from '../packages/config/index.js';
import { registerInstance, validateRegistration } from '../packages/routing/registry.js';

async function protectedFile(path:string, privateOnly=false) {
  if(!isAbsolute(path))throw Error('registry.file');
  const metadata=await lstat(path);
  if(!metadata.isFile()||metadata.uid!==0||metadata.mode&(privateOnly?0o077:0o027)||await realpath(path)!==path)throw Error('registry.file');
  // Every ancestor must be root-owned and not group/world writable.
  for(let parent=path.slice(0,path.lastIndexOf('/'))||'/';;parent=parent.slice(0,parent.lastIndexOf('/'))||'/'){
    const directory=await stat(parent);
    if(directory.uid!==0||directory.mode&0o022)throw Error('registry.directory');
    if(parent==='/')break;
  }
  return readFile(path,'utf8');
}

try {
  if(process.getuid?.()!==0)throw Error('registry.root_required');
  const args=process.argv.slice(2),apply=args.includes('--apply');
  if(args.some(a=>a!=='--apply'))throw Error('registry.arguments');
  const gatewayPath=process.env.APP_CONFIG;
  const instancePath=process.env.INSTANCE_CONFIG;
  if(!gatewayPath||!instancePath)throw Error('registry.configuration');
  const gateway=parseGatewayConfig(JSON.parse(await protectedFile(gatewayPath)));
  const instance=parseConfig(JSON.parse(await protectedFile(instancePath)));
  if(!gateway.listen.tls||!instance.listen.tls)throw Error('registry.tls');
  const host=instance.listen.address.includes(':')?`[${instance.listen.address}]`:instance.listen.address;
  const registration=validateRegistration({id:instance.instanceId,endpoint:`https://${host}:${instance.listen.port}/`,tlsServerName:instance.listen.tls.serverName,caFile:gateway.listen.tls.caFile});
  // The co-located pilot shares an internal CA. Use the gateway-owned copy, never
  // a path readable only by the Instance's service group.
  const ca=await protectedFile(registration.caFile);
  if(ca.trim()!==(await protectedFile(instance.listen.tls.caFile)).trim())throw Error('registry.distinct_ca_requires_enrollment');
  const credential=await protectedFile(gateway.database.migrationUrlFile!,true);
  if(!apply){process.stdout.write(JSON.stringify({code:'registry.plan',instanceId:registration.id})+'\n');}
  else {
    await new Promise<void>((resolve,reject)=>{
      const request=https.get(registration.endpoint+'health/ready',{ca,servername:registration.tlsServerName,rejectUnauthorized:true,headers:{Host:new URL(instance.publicOrigin).host},timeout:5000},response=>{
        let body='';response.setEncoding('utf8');response.on('data',(chunk:string)=>{body+=chunk;if(body.length>1024)response.destroy(Error('registry.health'));});
        response.on('error',reject);response.on('end',()=>{try{if(response.statusCode!==200||JSON.parse(body).status!=='ready')throw Error('registry.health');resolve();}catch(error){reject(error);}});
      });
      request.on('error',reject);request.on('timeout',()=>request.destroy(Error('registry.timeout')));
    });
    const pool=new pg.Pool({connectionString:credential.trim(),max:1,connectionTimeoutMillis:5000,query_timeout:10000});
    try {
      const role=await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
      if(!role.rowCount||role.rows[0].rolsuper||role.rows[0].rolbypassrls)throw Error('registry.operator_role');
      const result=await registerInstance(pool,registration);
      process.stdout.write(JSON.stringify({code:'registry.'+result,instanceId:registration.id})+'\n');
    }finally{await pool.end();}
  }
}catch{process.stderr.write(JSON.stringify({code:'registry.failed'})+'\n');process.exitCode=1;}
