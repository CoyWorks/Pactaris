-- Exchanges between two members of an active standing authority (docs/DYNAMIC_EXCHANGES.md):
-- permission requests and journal entries go from the person under authority to the holder,
-- rule breaches from the holder to that person, proposals either way. A role label never grants
-- this; only an adopted, active assignment policy in an active, unheld relationship does.
-- Nothing here assigns work, moves points or runs a consequence.
CREATE TABLE pactaris.exchanges (
 household_id uuid NOT NULL,id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('permission','proposal','journal','breach')),
 author_id uuid NOT NULL,recipient_id uuid NOT NULL,
 title text NOT NULL,body text NOT NULL DEFAULT '',due_at timestamptz,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','approved','declined','acknowledged','withdrawn')),
 response text CHECK(char_length(response)<=500),
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT statement_timestamp(),responded_at timestamptz,
 PRIMARY KEY(household_id,id),CHECK(author_id<>recipient_id),
 FOREIGN KEY(household_id,author_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,recipient_id) REFERENCES pactaris.memberships(household_id,id),
 CHECK(char_length(body)<=600),CHECK(due_at IS NULL OR kind='permission'),
 CHECK((state='withdrawn' AND title='' AND body='' AND response IS NULL) OR (state<>'withdrawn' AND char_length(title) BETWEEN 1 AND 120)),
 CHECK(state NOT IN ('approved','declined') OR kind IN ('permission','proposal')),
 CHECK(state<>'acknowledged' OR kind IN ('journal','breach'))
);
CREATE INDEX exchanges_author ON pactaris.exchanges(household_id,author_id,created_at DESC);
CREATE INDEX exchanges_recipient ON pactaris.exchanges(household_id,recipient_id,created_at DESC);
CREATE TABLE pactaris.exchange_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL,actor_membership_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
-- Agreed review rhythm for an agreement; reminders only, no effect on its validity.
CREATE TABLE pactaris.agreement_reviews (
 household_id uuid NOT NULL,agreement_id uuid NOT NULL,interval_months integer CHECK(interval_months BETWEEN 1 AND 24),
 next_review date,last_reviewed date,version bigint NOT NULL DEFAULT 1,updated_by uuid NOT NULL,
 PRIMARY KEY(household_id,agreement_id),CHECK((interval_months IS NULL)=(next_review IS NULL)),
 FOREIGN KEY(household_id,agreement_id) REFERENCES pactaris.agreements(household_id,id),
 FOREIGN KEY(household_id,updated_by) REFERENCES pactaris.memberships(household_id,id)
);
-- Household words for navigation sections, shown instead of the catalog defaults.
CREATE TABLE pactaris.household_terms (
 household_id uuid PRIMARY KEY REFERENCES pactaris.households(id),terms jsonb NOT NULL DEFAULT '{}',version bigint NOT NULL DEFAULT 1,
 CHECK(jsonb_typeof(terms)='object' AND octet_length(terms::text)<=1024)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['exchanges','exchange_receipts','agreement_reviews','household_terms'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',name);
 END LOOP;
END $$;

-- holder has an active, adopted standing authority over subject in an active relationship
-- that neither participant has paused.
CREATE FUNCTION pactaris.exchange_authority(target uuid,holder uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM pactaris.assignment_policies p
  JOIN pactaris.agreements a ON a.household_id=p.household_id AND a.id=p.agreement_id
  JOIN pactaris.relationships r ON r.household_id=a.household_id AND r.id=a.relationship_id AND r.status='active'
  WHERE p.household_id=target AND p.state='active' AND p.creator_id=holder AND p.assignee_id=subject
   AND NOT EXISTS(SELECT 1 FROM pactaris.relationship_holds x WHERE x.household_id=target AND x.relationship_id=r.id AND x.paused))
$$;
REVOKE ALL ON FUNCTION pactaris.exchange_authority(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.exchange_allowed(target uuid,kind text,author uuid,recipient uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT CASE kind
  WHEN 'permission' THEN pactaris.exchange_authority(target,recipient,author)
  WHEN 'journal' THEN pactaris.exchange_authority(target,recipient,author)
  WHEN 'breach' THEN pactaris.exchange_authority(target,author,recipient)
  WHEN 'proposal' THEN pactaris.exchange_authority(target,recipient,author) OR pactaris.exchange_authority(target,author,recipient)
  ELSE false END
$$;
REVOKE ALL ON FUNCTION pactaris.exchange_allowed(uuid,text,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.exchange_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;other pactaris.memberships;x pactaris.exchanges;prior pactaris.exchange_receipts;
 rv pactaris.agreement_reviews;answer jsonb;items jsonb;people jsonb;cursor text;resource uuid;today date;months integer;due timestamptz;
BEGIN
 IF action IS NULL OR action NOT IN ('exchangeList','exchangeCreate','exchangeDecide','exchangeWithdraw','reviewList','reviewSet','reviewDone','termsGet','termsSet')
  OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.exchange.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
 today=(statement_timestamp() AT TIME ZONE h.time_zone)::date;

 IF action='exchangeList' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',o.id,'name',o.display_name,
    'holder',pactaris.exchange_authority(target,o.id,m.id),'subject',pactaris.exchange_authority(target,m.id,o.id)) ORDER BY o.display_name,o.id),'[]'::jsonb)
   INTO people FROM pactaris.memberships o WHERE o.household_id=target AND o.status='active' AND o.id<>m.id
    AND (pactaris.exchange_authority(target,o.id,m.id) OR pactaris.exchange_authority(target,m.id,o.id));
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',y.id,'kind',y.kind,'mine',y.author_id=m.id,
    'counterpartId',CASE WHEN y.author_id=m.id THEN y.recipient_id ELSE y.author_id END,
    'counterpartName',(SELECT o.display_name FROM pactaris.memberships o WHERE o.household_id=target AND o.id=CASE WHEN y.author_id=m.id THEN y.recipient_id ELSE y.author_id END),
    'title',y.title,'body',y.body,'dueAt',y.due_at,
    'state',CASE WHEN y.state='open' AND y.due_at<=statement_timestamp() THEN 'expired' ELSE y.state END,
    'response',y.response,'createdAt',y.created_at,'respondedAt',y.responded_at,'version',y.version::text,
    'cursor',to_char(y.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||'|'||y.id::text) ORDER BY y.created_at DESC,y.id DESC),'[]'::jsonb)
   INTO items FROM (SELECT z.* FROM pactaris.exchanges z WHERE z.household_id=target AND z.state<>'withdrawn'
    AND (z.author_id=m.id OR z.recipient_id=m.id)
    AND (payload->>'box'='all' OR (z.state='open' AND (z.due_at IS NULL OR z.due_at>statement_timestamp())))
    AND (payload->>'before' IS NULL OR (z.created_at,z.id)<((split_part(payload->>'before','|',1))::timestamptz,(split_part(payload->>'before','|',2))::uuid))
    ORDER BY z.created_at DESC,z.id DESC LIMIT 9) y;
  IF jsonb_array_length(items)>8 THEN cursor=items->7->>'cursor';items=items-8;END IF;
  SELECT coalesce(jsonb_agg(e-'cursor'),'[]'::jsonb) INTO items FROM jsonb_array_elements(items) e;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','exchanges',items,'people',people,'nextCursor',cursor);
 END IF;

 IF action='reviewList' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('agreementId',a.id,'relationshipLabel',r.label,'intervalMonths',v.interval_months,
    'nextReview',v.next_review,'lastReviewed',v.last_reviewed,'version',coalesce(v.version,0)::text,
    'due',coalesce(v.next_review<=today+7,false)) ORDER BY r.label,a.id),'[]'::jsonb) INTO items
   FROM pactaris.agreements a
   JOIN pactaris.relationships r ON r.household_id=a.household_id AND r.id=a.relationship_id AND r.status='active'
   JOIN pactaris.relationship_participants p ON p.household_id=r.household_id AND p.relationship_id=r.id AND p.membership_id=m.id AND p.decision='accepted'
   LEFT JOIN pactaris.agreement_reviews v ON v.household_id=a.household_id AND v.agreement_id=a.id
   WHERE a.household_id=target;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','reviews',items);
 END IF;

 IF action='termsGet' THEN
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed',
   'terms',coalesce((SELECT terms FROM pactaris.household_terms WHERE household_id=target),'{}'::jsonb),
   'termsVersion',coalesce((SELECT version FROM pactaris.household_terms WHERE household_id=target),0)::text,
   'canEdit',m.technical_role IN ('owner','admin'));
 END IF;

 SELECT * INTO prior FROM pactaris.exchange_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.actor_membership_id<>m.id OR prior.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.conflict'; END IF;
  RETURN prior.result;
 END IF;

 IF action='exchangeCreate' THEN
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'recipientId')::uuid AND status='active';
  IF NOT FOUND OR other.id=m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
  IF h.status<>'active' OR m.safety_paused OR other.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.paused'; END IF;
  IF NOT pactaris.exchange_allowed(target,payload->>'kind',m.id,other.id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
  due=(payload->>'dueAt')::timestamptz;
  IF due IS NOT NULL AND (payload->>'kind'<>'permission' OR due<=statement_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
  IF (SELECT count(*) FROM pactaris.exchanges WHERE household_id=target AND author_id=m.id AND state='open')>=50 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.capacity'; END IF;
  INSERT INTO pactaris.exchanges(household_id,id,kind,author_id,recipient_id,title,body,due_at)
   VALUES(target,operation,payload->>'kind',m.id,other.id,payload->>'title',payload->>'body',due) RETURNING * INTO x;
  resource=x.id;
 ELSIF action IN ('exchangeDecide','exchangeWithdraw') THEN
  SELECT * INTO x FROM pactaris.exchanges WHERE household_id=target AND id=(payload->>'exchangeId')::uuid
   AND ((action='exchangeDecide' AND recipient_id=m.id) OR (action='exchangeWithdraw' AND author_id=m.id)) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
  IF x.version::text IS DISTINCT FROM payload->>'version' OR x.state='withdrawn' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.conflict'; END IF;
  IF action='exchangeWithdraw' THEN
   -- Requests and proposals can be withdrawn while open; journal entries and breach records by their author at any time.
   IF x.kind IN ('permission','proposal') AND x.state<>'open' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.conflict'; END IF;
   UPDATE pactaris.exchanges SET state='withdrawn',title='',body='',response=NULL,due_at=NULL,version=version+1
    WHERE household_id=target AND id=x.id;
  ELSE
   IF x.state<>'open' OR x.due_at<=statement_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.conflict'; END IF;
   IF NOT ((x.kind IN ('permission','proposal') AND payload->>'decision' IN ('approve','decline')) OR (x.kind IN ('journal','breach') AND payload->>'decision'='acknowledge')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   IF h.status<>'active' OR m.safety_paused OR EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=x.author_id AND (status<>'active' OR safety_paused)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.paused'; END IF;
   IF NOT pactaris.exchange_allowed(target,x.kind,x.author_id,x.recipient_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
   UPDATE pactaris.exchanges SET state=CASE payload->>'decision' WHEN 'approve' THEN 'approved' WHEN 'decline' THEN 'declined' ELSE 'acknowledged' END,
    response=nullif(payload->>'response',''),responded_at=statement_timestamp(),version=version+1 WHERE household_id=target AND id=x.id;
  END IF;
  resource=x.id;
 ELSIF action IN ('reviewSet','reviewDone') THEN
  IF NOT EXISTS(SELECT 1 FROM pactaris.agreements a
    JOIN pactaris.relationships r ON r.household_id=a.household_id AND r.id=a.relationship_id AND r.status='active'
    JOIN pactaris.relationship_participants p ON p.household_id=r.household_id AND p.relationship_id=r.id AND p.membership_id=m.id AND p.decision='accepted'
    WHERE a.household_id=target AND a.id=(payload->>'agreementId')::uuid) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
  SELECT * INTO rv FROM pactaris.agreement_reviews WHERE household_id=target AND agreement_id=(payload->>'agreementId')::uuid FOR UPDATE;
  IF coalesce(rv.version,0)::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.conflict'; END IF;
  IF action='reviewSet' THEN
   months=(payload->>'intervalMonths')::integer;
   INSERT INTO pactaris.agreement_reviews(household_id,agreement_id,interval_months,next_review,updated_by)
    VALUES(target,(payload->>'agreementId')::uuid,months,CASE WHEN months IS NULL THEN NULL ELSE (today+make_interval(months=>months))::date END,m.id)
    ON CONFLICT(household_id,agreement_id) DO UPDATE SET interval_months=EXCLUDED.interval_months,
     next_review=CASE WHEN EXCLUDED.interval_months IS NULL THEN NULL ELSE (coalesce(pactaris.agreement_reviews.last_reviewed,today)+make_interval(months=>EXCLUDED.interval_months))::date END,
     version=pactaris.agreement_reviews.version+1,updated_by=m.id;
  ELSE
   IF rv.interval_months IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.conflict'; END IF;
   UPDATE pactaris.agreement_reviews SET last_reviewed=today,next_review=(today+make_interval(months=>interval_months))::date,version=version+1,updated_by=m.id
    WHERE household_id=target AND agreement_id=rv.agreement_id;
  END IF;
  resource=(payload->>'agreementId')::uuid;
 ELSE
  IF m.technical_role NOT IN ('owner','admin') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
  IF jsonb_typeof(payload->'terms')<>'object' OR EXISTS(SELECT 1 FROM jsonb_each(payload->'terms') t
    WHERE t.key NOT IN ('tasks','routines','library','dynamic') OR jsonb_typeof(t.value)<>'string' OR char_length(t.value#>>'{}') NOT BETWEEN 1 AND 24) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
  IF coalesce((SELECT version FROM pactaris.household_terms WHERE household_id=target),0)::text IS DISTINCT FROM payload->>'version' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.conflict'; END IF;
  INSERT INTO pactaris.household_terms(household_id,terms) VALUES(target,payload->'terms')
   ON CONFLICT(household_id) DO UPDATE SET terms=EXCLUDED.terms,version=pactaris.household_terms.version+1;
  resource=target;
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','exchangeId',CASE WHEN action LIKE 'exchange%' THEN resource END);
 INSERT INTO pactaris.exchange_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'exchange.'||action,resource,jsonb_build_object('operationId',operation));
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.exchange_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

-- Account erasure: this person's exchanges are withdrawn and their responses blanked.
CREATE FUNCTION pactaris.exchange_erasure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.account_erased_at IS NOT NULL THEN
  UPDATE pactaris.exchanges SET state='withdrawn',title='',body='',response=NULL,due_at=NULL,version=version+1
   WHERE household_id=NEW.household_id AND author_id=NEW.id AND state<>'withdrawn';
  UPDATE pactaris.exchanges SET response='',version=version+1
   WHERE household_id=NEW.household_id AND recipient_id=NEW.id AND response<>'';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.exchange_erasure() FROM PUBLIC;
CREATE TRIGGER exchange_erasure AFTER UPDATE OF account_erased_at ON pactaris.memberships
 FOR EACH ROW EXECUTE FUNCTION pactaris.exchange_erasure();

-- Withdrawn text must not come back from a restored backup.
ALTER TABLE pactaris.revocation_journal DROP CONSTRAINT revocation_journal_kind_check;
ALTER TABLE pactaris.revocation_journal ADD CONSTRAINT revocation_journal_kind_check CHECK(kind IN ('membership.ended','member.paused',
 'household.stopped','relationship.paused','relationship.ended','agreement.revoked','consent.withdrawn','taskAuthority.revoked',
 'document.deleted','attachment.deleted','checkin.withdrawn','account.erased','exchange.withdrawn'));
CREATE FUNCTION pactaris.journal_exchange() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.state='withdrawn' AND OLD.state<>'withdrawn' THEN
  PERFORM pactaris.journal_record(NEW.household_id,'exchange.withdrawn',jsonb_build_object('exchangeId',NEW.id));
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.journal_exchange() FROM PUBLIC;
CREATE TRIGGER journal_exchange AFTER UPDATE OF state ON pactaris.exchanges
 FOR EACH ROW EXECUTE FUNCTION pactaris.journal_exchange();

-- Personal export: exchanges the person wrote or received.
CREATE FUNCTION pactaris.exchange_export_page(instance uuid,account uuid,after text,max_rows integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE members uuid[]; rows jsonb; last text;
BEGIN
 IF instance IS NULL OR account IS NULL OR max_rows NOT BETWEEN 1 AND 25 OR coalesce(length(after),0)>200 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account.invalid';
 END IF;
 SELECT coalesce(array_agg(m.id),'{}') INTO members FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
  WHERE h.instance_id=instance AND m.account_id=account;
 SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
  SELECT x.household_id::text||':'||x.id::text AS k,to_jsonb(x) AS row
  FROM pactaris.exchanges x WHERE (x.author_id=ANY(members) OR x.recipient_id=ANY(members)) AND x.state<>'withdrawn'
   AND x.household_id::text||':'||x.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 rows=coalesce(rows,'[]'::jsonb);
 RETURN jsonb_build_object('section','exchanges','records',rows,'next',CASE WHEN jsonb_array_length(rows)=max_rows THEN last END);
END $$;
REVOKE ALL ON FUNCTION pactaris.exchange_export_page(uuid,uuid,text,integer) FROM PUBLIC;

-- Replay of an exchange withdrawal; identical to 0034 apart from the new branch.
CREATE OR REPLACE FUNCTION pactaris.journal_apply(target uuid,entry_kind text,s jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE p pactaris.assignment_policies; doc uuid; home uuid;
BEGIN
 IF entry_kind='account.erased' THEN
  SELECT instance_id INTO home FROM pactaris.households WHERE id=target;
  PERFORM pactaris.account_erasure(home,(s->>'accountId')::uuid,'forced');
  RETURN;
 END IF;
 IF entry_kind='membership.ended' THEN
  IF s->>'status' NOT IN ('left','revoked') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid'; END IF;
  UPDATE pactaris.memberships SET status=s->>'status'
   WHERE household_id=target AND id=(s->>'membershipId')::uuid AND status NOT IN ('left','revoked');
 ELSIF entry_kind='member.paused' THEN
  UPDATE pactaris.memberships SET safety_paused=true,safety_epoch=safety_epoch+1
   WHERE household_id=target AND id=(s->>'membershipId')::uuid AND NOT safety_paused;
 ELSIF entry_kind='household.stopped' THEN
  IF s->>'status'='closed' THEN
   UPDATE pactaris.households SET status='closed' WHERE id=target AND status<>'closed';
  ELSE
   UPDATE pactaris.households SET status='paused',safety_version=safety_version+1 WHERE id=target AND status='active';
  END IF;
 ELSIF entry_kind='relationship.paused' THEN
  IF EXISTS(SELECT 1 FROM pactaris.relationship_participants WHERE household_id=target
     AND relationship_id=(s->>'relationshipId')::uuid AND membership_id=(s->>'membershipId')::uuid) THEN
   INSERT INTO pactaris.relationship_holds(household_id,relationship_id,membership_id,paused,epoch)
    VALUES(target,(s->>'relationshipId')::uuid,(s->>'membershipId')::uuid,true,2)
    ON CONFLICT(household_id,relationship_id,membership_id) DO UPDATE SET paused=true,epoch=pactaris.relationship_holds.epoch+1
    WHERE NOT pactaris.relationship_holds.paused;
  END IF;
 ELSIF entry_kind='relationship.ended' THEN
  UPDATE pactaris.relationships SET status='ended',ended_at=coalesce(ended_at,statement_timestamp()),
   end_reason=CASE WHEN s->>'reason' IN ('declined','withdrawn','membershipEnded') THEN s->>'reason' ELSE 'withdrawn' END
   WHERE household_id=target AND id=(s->>'relationshipId')::uuid AND status<>'ended';
 ELSIF entry_kind='agreement.revoked' THEN
  UPDATE pactaris.agreement_versions SET revoked=true
   WHERE household_id=target AND agreement_id=(s->>'agreementId')::uuid AND version=(s->>'version')::bigint AND NOT revoked;
 ELSIF entry_kind='consent.withdrawn' THEN
  IF s->>'decision' NOT IN ('declined','withdrawn') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid'; END IF;
  UPDATE pactaris.agreement_decisions SET decision=s->>'decision',decided_at=coalesce(decided_at,statement_timestamp())
   WHERE household_id=target AND agreement_id=(s->>'agreementId')::uuid AND version=(s->>'version')::bigint
    AND membership_id=(s->>'membershipId')::uuid AND decision NOT IN ('declined','withdrawn');
 ELSIF entry_kind='taskAuthority.revoked' THEN
  FOR p IN UPDATE pactaris.assignment_policies SET state='revoked',version=version+1
   WHERE household_id=target AND id=(s->>'policyId')::uuid AND state<>'revoked' RETURNING * LOOP
   INSERT INTO pactaris.assignment_policy_events VALUES(p.household_id,p.id,p.version,'restoreReplay',p.creator_id,statement_timestamp());
  END LOOP;
 ELSIF entry_kind='document.deleted' THEN
  doc=(s->>'documentId')::uuid;
  IF EXISTS(SELECT 1 FROM pactaris.documents WHERE household_id=target AND id=doc AND state<>'deleted') THEN
   DELETE FROM pactaris.document_assignments WHERE household_id=target AND document_id=doc;
   DELETE FROM pactaris.document_acknowledgements WHERE household_id=target AND document_id=doc;
   DELETE FROM pactaris.document_versions WHERE household_id=target AND document_id=doc;
   UPDATE pactaris.documents SET state='deleted',version=version+1,updated_at=statement_timestamp() WHERE household_id=target AND id=doc;
  END IF;
 ELSIF entry_kind='attachment.deleted' THEN
  DELETE FROM pactaris.draft_attachments WHERE household_id=target AND document_id=(s->>'documentId')::uuid;
 ELSIF entry_kind='checkin.withdrawn' THEN
  UPDATE pactaris.shared_checkins SET state='withdrawn',response=NULL,title=id::text,version=version+1
   WHERE household_id=target AND id=(s->>'checkinId')::uuid AND state<>'withdrawn';
 ELSIF entry_kind='exchange.withdrawn' THEN
  UPDATE pactaris.exchanges SET state='withdrawn',title='',body='',response=NULL,due_at=NULL,version=version+1
   WHERE household_id=target AND id=(s->>'exchangeId')::uuid AND state<>'withdrawn';
 ELSE
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid';
 END IF;
END $$;
