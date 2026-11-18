import type pg from 'pg';

const pageSize=50;
type RegistryInstance={
  id:string;status:'active'|'disabled';activePlacements:string;disabledPlacements:string;
};
type RegistryPlacement={
  householdId:string;status:'active'|'disabled';version:string;
};

export async function listRegistryInstances(pool:pg.Pool,after:string|null){
  const result=await pool.query<RegistryInstance>(`
    SELECT i.id,i.status,p.active AS "activePlacements",p.disabled AS "disabledPlacements"
    FROM (SELECT id,status FROM pactaris.instances
      WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2) i
    CROSS JOIN LATERAL (
      SELECT (count(*) FILTER(WHERE status='active'))::text AS active,
        (count(*) FILTER(WHERE status='disabled'))::text AS disabled
      FROM pactaris.placements WHERE instance_id=i.id
    ) p ORDER BY i.id`,[after,pageSize+1]);
  const instances=result.rows.slice(0,pageSize);
  return {source:'gateway_registry',observedAt:new Date().toISOString(),instances,
    nextCursor:result.rows.length>pageSize?instances.at(-1)!.id:null};
}

export async function listRegistryPlacements(pool:pg.Pool,instanceId:string,after:string|null){
  const instance=await pool.query<{status:'active'|'disabled'}>(
    'SELECT status FROM pactaris.instances WHERE id=$1',[instanceId]);
  if(!instance.rowCount)return;
  const result=await pool.query<RegistryPlacement>(`
    SELECT household_id AS "householdId",status,version::text
    FROM pactaris.placements WHERE instance_id=$1 AND ($2::uuid IS NULL OR household_id>$2::uuid)
    ORDER BY household_id LIMIT $3`,[instanceId,after,pageSize+1]);
  const placements=result.rows.slice(0,pageSize);
  return {source:'gateway_registry',observedAt:new Date().toISOString(),instanceId,status:instance.rows[0]!.status,
    placements,nextCursor:result.rows.length>pageSize?placements.at(-1)!.householdId:null};
}
