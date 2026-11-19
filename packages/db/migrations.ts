import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import pg from 'pg';
export type Component = 'gateway' | 'instance';
export type Migration = { component: Component; id: string; path: string; sha256: string; backwardCompatible: boolean };
export async function migrations(root: string, component: Component): Promise<Migration[]> {
  const release = JSON.parse(await readFile(resolve(root,'deploy/release.json'),'utf8')) as {migrations: Migration[]};
  if (!Array.isArray(release.migrations)) throw Error('migration.manifest');
  const selected = release.migrations.filter(m=>m.component===component);
  const seen = new Set<string>();
  for (const m of selected) {
    if (!/^\d{4}_[a-z0-9_]+$/.test(m.id) || seen.has(m.id) || !m.backwardCompatible ||
        !/^[a-f0-9]{64}$/.test(m.sha256) || !m.path.startsWith(`migrations/${component}/`) || relative(root,resolve(root,m.path)).startsWith('..')) throw Error('migration.manifest');
    const sql = await readFile(resolve(root,m.path),'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== m.sha256) throw Error('migration.checksum');
    seen.add(m.id);
  }
  return selected;
}
export async function migrate(pool: pg.Pool, root: string, component: Component, runtimeRole: string, backupRole: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole) || !/^[a-z_][a-z0-9_]{0,62}$/.test(backupRole) || backupRole===runtimeRole) throw Error('migration.runtime_role');
  const entries = await migrations(root,component), connection = await pool.connect();
  const role = '"' + runtimeRole + '"';
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('pactaris.migrations',0))");
    const roles = await connection.query('SELECT current_user,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1',[runtimeRole]);
    const runtime = roles.rows[0];
    if (!runtime || runtime.current_user===runtimeRole || runtime.rolsuper || runtime.rolbypassrls || runtime.rolcreatedb || runtime.rolcreaterole) throw Error('migration.runtime_role');
    const backup = await connection.query('SELECT rolbypassrls,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1',[backupRole]);
    if(!backup.rows[0]?.rolbypassrls || backup.rows[0].rolsuper || backup.rows[0].rolcreatedb || backup.rows[0].rolcreaterole)throw Error('migration.backup_role');
    await connection.query('CREATE SCHEMA IF NOT EXISTS pactaris_meta');
    await connection.query('CREATE TABLE IF NOT EXISTS pactaris_meta.migrations (component text NOT NULL,id text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(component,id))');
    for (const m of entries) {
      const existing = await connection.query('SELECT checksum FROM pactaris_meta.migrations WHERE component=$1 AND id=$2',[component,m.id]);
      if (existing.rowCount) { if (existing.rows[0].checksum!==m.sha256) throw Error('migration.applied_checksum'); continue; }
      await connection.query(await readFile(resolve(root,m.path),'utf8'));
      await connection.query('INSERT INTO pactaris_meta.migrations(component,id,checksum) VALUES ($1,$2,$3)',[component,m.id,m.sha256]);
    }
    // No runtime owns schema/tables or obtains DDL, migration or superuser rights.
    await connection.query(`GRANT USAGE ON SCHEMA pactaris,pactaris_meta TO ${role}`);
    await connection.query(`GRANT SELECT ON pactaris_meta.migrations TO ${role}`);
    if (component==='gateway') {
      await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON pactaris.accounts,pactaris.login_attempts,pactaris.sessions,pactaris.auth_limits TO ${role}`);
      await connection.query(`GRANT SELECT ON pactaris.instances,pactaris.placements,pactaris.account_households TO ${role}`);
      if(entries.some(m=>m.id==='0003_onboarding')) {
        await connection.query(`GRANT SELECT,INSERT,UPDATE ON pactaris.onboarding_operations TO ${role}`);
        await connection.query(`GRANT SELECT,INSERT ON pactaris.onboarding_events TO ${role}`);
        await connection.query(`GRANT INSERT ON pactaris.placements,pactaris.account_households TO ${role}`);
        await connection.query(`GRANT DELETE ON pactaris.account_households TO ${role}`);
      }
      if(entries.some(m=>m.id==='0005_membership_fencing'))await connection.query(`GRANT UPDATE(membership_id) ON pactaris.account_households TO ${role}`);
      if(entries.some(m=>m.id==='0006_invitations'))await connection.query(`GRANT SELECT,INSERT,UPDATE ON pactaris.invitation_routes,pactaris.invitation_acceptances TO ${role}`);
      if(entries.some(m=>m.id==='0007_membership_operations'))await connection.query(`GRANT SELECT,INSERT,UPDATE ON pactaris.membership_operations TO ${role}`);
      if(entries.some(m=>m.id==='0008_invitation_mail'))await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON pactaris.invitation_mail TO ${role}`);
      if(entries.some(m=>m.id==='0013_smtp_settings'))await connection.query(`GRANT SELECT,INSERT,UPDATE ON pactaris.smtp_settings TO ${role}`);
      if(entries.some(m=>m.id==='0010_account_presentation'))await connection.query(`GRANT INSERT ON pactaris.account_presentation_events TO ${role}`);
    } else {
      await connection.query(`GRANT SELECT ON pactaris.households,pactaris.memberships,pactaris.household_entitlements TO ${role}`);
      await connection.query(`GRANT SELECT,INSERT,DELETE ON pactaris.delegation_uses TO ${role}`);
      if(entries.some(m=>m.id==='0002_commands')) {
        await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.create_household_command(uuid,uuid,uuid,uuid,text,text),pactaris.leave_household_command(uuid,uuid,uuid,uuid,text) TO ${role}`);
      }
      if(entries.some(m=>m.id==='0004_membership_fencing'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.leave_household_command(uuid,uuid,uuid,uuid,text,uuid) TO ${role}`);
      if(entries.some(m=>m.id==='0005_invitations'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.invitation_command(uuid,uuid,uuid,uuid,text,jsonb,text) TO ${role}`);
      if(entries.some(m=>m.id==='0022_task_catalog_rewards'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.prepare_task_catalog_reward(uuid,uuid,uuid,uuid,uuid,uuid,bigint) TO ${role}`);
      if(entries.some(m=>m.id==='0021_personal_export'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.personal_export(uuid,uuid,uuid,uuid) TO ${role}`);
      if(entries.some(m=>m.id==='0020_private_habit_trend'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.habit_trend(uuid,uuid,uuid,uuid,uuid,bigint,date) TO ${role}`);
      if(entries.some(m=>m.id==='0019_workspace_unread_inbox'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.workspace_has_unread(uuid,uuid,uuid,uuid) TO ${role}`);
      if(entries.some(m=>m.id==='0018_task_inbox_preferences'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.task_inbox_preference_command(uuid,uuid,uuid,uuid,text,jsonb) TO ${role}`);
      if(entries.some(m=>m.id==='0016_task_scheduling'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.run_task_scheduler(uuid) TO ${role}`);
      if(entries.some(m=>m.id==='0013_participant_tasks'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) TO ${role}`);
      if(entries.some(m=>m.id==='0012_reward_catalog'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.catalog_command(uuid,uuid,uuid,uuid,text,jsonb,text) TO ${role}`);
      if(entries.some(m=>m.id==='0011_routines'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.routine_command(uuid,uuid,uuid,uuid,text,jsonb,text) TO ${role}`);
      if(entries.some(m=>m.id==='0010_library_notes'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.document_command(uuid,uuid,uuid,uuid,text,jsonb,text) TO ${role}`);
      if(entries.some(m=>m.id==='0009_workspace_tasks'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.workspace_command(uuid,uuid,uuid,uuid,text,jsonb,text) TO ${role}`);
      if(entries.some(m=>m.id==='0008_consent_safety'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.consent_command(uuid,uuid,uuid,uuid,text,jsonb,text),pactaris.activity_guard(uuid,uuid,uuid,uuid,uuid,bigint,text,bigint) TO ${role}`);
      if(entries.some(m=>m.id==='0007_relationships'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.relationship_command(uuid,uuid,uuid,uuid,text,jsonb,text) TO ${role}`);
      if(entries.some(m=>m.id==='0006_member_administration'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.member_command(uuid,uuid,uuid,uuid,text,jsonb,text) TO ${role}`);
      if(entries.some(m=>m.id==='0003_receipt'))await connection.query(`GRANT EXECUTE ON FUNCTION pactaris.household_receipt_command(uuid,uuid,uuid,uuid) TO ${role}`);
    }
    await connection.query(`GRANT USAGE ON SCHEMA pactaris,pactaris_meta TO "${backupRole}"`);
    await connection.query(`GRANT SELECT ON ALL TABLES IN SCHEMA pactaris,pactaris_meta TO "${backupRole}"`);
    const owner = await connection.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname IN ('pactaris','pactaris_meta') AND r.rolname=$1 LIMIT 1",[runtimeRole]);
    if (owner.rowCount) throw Error('migration.runtime_owner');
    await connection.query('COMMIT');
  } catch (e) { await connection.query('ROLLBACK'); throw e; }
  finally { connection.release(); }
}
export async function requireSchema(pool: pg.Pool, component: Component) {
  const r = await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
  if (r.rows[0]?.rolsuper || r.rows[0]?.rolbypassrls) throw Error('database.privileged_runtime');
  const expected=(await migrations(process.cwd(),component)).map(m=>m.id);
  const version = await pool.query('SELECT id FROM pactaris_meta.migrations WHERE component=$1 AND id=ANY($2::text[])',[component,expected]);
  if (!expected.length||version.rowCount!==expected.length) throw Error('database.schema_required');
  const owner = await pool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('pactaris','pactaris_meta') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) LIMIT 1");
  if (owner.rowCount) throw Error('database.runtime_owner');
}
