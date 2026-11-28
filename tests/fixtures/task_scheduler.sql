CREATE SCHEMA scheduler_test;
CREATE FUNCTION scheduler_test.check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'scheduler assertion: %',label;END IF;END$$;
-- All identifiers and content are synthetic. Exact scope, including four people,
-- is accepted explicitly here so worker guard failures can be tested independently.
SELECT pactaris.create_household_command('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004','Scheduler fixture',repeat('a',64));
UPDATE pactaris.household_entitlements SET capabilities=jsonb_set(capabilities,'{tasks.active.max}','100') WHERE household_id='10000000-0000-4000-8000-000000000001';
INSERT INTO pactaris.memberships(household_id,id,account_id,status) SELECT '10000000-0000-4000-8000-000000000001',('20000000-0000-4000-8000-00000000000'||n)::uuid,('30000000-0000-4000-8000-00000000000'||n)::uuid,'active' FROM generate_series(1,3) n;
INSERT INTO pactaris.relationships(household_id,id,label,status) VALUES('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','Group fixture','active');
INSERT INTO pactaris.relationship_participants(household_id,relationship_id,membership_id,accepted) SELECT household_id,'40000000-0000-4000-8000-000000000001',id,true FROM pactaris.memberships WHERE household_id='10000000-0000-4000-8000-000000000001';
INSERT INTO pactaris.agreements(household_id,id,relationship_id) VALUES('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001');
INSERT INTO pactaris.agreement_versions(household_id,agreement_id,version,terms,expires_at,created_by) SELECT household_id,'50000000-0000-4000-8000-000000000001',1,'{"label":"Task scope","activities":["task"]}',now()+interval '30 days',id FROM pactaris.memberships WHERE account_id='10000000-0000-4000-8000-000000000003';
INSERT INTO pactaris.agreement_decisions(household_id,agreement_id,version,membership_id,decision,household_epoch,member_epoch,relationship_epoch,limits_version,decided_at) SELECT household_id,'50000000-0000-4000-8000-000000000001',1,id,'accepted',1,1,1,1,now() FROM pactaris.memberships WHERE household_id='10000000-0000-4000-8000-000000000001';
INSERT INTO pactaris.assignment_policies(household_id,id,creator_id,assignee_id,agreement_id,agreement_version,version,mode,state) SELECT household_id,'60000000-0000-4000-8000-000000000001',id,'20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',1,2,'direct','active' FROM pactaris.memberships WHERE account_id='10000000-0000-4000-8000-000000000003';
CREATE FUNCTION scheduler_test.payload() RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('membershipId',(SELECT id FROM pactaris.memberships WHERE account_id='10000000-0000-4000-8000-000000000003'),'policyId','60000000-0000-4000-8000-000000000001','policyVersion','2','epoch','1','safetyVersion',pactaris.partner_snapshot('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',1),'fields',jsonb_build_object('title','Scheduled fixture','description','','priority','normal','dueAt',NULL),'schedule',jsonb_build_object('period','daily','startDate',(now() AT TIME ZONE 'UTC')::date+1,'endDate',NULL,'timeZone','UTC','availableTime','09:00','dueMinutes',60,'weekdays','[]'::jsonb)) $$;
CREATE FUNCTION scheduler_test.command(action text,payload jsonb,op uuid DEFAULT gen_random_uuid(),actor uuid DEFAULT '10000000-0000-4000-8000-000000000003') RETURNS jsonb LANGUAGE sql AS $$ SELECT pactaris.partner_command('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',actor,op,action,payload,encode(sha256(convert_to(payload::text,'UTF8')),'hex')) $$;
-- Exercise earned points and inbox without changing the scheduler fixture state.
DO $$
DECLARE
 creator_account uuid:='10000000-0000-4000-8000-000000000003';
 assignee_account uuid:='30000000-0000-4000-8000-000000000001';
 assignee uuid:='20000000-0000-4000-8000-000000000001';
 task uuid:=gen_random_uuid();
 creator_input jsonb:=scheduler_test.payload()-'schedule';
 assignee_input jsonb;
