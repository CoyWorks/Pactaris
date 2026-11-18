import {parseArgs} from 'node:util';
import {parseGatewayConfig} from '../packages/config/index.js';
import {protectedFile} from '../packages/config/protected-file.js';
import {uuid} from '../packages/auth/delegation.js';
import {database} from '../packages/db/index.js';
import {requireSchema} from '../packages/db/migrations.js';
import {listRegistryInstances,listRegistryPlacements} from '../packages/routing/inventory.js';

/** Local operator read of placement metadata. No private server is contacted. */
try {
  if(process.getuid?.()!==0)throw Error('registry.root_required');
  const {values}=parseArgs({options:{'instance':{type:'string'},'after':{type:'string'}}});
  const instance=values.instance,after=values.after??null;
  if((instance!==undefined&&!uuid(instance))||(after!==null&&!uuid(after)))throw Error('registry.arguments');
  const path=process.env.APP_CONFIG;
  if(!path)throw Error('registry.configuration');
  const config=parseGatewayConfig(JSON.parse(await protectedFile(path)));
  const db=database(config);
  try {
    await requireSchema(db.pool,'gateway');
    const result=instance
      ?await listRegistryPlacements(db.pool,instance,after)
      :await listRegistryInstances(db.pool,after);
    if(!result)throw Error('registry.instance_missing');
    process.stdout.write(JSON.stringify({code:'registry.inventory',...result})+'\n');
  }finally{await db.close();}
}catch{
  process.stderr.write(JSON.stringify({code:'registry.inventory_failed'})+'\n');
  process.exitCode=1;
}
