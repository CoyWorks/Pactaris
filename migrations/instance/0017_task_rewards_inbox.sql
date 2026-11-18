CREATE TABLE pactaris.task_points (
 household_id uuid NOT NULL, task_id uuid NOT NULL, recipient uuid NOT NULL,
 points integer NOT NULL CHECK(points BETWEEN 1 AND 10000),
 PRIMARY KEY(household_id,task_id),
 FOREIGN KEY(household_id,task_id) REFERENCES pactaris.partner_tasks(household_id,id),
 FOREIGN KEY(household_id,recipient) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.task_point_reversals (
 household_id uuid NOT NULL, task_id uuid NOT NULL, actor_id uuid NOT NULL,
 reversed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,task_id),
 FOREIGN KEY(household_id,task_id) REFERENCES pactaris.task_points(household_id,task_id),
 FOREIGN KEY(household_id,actor_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.task_inbox (
 household_id uuid NOT NULL, id uuid NOT NULL, task_id uuid NOT NULL, recipient uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('assigned','submitted','reviewed')),
 created_at timestamptz NOT NULL, read boolean NOT NULL DEFAULT false,
 PRIMARY KEY(household_id,id),
 FOREIGN KEY(household_id,task_id) REFERENCES pactaris.partner_tasks(household_id,id) ON DELETE CASCADE,
 FOREIGN KEY(household_id,recipient) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX task_inbox_recipient ON pactaris.task_inbox(household_id,recipient,created_at DESC,id DESC);
CREATE INDEX task_points_recipient ON pactaris.task_points(household_id,recipient);
DO $$
DECLARE table_name text;
BEGIN
 FOR table_name IN SELECT unnest(ARRAY['task_points','task_point_reversals','task_inbox']) LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',table_name);
 END LOOP;
END $$;
CREATE FUNCTION pactaris.record_task_effects() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE task pactaris.partner_tasks; recipient_id uuid; event_kind text; creator_account uuid; instance_id uuid; epoch bigint;
BEGIN
 IF NEW.event_key NOT IN ('partner.partnerAssign','partner.partnerOffer','partner.partnerSubmit','partner.partnerApprove','partner.partnerChanges') THEN RETURN NEW; END IF;
 SELECT t.* INTO task FROM pactaris.partner_tasks t JOIN pactaris.partner_receipts r ON r.household_id=t.household_id AND (r.result->>'taskId')::uuid=t.id
 WHERE r.household_id=NEW.household_id AND r.operation_id=NEW.operation_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NEW.event_key='partner.partnerApprove' AND task.fields?'rewardPoints' THEN
  SELECT account_id INTO creator_account FROM pactaris.memberships WHERE household_id=task.household_id AND id=task.creator_id;
  SELECT h.instance_id,h.safety_version INTO instance_id,epoch FROM pactaris.households h WHERE h.id=task.household_id;
  IF pactaris.activity_guard(task.household_id,instance_id,creator_account,task.creator_id,task.agreement_id,task.agreement_version,'reward',epoch) THEN
   INSERT INTO pactaris.task_points VALUES(task.household_id,task.id,task.assignee_id,(task.fields->>'rewardPoints')::integer) ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 event_kind=CASE NEW.event_key WHEN 'partner.partnerSubmit' THEN 'submitted' WHEN 'partner.partnerApprove' THEN 'reviewed' WHEN 'partner.partnerChanges' THEN 'reviewed' ELSE 'assigned' END;
 recipient_id=CASE WHEN event_kind='submitted' THEN task.creator_id ELSE task.assignee_id END;
 INSERT INTO pactaris.task_inbox(household_id,id,task_id,recipient,kind,created_at)
 SELECT task.household_id,NEW.operation_id,task.id,recipient_id,event_kind,NEW.created_at
 WHERE EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=task.household_id AND id=recipient_id AND status='active');
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.record_task_effects() FROM PUBLIC;
CREATE TRIGGER task_effects AFTER INSERT ON pactaris.partner_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.record_task_effects();

ALTER FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) RENAME TO partner_command_before_effects;
DO $$
DECLARE grantee text;
BEGIN
 FOR grantee IN SELECT rolname FROM pg_roles WHERE has_function_privilege(oid,'pactaris.partner_command_before_effects(uuid,uuid,uuid,uuid,text,jsonb,text)','EXECUTE') AND rolname<>current_user AND NOT rolsuper LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION pactaris.partner_command_before_effects(uuid,uuid,uuid,uuid,text,jsonb,text) FROM %I',grantee);
 END LOOP;
END $$;
CREATE FUNCTION pactaris.partner_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE member uuid; response jsonb; reward jsonb;
BEGIN
 IF action NOT IN ('partnerInbox','partnerInboxRead','partnerPoints','partnerPointsReverse') THEN
  reward=payload->'fields'->'rewardPoints';
  IF reward IS NOT NULL AND (jsonb_typeof(reward)<>'number' OR reward::text !~ '^[1-9][0-9]{0,4}$' OR (reward::text)::integer>10000) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';
  END IF;
  RETURN pactaris.partner_command_before_effects(target,instance,actor,operation,action,payload,fingerprint);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT m.id INTO member FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
 WHERE h.id=target AND h.instance_id=instance AND h.status<>'closed' AND m.id=(payload->>'membershipId')::uuid AND m.account_id=actor AND m.status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied'; END IF;
 response=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',member,'status','listed');
 IF action='partnerInboxRead' THEN
  UPDATE pactaris.task_inbox SET read=true WHERE household_id=target AND id=(payload->>'taskId')::uuid AND recipient=member;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied'; END IF;
  RETURN response||jsonb_build_object('status','applied');
 END IF;
 IF action='partnerPointsReverse' THEN
  INSERT INTO pactaris.task_point_reversals(household_id,task_id,actor_id)
  SELECT t.household_id,t.id,member FROM pactaris.partner_tasks t
  JOIN pactaris.task_points p ON p.household_id=t.household_id AND p.task_id=t.id
  WHERE t.household_id=target AND t.id=(payload->>'taskId')::uuid AND t.creator_id=member
  ON CONFLICT DO NOTHING;
  IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM pactaris.task_point_reversals r WHERE r.household_id=target AND r.task_id=(payload->>'taskId')::uuid AND r.actor_id=member) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';
  END IF;
  RETURN response||jsonb_build_object('status','applied');
 END IF;
 IF action='partnerPoints' THEN
  RETURN response||jsonb_build_object('balance',(SELECT coalesce(sum(points),0)::text FROM pactaris.task_points p WHERE p.household_id=target AND p.recipient=member AND NOT EXISTS(SELECT 1 FROM pactaris.task_point_reversals r WHERE r.household_id=p.household_id AND r.task_id=p.task_id)));
 END IF;
 IF payload?'after' AND NOT EXISTS(SELECT 1 FROM pactaris.task_inbox WHERE household_id=target AND recipient=member AND id=(payload->>'after')::uuid) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';
 END IF;
 RETURN response||jsonb_build_object('inbox',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'taskId',i.task_id,'kind',i.kind,'read',i.read,'at',i.created_at) ORDER BY i.created_at DESC,i.id DESC),'[]'::jsonb)
 FROM (SELECT * FROM pactaris.task_inbox WHERE household_id=target AND recipient=member AND (NOT(payload?'after') OR (created_at,id)<(
  SELECT created_at,id FROM pactaris.task_inbox WHERE household_id=target AND recipient=member AND id=(payload->>'after')::uuid
 )) ORDER BY created_at DESC,id DESC LIMIT 25) i));
END $$;
REVOKE ALL ON FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