BEGIN
 BEGIN
  UPDATE pactaris.agreement_versions SET terms=jsonb_set(terms,'{activities}','["task","reward"]');
  creator_input=jsonb_set(creator_input,'{fields,rewardPoints}','5');
  creator_input=creator_input||jsonb_build_object('assigneeId',assignee,'agreementId','50000000-0000-4000-8000-000000000001','agreementVersion','1');
  PERFORM scheduler_test.command('partnerAssign',creator_input,task,creator_account);
  PERFORM scheduler_test.check(jsonb_array_length(scheduler_test.command('partnerInbox',jsonb_build_object('membershipId',assignee),gen_random_uuid(),assignee_account)->'inbox')=1,'assignee sees one notification');
  PERFORM scheduler_test.check(scheduler_test.command('partnerInbox',creator_input,gen_random_uuid(),creator_account)->'inbox'='[]','creator does not see assignee inbox');
  creator_input=creator_input||jsonb_build_object('taskId',task);
  assignee_input=creator_input||jsonb_build_object('membershipId',assignee);
  FOR n IN 0..1 LOOP
   PERFORM scheduler_test.command('partnerStart',assignee_input||jsonb_build_object('version',(1+4*n)::text),gen_random_uuid(),assignee_account);
   PERFORM scheduler_test.command('partnerSubmit',assignee_input||jsonb_build_object('version',(2+4*n)::text,'note','Fixture submission'),gen_random_uuid(),assignee_account);
   PERFORM scheduler_test.command('partnerApprove',creator_input||jsonb_build_object('version',(3+4*n)::text),gen_random_uuid(),creator_account);
   IF n=0 THEN
    PERFORM scheduler_test.command('partnerReopen',creator_input||jsonb_build_object('version','4'),gen_random_uuid(),creator_account);
   END IF;
  END LOOP;
  PERFORM scheduler_test.check(scheduler_test.command('partnerPoints',assignee_input,gen_random_uuid(),assignee_account)->>'balance'='5','reapproval cannot duplicate points');
  PERFORM scheduler_test.command('partnerPointsReverse',creator_input,gen_random_uuid(),creator_account);
  PERFORM scheduler_test.command('partnerPointsReverse',creator_input,gen_random_uuid(),creator_account);
  PERFORM scheduler_test.check(scheduler_test.command('partnerPoints',assignee_input,gen_random_uuid(),assignee_account)->>'balance'='0','reversal recorded once');
  RAISE SQLSTATE 'P9001' USING MESSAGE='rollback isolated reward fixture';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
 END;
END $$;
-- Calendar boundaries: gaps, folds, selected weekdays, leap/month end, non-hour DST.
SELECT scheduler_test.check(pactaris.task_occurrence_at('{"period":"daily","startDate":"2026-01-01","endDate":null,"timeZone":"Europe/Amsterdam","availableTime":"02:30"}', '2026-03-29') IS NULL,'DST gap skipped');
SELECT scheduler_test.check(pactaris.task_occurrence_at('{"period":"daily","startDate":"2026-01-01","endDate":null,"timeZone":"Europe/Amsterdam","availableTime":"02:30"}', '2026-10-25')='2026-10-25 01:30Z'::timestamptz,'DST fold once at standard time');
SELECT scheduler_test.check(pactaris.task_occurrence_at('{"period":"weekly","weekdays":[1],"startDate":"2026-01-01","timeZone":"UTC","availableTime":"09:00"}', '2026-11-17') IS NULL,'weekday excluded');
SELECT scheduler_test.check(pactaris.task_occurrence_at('{"period":"daily","startDate":"2028-02-28","timeZone":"UTC","availableTime":"09:00"}', '2028-02-29')='2028-02-29 09:00Z'::timestamptz,'leap day');
SELECT scheduler_test.check(pactaris.task_occurrence_at('{"period":"daily","startDate":"2026-01-31","timeZone":"UTC","availableTime":"09:00"}', '2026-02-01')='2026-02-01 09:00Z'::timestamptz,'month end');
SELECT scheduler_test.check(pactaris.task_occurrence_at('{"period":"daily","startDate":"2026-01-01","timeZone":"Australia/Lord_Howe","availableTime":"02:15"}', '2026-10-04') IS NULL,'half-hour gap');
SELECT scheduler_test.command('partnerSeriesCreate',scheduler_test.payload(),'70000000-0000-4000-8000-000000000001');
SELECT scheduler_test.command('partnerSeriesCreate',scheduler_test.payload(),'70000000-0000-4000-8000-000000000001');
SELECT scheduler_test.check((SELECT count(*)=7 AND bool_and(state='assigned') FROM pactaris.partner_tasks),'immediate window without manufactured acceptance');
SELECT scheduler_test.check((SELECT count(*)=8 FROM pactaris.partner_outbox),'one outbox record per operation');
SELECT scheduler_test.check((scheduler_test.command('partnerList',jsonb_build_object('membershipId','20000000-0000-4000-8000-000000000001','filter','todo'),gen_random_uuid(),'30000000-0000-4000-8000-000000000001')->'tasks')='[]','planned work excluded from actionable list');
SELECT scheduler_test.check((scheduler_test.command('partnerSeriesList',jsonb_build_object('membershipId','20000000-0000-4000-8000-000000000002'),gen_random_uuid(),'30000000-0000-4000-8000-000000000002')->'series')='[]','unrelated group member privacy');
-- Wrong home Instance and unrelated actor cannot invoke an effect.
DO $$BEGIN
 BEGIN PERFORM pactaris.partner_command('10000000-0000-4000-8000-000000000001',gen_random_uuid(),'10000000-0000-4000-8000-000000000003',gen_random_uuid(),'partnerSeriesCreate',scheduler_test.payload(),repeat('a',64));RAISE EXCEPTION 'wrong instance accepted';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'partner.denied' THEN RAISE;END IF;END;
 BEGIN PERFORM scheduler_test.command('partnerStart',jsonb_build_object('membershipId','20000000-0000-4000-8000-000000000001','taskId',(SELECT id FROM pactaris.partner_tasks LIMIT 1),'version','1'),gen_random_uuid(),'30000000-0000-4000-8000-000000000001');RAISE EXCEPTION 'future start accepted';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'partner.conflict' THEN RAISE;END IF;END;
