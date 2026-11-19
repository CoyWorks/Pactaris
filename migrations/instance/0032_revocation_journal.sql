-- Minimal, content-free record of revocations and deletions. The gateway copies
-- these entries outside this database so a restored snapshot can replay them
-- before it serves traffic again. Subjects contain identifiers only.
CREATE TABLE pactaris.revocation_journal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id uuid NOT NULL REFERENCES pactaris.households(id),
 kind text NOT NULL CHECK(kind IN ('membership.ended','member.paused','household.stopped','relationship.paused',
  'relationship.ended','agreement.revoked','consent.withdrawn','taskAuthority.revoked','document.deleted',
  'attachment.deleted','checkin.withdrawn')),
 subject jsonb NOT NULL CHECK(jsonb_typeof(subject)='object'),
 occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 exported_at timestamptz
);
CREATE INDEX revocation_journal_pending ON pactaris.revocation_journal(occurred_at,id) WHERE exported_at IS NULL;
ALTER TABLE pactaris.revocation_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.revocation_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY revocation_journal_command ON pactaris.revocation_journal FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.journal_record(target uuid,entry_kind text,entry_subject jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 INSERT INTO pactaris.revocation_journal(household_id,kind,subject) VALUES(target,entry_kind,entry_subject);
$$;
REVOKE ALL ON FUNCTION pactaris.journal_record(uuid,text,jsonb) FROM PUBLIC;

CREATE FUNCTION pactaris.journal_membership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.status IN ('left','revoked') AND OLD.status NOT IN ('left','revoked') THEN
  PERFORM pactaris.journal_record(NEW.household_id,'membership.ended',
   jsonb_build_object('membershipId',NEW.id,'accountId',NEW.account_id,'status',NEW.status));
 END IF;
 IF NEW.safety_paused AND NOT OLD.safety_paused THEN
  PERFORM pactaris.journal_record(NEW.household_id,'member.paused',
   jsonb_build_object('membershipId',NEW.id,'epoch',NEW.safety_epoch::text));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_membership AFTER UPDATE OF status,safety_paused ON pactaris.memberships
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_membership();

CREATE FUNCTION pactaris.journal_household() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.status IN ('paused','closed') AND NEW.status IS DISTINCT FROM OLD.status THEN
  PERFORM pactaris.journal_record(NEW.id,'household.stopped',
   jsonb_build_object('status',NEW.status,'safetyVersion',NEW.safety_version::text));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_household AFTER UPDATE OF status ON pactaris.households
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_household();

CREATE FUNCTION pactaris.journal_relationship_hold() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.paused AND (TG_OP='INSERT' OR NOT OLD.paused) THEN
  PERFORM pactaris.journal_record(NEW.household_id,'relationship.paused',
   jsonb_build_object('relationshipId',NEW.relationship_id,'membershipId',NEW.membership_id,'epoch',NEW.epoch::text));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_relationship_hold AFTER INSERT OR UPDATE OF paused ON pactaris.relationship_holds
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_relationship_hold();

CREATE FUNCTION pactaris.journal_relationship() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.status='ended' AND OLD.status<>'ended' THEN
  PERFORM pactaris.journal_record(NEW.household_id,'relationship.ended',
   jsonb_build_object('relationshipId',NEW.id,'reason',coalesce(NEW.end_reason,'unknown')));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_relationship AFTER UPDATE OF status ON pactaris.relationships
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_relationship();

CREATE FUNCTION pactaris.journal_agreement_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.revoked AND NOT OLD.revoked THEN
  PERFORM pactaris.journal_record(NEW.household_id,'agreement.revoked',
   jsonb_build_object('agreementId',NEW.agreement_id,'version',NEW.version::text));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_agreement_version AFTER UPDATE OF revoked ON pactaris.agreement_versions
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_agreement_version();

CREATE FUNCTION pactaris.journal_agreement_decision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.decision IN ('declined','withdrawn') AND NEW.decision IS DISTINCT FROM OLD.decision THEN
  PERFORM pactaris.journal_record(NEW.household_id,'consent.withdrawn',
   jsonb_build_object('agreementId',NEW.agreement_id,'version',NEW.version::text,'membershipId',NEW.membership_id,'decision',NEW.decision));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_agreement_decision AFTER UPDATE OF decision ON pactaris.agreement_decisions
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_agreement_decision();

CREATE FUNCTION pactaris.journal_assignment_policy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.state='revoked' AND OLD.state<>'revoked' THEN
  PERFORM pactaris.journal_record(NEW.household_id,'taskAuthority.revoked',jsonb_build_object('policyId',NEW.id));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_assignment_policy AFTER UPDATE OF state ON pactaris.assignment_policies
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_assignment_policy();

CREATE FUNCTION pactaris.journal_document() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.state='deleted' AND OLD.state<>'deleted' THEN
  PERFORM pactaris.journal_record(NEW.household_id,'document.deleted',jsonb_build_object('documentId',NEW.id));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_document AFTER UPDATE OF state ON pactaris.documents
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_document();

CREATE FUNCTION pactaris.journal_attachment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 PERFORM pactaris.journal_record(OLD.household_id,'attachment.deleted',
  jsonb_build_object('documentId',OLD.document_id,'version',OLD.version::text));
 RETURN OLD;
END $$;
CREATE TRIGGER journal_attachment AFTER DELETE ON pactaris.draft_attachments
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_attachment();

CREATE FUNCTION pactaris.journal_checkin() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.state='withdrawn' AND OLD.state<>'withdrawn' THEN
  PERFORM pactaris.journal_record(NEW.household_id,'checkin.withdrawn',jsonb_build_object('checkinId',NEW.id));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_checkin AFTER UPDATE OF state ON pactaris.shared_checkins
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_checkin();

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['journal_membership','journal_household','journal_relationship_hold','journal_relationship',
  'journal_agreement_version','journal_agreement_decision','journal_assignment_policy','journal_document','journal_attachment','journal_checkin'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION pactaris.%I() FROM PUBLIC',name);
 END LOOP;
END $$;

-- Record existing ended or revoked state once, so the first export is complete.
INSERT INTO pactaris.revocation_journal(household_id,kind,subject,occurred_at)
 SELECT household_id,'membership.ended',jsonb_build_object('membershipId',membership_id,'accountId',account_id,'status',end_status),coalesce(ended_at,recorded_at)
 FROM pactaris.membership_endings;
INSERT INTO pactaris.revocation_journal(household_id,kind,subject)
 SELECT household_id,'member.paused',jsonb_build_object('membershipId',id,'epoch',safety_epoch::text) FROM pactaris.memberships WHERE safety_paused;
INSERT INTO pactaris.revocation_journal(household_id,kind,subject)
 SELECT id,'household.stopped',jsonb_build_object('status',status,'safetyVersion',safety_version::text) FROM pactaris.households WHERE status IN ('paused','closed');
INSERT INTO pactaris.revocation_journal(household_id,kind,subject)
 SELECT household_id,'relationship.paused',jsonb_build_object('relationshipId',relationship_id,'membershipId',membership_id,'epoch',epoch::text)
 FROM pactaris.relationship_holds WHERE paused;
INSERT INTO pactaris.revocation_journal(household_id,kind,subject,occurred_at)
 SELECT household_id,'relationship.ended',jsonb_build_object('relationshipId',id,'reason',coalesce(end_reason,'unknown')),coalesce(ended_at,statement_timestamp())
 FROM pactaris.relationships WHERE status='ended';
INSERT INTO pactaris.revocation_journal(household_id,kind,subject)
 SELECT household_id,'agreement.revoked',jsonb_build_object('agreementId',agreement_id,'version',version::text) FROM pactaris.agreement_versions WHERE revoked;
INSERT INTO pactaris.revocation_journal(household_id,kind,subject,occurred_at)
 SELECT household_id,'consent.withdrawn',jsonb_build_object('agreementId',agreement_id,'version',version::text,'membershipId',membership_id,'decision',decision),coalesce(decided_at,statement_timestamp())
 FROM pactaris.agreement_decisions WHERE decision IN ('declined','withdrawn');
INSERT INTO pactaris.revocation_journal(household_id,kind,subject)
 SELECT household_id,'taskAuthority.revoked',jsonb_build_object('policyId',id) FROM pactaris.assignment_policies WHERE state='revoked';
INSERT INTO pactaris.revocation_journal(household_id,kind,subject,occurred_at)
 SELECT household_id,'document.deleted',jsonb_build_object('documentId',id),updated_at FROM pactaris.documents WHERE state='deleted';
INSERT INTO pactaris.revocation_journal(household_id,kind,subject)
 SELECT household_id,'checkin.withdrawn',jsonb_build_object('checkinId',id) FROM pactaris.shared_checkins WHERE state='withdrawn';

-- Bounded export for the gateway. Only households of this Instance are returned.
CREATE FUNCTION pactaris.revocation_journal_pending(instance uuid,max_entries integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF instance IS NULL OR max_entries IS NULL OR max_entries NOT BETWEEN 1 AND 50 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid';
 END IF;
 RETURN jsonb_build_object('entries',coalesce((
  SELECT jsonb_agg(jsonb_build_object('id',e.id,'householdId',e.household_id,'kind',e.kind,'subject',e.subject,
    'occurredAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY e.occurred_at,e.id)
  FROM (SELECT j.* FROM pactaris.revocation_journal j JOIN pactaris.households h ON h.id=j.household_id
   WHERE j.exported_at IS NULL AND h.instance_id=instance ORDER BY j.occurred_at,j.id LIMIT max_entries) e),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION pactaris.revocation_journal_pending(uuid,integer) FROM PUBLIC;

-- Mark entries copied only after the gateway confirms durable storage.
CREATE FUNCTION pactaris.revocation_journal_ack(instance uuid,entry_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE marked integer;
BEGIN
 IF instance IS NULL OR entry_ids IS NULL OR cardinality(entry_ids) NOT BETWEEN 1 AND 50 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid';
 END IF;
 UPDATE pactaris.revocation_journal j SET exported_at=statement_timestamp()
  FROM pactaris.households h
  WHERE h.id=j.household_id AND h.instance_id=instance AND j.id=ANY(entry_ids) AND j.exported_at IS NULL;
 GET DIAGNOSTICS marked=ROW_COUNT;
 RETURN marked;
END $$;
REVOKE ALL ON FUNCTION pactaris.revocation_journal_ack(uuid,uuid[]) FROM PUBLIC;