END$$;
-- Rewind cursor to simulate repeated/stale work: no duplicate effects.
UPDATE pactaris.task_generation_jobs SET cursor_date=current_date-30,run_after=now();
SELECT pactaris.run_task_scheduler('10000000-0000-4000-8000-000000000002');
SELECT scheduler_test.check((SELECT count(*)=7 FROM pactaris.partner_tasks),'idempotent catch-up skips elapsed dates');
-- Fail at the final outbox write. Entire generation rolls back, but retry persists.
CREATE FUNCTION scheduler_test.fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic outbox failure';END$$;
CREATE TRIGGER fail_scheduler_outbox BEFORE INSERT ON pactaris.partner_outbox FOR EACH ROW EXECUTE FUNCTION scheduler_test.fail_outbox();
-- Move one synthetic occurrence out of the planning window so regeneration has work.
UPDATE pactaris.partner_tasks SET occurrence_date=current_date-1 WHERE occurrence_date=current_date+1;
UPDATE pactaris.task_generation_jobs SET cursor_date=current_date+1,run_after=now();
SELECT scheduler_test.check(pactaris.run_task_scheduler('10000000-0000-4000-8000-000000000002')='failed','worker records failure');
SELECT scheduler_test.check((SELECT attempts=1 AND run_after>now() FROM pactaris.task_generation_jobs),'durable backoff');
SELECT scheduler_test.check((SELECT count(*)=7 FROM pactaris.partner_tasks),'failed final effect rolls back occurrence');
DO $$BEGIN FOR n IN 1..4 LOOP UPDATE pactaris.task_generation_jobs SET run_after=now();PERFORM pactaris.run_task_scheduler('10000000-0000-4000-8000-000000000002');END LOOP;END$$;
SELECT scheduler_test.check((SELECT state='dead' AND attempts=5 FROM pactaris.task_generation_jobs),'dead letter after five attempts');
DROP TRIGGER fail_scheduler_outbox ON pactaris.partner_outbox;
-- Explicit revision is the only dead-letter recovery; old job stays historical.
SELECT scheduler_test.command('partnerSeriesUpdate',scheduler_test.payload()||jsonb_build_object('seriesId','70000000-0000-4000-8000-000000000001','version','1'));
SELECT scheduler_test.check((SELECT count(*)=2 FROM pactaris.task_series_versions),'version history retained');
SELECT scheduler_test.check((SELECT count(*)=7 FROM pactaris.partner_tasks WHERE state='assigned'),'revision replaces future untouched work');
-- Pause invalidates generation even when current decision fingerprint is unchanged.
UPDATE pactaris.memberships SET safety_paused=true WHERE id='20000000-0000-4000-8000-000000000001';
UPDATE pactaris.task_generation_jobs SET run_after=now() WHERE state='pending';
SELECT pactaris.run_task_scheduler('10000000-0000-4000-8000-000000000002');
SELECT scheduler_test.check((SELECT state='blocked' FROM pactaris.task_series),'current pause rechecked');
UPDATE pactaris.memberships SET safety_paused=false WHERE id='20000000-0000-4000-8000-000000000001';
SELECT scheduler_test.check(pactaris.run_task_scheduler('10000000-0000-4000-8000-000000000002')='idle','no automatic resume/backlog');
-- Downgrade never removes history or prevents safe cancellation by the recipient.
UPDATE pactaris.household_entitlements SET capabilities=jsonb_set(capabilities,'{tasks.active.max}','0');
SELECT scheduler_test.command('partnerSeriesCancel',jsonb_build_object('membershipId','20000000-0000-4000-8000-000000000001','seriesId','70000000-0000-4000-8000-000000000001','version','2'),gen_random_uuid(),'30000000-0000-4000-8000-000000000001');
SELECT scheduler_test.check((SELECT count(*)=14 FROM pactaris.partner_tasks),'history retained on cancellation/downgrade');
SELECT scheduler_test.check((SELECT state='cancelled' FROM pactaris.task_series),'recipient cancellation permitted');
-- Model a worker that last ran before today's planning window. Its persisted
-- cursor advances and adds later dates with no page request or manager call.
UPDATE pactaris.household_entitlements SET capabilities=jsonb_set(capabilities,'{tasks.active.max}','100');
SELECT scheduler_test.command('partnerSeriesCreate',scheduler_test.payload(),'70000000-0000-4000-8000-000000000002');
DELETE FROM pactaris.partner_outbox WHERE operation_id IN (SELECT id FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000002' AND occurrence_date>current_date+2);
DELETE FROM pactaris.partner_receipts WHERE operation_id IN (SELECT id FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000002' AND occurrence_date>current_date+2);
DELETE FROM pactaris.partner_events WHERE task_id IN (SELECT id FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000002' AND occurrence_date>current_date+2);
DELETE FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000002' AND occurrence_date>current_date+2;
UPDATE pactaris.task_generation_jobs SET cursor_date=current_date+3,run_after=now() WHERE series_id='70000000-0000-4000-8000-000000000002';
SELECT pactaris.run_task_scheduler('10000000-0000-4000-8000-000000000002');
SELECT scheduler_test.check((SELECT count(*)=7 FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000002'),'autonomous extension beyond initial window');
-- Plan limits (0071): a series counts once against its assignee's series limit; its occurrences do not
-- count as one-off tasks, so generation continues even when the one-off limit is full.
-- Remove one synthetic future occurrence, preserving the other six.
DELETE FROM pactaris.partner_outbox WHERE operation_id IN (SELECT id FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000002' AND occurrence_date=current_date+7);
DELETE FROM pactaris.partner_receipts WHERE operation_id IN (SELECT id FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000002' AND occurrence_date=current_date+7);
DELETE FROM pactaris.partner_events WHERE task_id IN (SELECT id FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000002' AND occurrence_date=current_date+7);
DELETE FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000002' AND occurrence_date=current_date+7;
UPDATE pactaris.task_generation_jobs SET cursor_date=current_date+7,run_after=now() WHERE series_id='70000000-0000-4000-8000-000000000002';
UPDATE pactaris.household_entitlements SET capabilities=capabilities||'{"tasks.active.max":0,"oneoff.open.max":0}'::jsonb;
SELECT scheduler_test.check(pactaris.run_task_scheduler('10000000-0000-4000-8000-000000000002')='processed','occurrences do not count towards one-off tasks');
SELECT scheduler_test.check((SELECT count(*)=7 FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000002'),'generation replaces exactly one occurrence at a full one-off limit');
UPDATE pactaris.household_entitlements SET capabilities=capabilities||'{"oneoff.open.max":100}'::jsonb;
-- A decision renewal changes the persisted safety fingerprint (ABA fence).
UPDATE pactaris.agreement_decisions SET decided_at=now()+interval '1 second';
UPDATE pactaris.task_generation_jobs SET run_after=now() WHERE series_id='70000000-0000-4000-8000-000000000002';
SELECT pactaris.run_task_scheduler('10000000-0000-4000-8000-000000000002');
SELECT scheduler_test.check((SELECT state='blocked' FROM pactaris.task_series WHERE id='70000000-0000-4000-8000-000000000002'),'old safety snapshot never silently renewed');
-- Explicit revision recovers the new current scope, but not a revoked policy.
SELECT scheduler_test.command('partnerSeriesUpdate',scheduler_test.payload()||jsonb_build_object('seriesId','70000000-0000-4000-8000-000000000002','version','1'));
UPDATE pactaris.assignment_policies SET state='revoked',version=3;
UPDATE pactaris.task_generation_jobs SET run_after=now() WHERE state='pending';
SELECT pactaris.run_task_scheduler('10000000-0000-4000-8000-000000000002');
SELECT scheduler_test.check((SELECT state='blocked' FROM pactaris.task_series WHERE id='70000000-0000-4000-8000-000000000002'),'revoked standing authority blocks queued execution');
UPDATE pactaris.memberships SET status='left' WHERE id='20000000-0000-4000-8000-000000000001';
SELECT scheduler_test.check((SELECT state='cancelled' FROM pactaris.task_series WHERE id='70000000-0000-4000-8000-000000000002'),'departure cancels series');
SELECT scheduler_test.check(NOT EXISTS(SELECT 1 FROM pactaris.task_generation_jobs WHERE state='pending'),'departure fences queued jobs');
