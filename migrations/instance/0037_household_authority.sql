-- Household authority (docs/HOUSEHOLD_AUTHORITY.md). A sub gives consent once per Dom link.
-- Within a link the Dom acts without per-item acceptance; delegations and sub ranking extend
-- that authority to other members. Every person can still pause and stop, and a sub can end
-- a link at any time. Each authorised pair is backed by a relationship, a non-expiring agreement
-- and a direct assignment policy, so existing tasks, rewards, points and notifications work
-- unchanged; activity_guard treats those backing agreements by the live authority instead of
-- per-version acceptance.
ALTER TABLE pactaris.households ADD COLUMN subs_visible boolean NOT NULL DEFAULT false,
 ADD COLUMN authority_version bigint NOT NULL DEFAULT 1;
ALTER TABLE pactaris.memberships ADD COLUMN sub_rank integer CHECK(sub_rank BETWEEN 1 AND 99);

CREATE TABLE pactaris.authority_links (
 household_id uuid NOT NULL,id uuid NOT NULL,dom_id uuid NOT NULL,sub_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'invited' CHECK(state IN ('invited','active','ended')),
 label text NOT NULL CHECK(char_length(label)<=80),
 rank_authority text NOT NULL DEFAULT 'tasks' CHECK(rank_authority IN ('off','tasks','outcomes')),
 private boolean NOT NULL DEFAULT false,version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),accepted_at timestamptz,ended_at timestamptz,ended_by uuid,
 PRIMARY KEY(household_id,id),CHECK(dom_id<>sub_id),
 FOREIGN KEY(household_id,dom_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,sub_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE UNIQUE INDEX authority_links_pair ON pactaris.authority_links(household_id,dom_id,sub_id) WHERE state<>'ended';
CREATE TABLE pactaris.authority_delegations (
 household_id uuid NOT NULL,id uuid NOT NULL,link_id uuid NOT NULL,delegate_id uuid NOT NULL,
 tasks boolean NOT NULL,outcomes boolean NOT NULL,ends_at timestamptz,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),version bigint NOT NULL DEFAULT 1,created_by uuid NOT NULL,
 PRIMARY KEY(household_id,id),CHECK(tasks OR outcomes),
 FOREIGN KEY(household_id,link_id) REFERENCES pactaris.authority_links(household_id,id),
 FOREIGN KEY(household_id,delegate_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,created_by) REFERENCES pactaris.memberships(household_id,id)
);
CREATE UNIQUE INDEX authority_delegations_active ON pactaris.authority_delegations(household_id,link_id,delegate_id) WHERE state='active';
CREATE TABLE pactaris.authority_pairs (
 household_id uuid NOT NULL,holder_id uuid NOT NULL,subject_id uuid NOT NULL,relationship_id uuid NOT NULL,agreement_id uuid NOT NULL,policy_id uuid NOT NULL,
 PRIMARY KEY(household_id,holder_id,subject_id),UNIQUE(household_id,agreement_id),
 FOREIGN KEY(household_id,relationship_id) REFERENCES pactaris.relationships(household_id,id),
 FOREIGN KEY(household_id,agreement_id) REFERENCES pactaris.agreements(household_id,id),
 FOREIGN KEY(household_id,policy_id) REFERENCES pactaris.assignment_policies(household_id,id)
);
CREATE TABLE pactaris.point_adjustments (
 household_id uuid NOT NULL,id uuid NOT NULL,recipient_id uuid NOT NULL,issuer_id uuid NOT NULL,
 points integer NOT NULL CHECK(points BETWEEN -10000 AND 10000 AND points<>0),reason text NOT NULL DEFAULT '' CHECK(char_length(reason)<=200),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(household_id,id),CHECK(recipient_id<>issuer_id),
 FOREIGN KEY(household_id,recipient_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,issuer_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX point_adjustments_recipient ON pactaris.point_adjustments(household_id,recipient_id,created_at DESC);
CREATE TABLE pactaris.authority_punishments (
 household_id uuid NOT NULL,task_id uuid NOT NULL,issuer_id uuid NOT NULL,subject_id uuid NOT NULL,exchange_id uuid,
 PRIMARY KEY(household_id,task_id),
 FOREIGN KEY(household_id,task_id) REFERENCES pactaris.partner_tasks(household_id,id),
 FOREIGN KEY(household_id,exchange_id) REFERENCES pactaris.exchanges(household_id,id)
);
CREATE TABLE pactaris.authority_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL,actor_membership_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['authority_links','authority_delegations','authority_pairs','point_adjustments','authority_punishments','authority_receipts'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',name);
 END LOOP;
END $$;

-- Does holder have authority over subject for an area? manage: own link only.
-- tasks/outcomes: own link, an active unexpired delegation, or a higher sub rank where every
-- active Dom of the subject allows rank authority for that area.
CREATE FUNCTION pactaris.authority_area(target uuid,holder uuid,subject uuid,area text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT holder IS DISTINCT FROM subject AND area IN ('manage','tasks','outcomes')
  AND EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=holder AND status='active')
  AND EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=subject AND status='active')
  AND (EXISTS(SELECT 1 FROM pactaris.authority_links l WHERE l.household_id=target AND l.state='active' AND l.dom_id=holder AND l.sub_id=subject)
   OR (area<>'manage' AND EXISTS(SELECT 1 FROM pactaris.authority_delegations d
     JOIN pactaris.authority_links l ON l.household_id=d.household_id AND l.id=d.link_id AND l.state='active'
     WHERE d.household_id=target AND d.state='active' AND d.delegate_id=holder AND l.sub_id=subject
      AND (d.ends_at IS NULL OR d.ends_at>statement_timestamp()) AND CASE WHEN area='tasks' THEN d.tasks ELSE d.outcomes END))
   OR (area<>'manage' AND EXISTS(SELECT 1 FROM pactaris.memberships hm JOIN pactaris.memberships sm ON sm.household_id=hm.household_id AND sm.id=subject
     WHERE hm.household_id=target AND hm.id=holder AND hm.sub_rank IS NOT NULL AND sm.sub_rank IS NOT NULL AND hm.sub_rank<sm.sub_rank)
    AND EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND sub_id=holder)
    AND EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND sub_id=subject)
    AND NOT EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND sub_id=subject
     AND (rank_authority='off' OR (area='outcomes' AND rank_authority<>'outcomes')))))
$$;
REVOKE ALL ON FUNCTION pactaris.authority_area(uuid,uuid,uuid,text) FROM PUBLIC;

-- Keep one backing relationship, agreement and direct policy per authorised pair.
CREATE FUNCTION pactaris.authority_sync(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;p pactaris.authority_pairs;x record;rel uuid;agr uuid;pol uuid;name text;revoked bigint;
BEGIN
 SELECT * INTO h FROM pactaris.households WHERE id=target;
 FOR p IN SELECT * FROM pactaris.authority_pairs WHERE household_id=target LOOP
  IF NOT (pactaris.authority_area(target,p.holder_id,p.subject_id,'tasks') OR pactaris.authority_area(target,p.holder_id,p.subject_id,'outcomes')) THEN
   UPDATE pactaris.assignment_policies SET state='revoked',version=version+1 WHERE household_id=target AND id=p.policy_id AND state<>'revoked' RETURNING version INTO revoked;
   IF revoked IS NOT NULL THEN INSERT INTO pactaris.assignment_policy_events VALUES(target,p.policy_id,revoked,'authorityEnded',p.holder_id,statement_timestamp()); END IF;
   UPDATE pactaris.relationships SET status='ended',ended_at=statement_timestamp(),end_reason='withdrawn',version=version+1
    WHERE household_id=target AND id=p.relationship_id AND status<>'ended';
   DELETE FROM pactaris.authority_pairs WHERE household_id=target AND holder_id=p.holder_id AND subject_id=p.subject_id;
  END IF;
 END LOOP;
 FOR x IN SELECT a.id AS holder,b.id AS subject,a.display_name AS holder_name,b.display_name AS subject_name
   FROM pactaris.memberships a JOIN pactaris.memberships b ON b.household_id=a.household_id AND b.id<>a.id AND b.status='active'
   WHERE a.household_id=target AND a.status='active'
    AND NOT EXISTS(SELECT 1 FROM pactaris.authority_pairs WHERE household_id=target AND holder_id=a.id AND subject_id=b.id)
    AND (pactaris.authority_area(target,a.id,b.id,'tasks') OR pactaris.authority_area(target,a.id,b.id,'outcomes')) LOOP
  name=coalesce(nullif((SELECT l.label FROM pactaris.authority_links l WHERE l.household_id=target AND l.state='active' AND l.dom_id=x.holder AND l.sub_id=x.subject),''),
   left(coalesce(nullif(x.holder_name,''),'?')||' → '||coalesce(nullif(x.subject_name,''),'?'),80));
  rel=gen_random_uuid();agr=gen_random_uuid();pol=gen_random_uuid();
  INSERT INTO pactaris.relationships(household_id,id,label,status,proposer_membership_id) VALUES(target,rel,name,'active',x.holder);
  INSERT INTO pactaris.relationship_participants(household_id,relationship_id,membership_id,accepted,decision,decided_at)
   VALUES(target,rel,x.holder,true,'accepted',statement_timestamp()),(target,rel,x.subject,true,'accepted',statement_timestamp());
  INSERT INTO pactaris.agreements(household_id,id,relationship_id) VALUES(target,agr,rel);
  INSERT INTO pactaris.agreement_versions(household_id,agreement_id,version,terms,expires_at,created_by)
   VALUES(target,agr,1,jsonb_build_object('label',left(name,80),'scope','','hard','','soft','','signal','','aftercare','',
    'activities',jsonb_build_array('task','protocol','reward','consequence','reminder'),'validHours',720),'2999-12-31T00:00:00Z',x.holder);
  INSERT INTO pactaris.agreement_decisions(household_id,agreement_id,version,membership_id,decision,household_epoch,member_epoch,relationship_epoch,limits_version,decided_at)
   SELECT target,agr,1,m.id,'accepted',h.safety_version,m.safety_epoch,1,coalesce((SELECT version FROM pactaris.personal_limits WHERE household_id=target AND membership_id=m.id),1),statement_timestamp()
   FROM pactaris.memberships m WHERE m.household_id=target AND m.id IN (x.holder,x.subject);
  INSERT INTO pactaris.assignment_policies(household_id,id,creator_id,assignee_id,agreement_id,agreement_version,mode,state)
   VALUES(target,pol,x.holder,x.subject,agr,1,'direct','active');
  INSERT INTO pactaris.assignment_policy_events VALUES(target,pol,1,'authorityGranted',x.holder,statement_timestamp());
  INSERT INTO pactaris.authority_pairs VALUES(target,x.holder,x.subject,rel,agr,pol);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION pactaris.authority_sync(uuid) FROM PUBLIC;

-- Balance includes manual point adjustments; otherwise identical to 0029.
CREATE OR REPLACE FUNCTION pactaris.available_reward_points(target uuid,instance uuid,actor uuid,member uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE earned bigint; spent bigint; reserved bigint; entry pactaris.reward_redemptions;
BEGIN
 SELECT coalesce(sum(g.points),0) INTO earned FROM pactaris.task_points g
  WHERE g.household_id=target AND g.recipient=member AND NOT EXISTS(SELECT 1 FROM pactaris.task_point_reversals x
   WHERE x.household_id=g.household_id AND x.task_id=g.task_id);
 SELECT earned+coalesce(sum(r.points),0) INTO earned FROM pactaris.reward_redemptions r
  JOIN pactaris.reward_point_entries e ON e.household_id=r.household_id AND e.redemption_id=r.id AND e.kind='credit'
  WHERE r.household_id=target AND r.recipient_id=member AND NOT EXISTS(SELECT 1 FROM pactaris.reward_point_entries x
    WHERE x.household_id=e.household_id AND x.redemption_id=e.redemption_id AND x.kind='reversal');
 SELECT coalesce(sum(r.points),0) INTO spent FROM pactaris.reward_redemptions r
  JOIN pactaris.reward_point_entries e ON e.household_id=r.household_id AND e.redemption_id=r.id AND e.kind='debit'
  WHERE r.household_id=target AND r.recipient_id=member AND NOT EXISTS(SELECT 1 FROM pactaris.reward_point_entries x
   WHERE x.household_id=e.household_id AND x.redemption_id=e.redemption_id AND x.kind='reversal');
 -- Manual corrections by someone with authority over this person (0037).
 SELECT earned+coalesce(sum(a.points),0) INTO earned FROM pactaris.point_adjustments a WHERE a.household_id=target AND a.recipient_id=member;
 reserved=0;
 FOR entry IN SELECT * FROM pactaris.reward_redemptions WHERE household_id=target AND recipient_id=member AND state='requested' AND expires_at>now() AND coalesce(terms->>'kind','reward')='reward' LOOP
  IF pactaris.activity_guard(target,instance,actor,member,entry.agreement_id,entry.agreement_version,'reward',entry.household_epoch) THEN
   reserved=reserved+entry.points;
  END IF;
 END LOOP;
 RETURN earned-spent-reserved;
END $$;
CREATE FUNCTION pactaris.authority_points(target uuid,member uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT greatest(0,pactaris.available_reward_points(target,h.instance_id,m.account_id,m.id)) FROM pactaris.households h
  JOIN pactaris.memberships m ON m.household_id=h.id AND m.id=member WHERE h.id=target
$$;
REVOKE ALL ON FUNCTION pactaris.authority_points(uuid,uuid) FROM PUBLIC;

-- Identical to 0008 apart from the authority-backed branch.
CREATE OR REPLACE FUNCTION pactaris.activity_guard(target uuid,instance uuid,actor uuid,member_id uuid,agreement uuid,expected_version bigint,activity text,expected_epoch bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; a pactaris.agreements; v pactaris.agreement_versions; ap pactaris.authority_pairs;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status<>'active' OR h.safety_version IS DISTINCT FROM expected_epoch OR activity IS NULL OR activity NOT IN ('task','protocol','reward','consequence','session','reminder') THEN RETURN false; END IF;
 -- Authority-backed agreement: consent was given once by linking. Live authority, membership,
 -- pause, relationship hold and blocked activities decide; per-version acceptance and expiry do not.
 SELECT * INTO ap FROM pactaris.authority_pairs WHERE household_id=target AND agreement_id=agreement;
 IF FOUND THEN
  IF expected_version IS DISTINCT FROM (SELECT version FROM pactaris.agreements WHERE household_id=target AND id=agreement) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=member_id AND account_id=actor AND status='active' AND id IN (ap.holder_id,ap.subject_id)) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM pactaris.memberships x LEFT JOIN pactaris.personal_limits l ON l.household_id=x.household_id AND l.membership_id=x.id
    WHERE x.household_id=target AND x.id IN (ap.holder_id,ap.subject_id) AND (x.status<>'active' OR x.safety_paused OR coalesce(l.limits->'blockedActivities','[]'::jsonb)?activity)) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM pactaris.relationships WHERE household_id=target AND id=ap.relationship_id AND status='active')
   OR EXISTS(SELECT 1 FROM pactaris.relationship_holds WHERE household_id=target AND relationship_id=ap.relationship_id AND paused) THEN RETURN false; END IF;
  RETURN pactaris.authority_area(target,ap.holder_id,ap.subject_id,CASE WHEN activity IN ('reward','consequence') THEN 'outcomes' ELSE 'tasks' END);
 END IF;
 SELECT * INTO a FROM pactaris.agreements WHERE household_id=target AND id=agreement AND version=expected_version;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pactaris.relationships WHERE household_id=target AND id=a.relationship_id AND status='active') OR
  NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships m ON m.household_id=p.household_id AND m.id=p.membership_id
   WHERE p.household_id=target AND p.relationship_id=a.relationship_id AND m.id=member_id AND m.account_id=actor AND m.status='active') THEN RETURN false; END IF;
 SELECT * INTO v FROM pactaris.agreement_versions WHERE household_id=target AND agreement_id=agreement AND version=expected_version;
 IF NOT FOUND OR v.revoked OR v.expires_at<=now() OR NOT (v.terms->'activities' ? activity) THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships m ON m.household_id=p.household_id AND m.id=p.membership_id
  LEFT JOIN pactaris.personal_limits l ON l.household_id=p.household_id AND l.membership_id=p.membership_id
  LEFT JOIN pactaris.relationship_holds rh ON rh.household_id=p.household_id AND rh.relationship_id=p.relationship_id AND rh.membership_id=p.membership_id
  LEFT JOIN pactaris.agreement_decisions d ON d.household_id=target AND d.agreement_id=agreement AND d.version=expected_version AND d.membership_id=p.membership_id
  WHERE p.household_id=target AND p.relationship_id=a.relationship_id AND (m.status<>'active' OR m.safety_paused OR coalesce(rh.paused,false) OR
   coalesce(l.limits->'blockedActivities','[]'::jsonb) ? activity OR d.decision IS DISTINCT FROM 'accepted' OR d.household_epoch IS DISTINCT FROM h.safety_version OR
   d.member_epoch IS DISTINCT FROM m.safety_epoch OR d.relationship_epoch IS DISTINCT FROM coalesce(rh.epoch,1) OR d.limits_version IS DISTINCT FROM coalesce(l.version,1)));
END $$;

-- A breach record is informative: recorded directly, never acknowledged.
ALTER TABLE pactaris.exchanges DROP CONSTRAINT exchanges_state_check;
ALTER TABLE pactaris.exchanges ADD CONSTRAINT exchanges_state_check CHECK(state IN ('open','recorded','approved','declined','acknowledged','withdrawn'));
ALTER TABLE pactaris.exchanges ADD CONSTRAINT exchanges_recorded_breach CHECK(state<>'recorded' OR kind='breach');
UPDATE pactaris.exchanges SET state='recorded',version=version+1 WHERE kind='breach' AND state='open';
-- Identical to 0036 apart from recorded breaches.
CREATE OR REPLACE FUNCTION pactaris.exchange_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
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
    AND (payload->>'box'='all' OR (z.state='open' AND (z.due_at IS NULL OR z.due_at>statement_timestamp()))
     OR (z.state='recorded' AND z.recipient_id=m.id AND z.created_at>statement_timestamp()-interval '7 days'))
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
  INSERT INTO pactaris.exchanges(household_id,id,kind,author_id,recipient_id,title,body,due_at,state)
   VALUES(target,operation,payload->>'kind',m.id,other.id,payload->>'title',payload->>'body',due,CASE WHEN payload->>'kind'='breach' THEN 'recorded' ELSE 'open' END) RETURNING * INTO x;
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
   IF NOT ((x.kind IN ('permission','proposal') AND payload->>'decision' IN ('approve','decline')) OR (x.kind='journal' AND payload->>'decision'='acknowledge')) THEN
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

-- Ended links and revoked delegations must stay ended after a restore.
ALTER TABLE pactaris.revocation_journal DROP CONSTRAINT revocation_journal_kind_check;
ALTER TABLE pactaris.revocation_journal ADD CONSTRAINT revocation_journal_kind_check CHECK(kind IN ('membership.ended','member.paused',
 'household.stopped','relationship.paused','relationship.ended','agreement.revoked','consent.withdrawn','taskAuthority.revoked',
 'document.deleted','attachment.deleted','checkin.withdrawn','account.erased','exchange.withdrawn','authority.ended','delegation.revoked'));
CREATE FUNCTION pactaris.journal_authority() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='authority_links' AND NEW.state='ended' AND OLD.state<>'ended' THEN
  PERFORM pactaris.journal_record(NEW.household_id,'authority.ended',jsonb_build_object('linkId',NEW.id));
 ELSIF TG_TABLE_NAME='authority_delegations' AND NEW.state='revoked' AND OLD.state<>'revoked' THEN
  PERFORM pactaris.journal_record(NEW.household_id,'delegation.revoked',jsonb_build_object('delegationId',NEW.id));
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.journal_authority() FROM PUBLIC;
CREATE TRIGGER journal_authority AFTER UPDATE OF state ON pactaris.authority_links FOR EACH ROW EXECUTE FUNCTION pactaris.journal_authority();
CREATE TRIGGER journal_authority AFTER UPDATE OF state ON pactaris.authority_delegations FOR EACH ROW EXECUTE FUNCTION pactaris.journal_authority();
-- Identical to 0036 apart from the authority branches.
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
 ELSIF entry_kind='authority.ended' THEN
  UPDATE pactaris.authority_links SET state='ended',ended_at=coalesce(ended_at,statement_timestamp()),version=version+1
   WHERE household_id=target AND id=(s->>'linkId')::uuid AND state<>'ended';
  PERFORM pactaris.authority_sync(target);
 ELSIF entry_kind='delegation.revoked' THEN
  UPDATE pactaris.authority_delegations SET state='revoked',version=version+1
   WHERE household_id=target AND id=(s->>'delegationId')::uuid AND state<>'revoked';
  PERFORM pactaris.authority_sync(target);
 ELSE
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid';
 END IF;
END $$;

-- Departure ends the member's links and delegations; erasure blanks their own text.
CREATE FUNCTION pactaris.authority_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN
  UPDATE pactaris.authority_links SET state='ended',ended_at=statement_timestamp(),ended_by=NEW.id,version=version+1
   WHERE household_id=NEW.household_id AND NEW.id IN (dom_id,sub_id) AND state<>'ended';
  UPDATE pactaris.authority_delegations SET state='revoked',version=version+1 WHERE household_id=NEW.household_id AND delegate_id=NEW.id AND state='active';
  UPDATE pactaris.memberships SET sub_rank=NULL WHERE household_id=NEW.household_id AND id=NEW.id AND sub_rank IS NOT NULL;
  PERFORM pactaris.authority_sync(NEW.household_id);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.authority_departure() FROM PUBLIC;
CREATE TRIGGER authority_departure AFTER UPDATE OF status ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.authority_departure();
CREATE FUNCTION pactaris.authority_erasure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.account_erased_at IS NOT NULL THEN
  UPDATE pactaris.authority_links SET label='',version=version+1 WHERE household_id=NEW.household_id AND dom_id=NEW.id AND label<>'';
  UPDATE pactaris.point_adjustments SET reason='' WHERE household_id=NEW.household_id AND issuer_id=NEW.id AND reason<>'';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.authority_erasure() FROM PUBLIC;
CREATE TRIGGER authority_erasure AFTER UPDATE OF account_erased_at ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.authority_erasure();

-- Personal export: links, delegations and point adjustments the person takes part in.
CREATE FUNCTION pactaris.authority_export_page(instance uuid,account uuid,after text,max_rows integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE members uuid[]; rows jsonb; last text;
BEGIN
 IF instance IS NULL OR account IS NULL OR max_rows NOT BETWEEN 1 AND 25 OR coalesce(length(after),0)>200 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account.invalid';
 END IF;
 SELECT coalesce(array_agg(m.id),'{}') INTO members FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
  WHERE h.instance_id=instance AND m.account_id=account;
 SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
  SELECT k,row FROM (
   SELECT x.household_id::text||':'||x.id::text AS k,jsonb_build_object('kind','link')||to_jsonb(x) AS row FROM pactaris.authority_links x WHERE x.dom_id=ANY(members) OR x.sub_id=ANY(members)
   UNION ALL
   SELECT d.household_id::text||':'||d.id::text,jsonb_build_object('kind','delegation')||to_jsonb(d) FROM pactaris.authority_delegations d
    JOIN pactaris.authority_links l ON l.household_id=d.household_id AND l.id=d.link_id WHERE d.delegate_id=ANY(members) OR l.dom_id=ANY(members) OR l.sub_id=ANY(members)
   UNION ALL
   SELECT a.household_id::text||':'||a.id::text,jsonb_build_object('kind','pointAdjustment')||to_jsonb(a) FROM pactaris.point_adjustments a WHERE a.recipient_id=ANY(members) OR a.issuer_id=ANY(members)
  ) all_rows WHERE k>coalesce(after,'') ORDER BY k LIMIT max_rows) r;
 rows=coalesce(rows,'[]'::jsonb);
 RETURN jsonb_build_object('section','authority','records',rows,'next',CASE WHEN jsonb_array_length(rows)=max_rows THEN last END);
END $$;
REVOKE ALL ON FUNCTION pactaris.authority_export_page(uuid,uuid,text,integer) FROM PUBLIC;

-- Existing adopted standing authority becomes a Dom link; its agreement no longer expires or needs re-acceptance.
INSERT INTO pactaris.authority_links(household_id,id,dom_id,sub_id,state,label,accepted_at)
 SELECT DISTINCT ON (p.household_id,p.creator_id,p.assignee_id) p.household_id,gen_random_uuid(),p.creator_id,p.assignee_id,'active',
  left(coalesce(v.terms->>'label',''),80),statement_timestamp()
 FROM pactaris.assignment_policies p JOIN pactaris.agreement_versions v ON v.household_id=p.household_id AND v.agreement_id=p.agreement_id AND v.version=p.agreement_version
 JOIN pactaris.memberships c ON c.household_id=p.household_id AND c.id=p.creator_id AND c.status='active'
 JOIN pactaris.memberships s ON s.household_id=p.household_id AND s.id=p.assignee_id AND s.status='active'
 WHERE p.state='active' ORDER BY p.household_id,p.creator_id,p.assignee_id,p.id;
INSERT INTO pactaris.authority_pairs(household_id,holder_id,subject_id,relationship_id,agreement_id,policy_id)
 SELECT DISTINCT ON (p.household_id,p.creator_id,p.assignee_id) p.household_id,p.creator_id,p.assignee_id,a.relationship_id,p.agreement_id,p.id
 FROM pactaris.assignment_policies p JOIN pactaris.agreements a ON a.household_id=p.household_id AND a.id=p.agreement_id AND a.version=p.agreement_version
 JOIN pactaris.authority_links l ON l.household_id=p.household_id AND l.dom_id=p.creator_id AND l.sub_id=p.assignee_id AND l.state='active'
 WHERE p.state='active' AND (SELECT count(*) FROM pactaris.relationship_participants r WHERE r.household_id=a.household_id AND r.relationship_id=a.relationship_id)=2
 ORDER BY p.household_id,p.creator_id,p.assignee_id,p.id
 ON CONFLICT DO NOTHING;
-- Links without a reusable two-person agreement get a fresh backing set.
SELECT pactaris.authority_sync(id) FROM pactaris.households WHERE EXISTS(SELECT 1 FROM pactaris.authority_links l WHERE l.household_id=households.id AND l.state='active');

CREATE FUNCTION pactaris.authority_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;other pactaris.memberships;l pactaris.authority_links;d pactaris.authority_delegations;
 prior pactaris.authority_receipts;pair pactaris.authority_pairs;answer jsonb;resource uuid;links jsonb;delegations jsonb;members jsonb;powers jsonb;
 adjustments jsonb;ends timestamptz;policy_version bigint;involved boolean;
BEGIN
 IF action IS NULL OR action NOT IN ('authorityList','linkInvite','linkAccept','linkDecline','linkEnd','linkSettings','delegationSet','delegationRevoke',
   'rankSet','visibilitySet','pointsAdjust','punishmentGive') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.authority.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;

 IF action='authorityList' THEN
  involved=EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND m.id IN (dom_id,sub_id));
  SELECT coalesce(jsonb_agg(jsonb_build_object('linkId',x.id,'domId',x.dom_id,'domName',dm.display_name,'subId',x.sub_id,'subName',sm.display_name,
    'state',x.state,'label',x.label,'rankAuthority',x.rank_authority,'private',x.private,'version',x.version::text,
    'role',CASE WHEN x.dom_id=m.id THEN 'dom' WHEN x.sub_id=m.id THEN 'sub' ELSE 'viewer' END) ORDER BY x.created_at,x.id),'[]'::jsonb) INTO links
   FROM (SELECT * FROM pactaris.authority_links z WHERE z.household_id=target AND z.state<>'ended'
    AND (m.id IN (z.dom_id,z.sub_id)
     OR EXISTS(SELECT 1 FROM pactaris.authority_delegations e WHERE e.household_id=target AND e.link_id=z.id AND e.delegate_id=m.id AND e.state='active')
     OR (z.state='active' AND h.subs_visible AND NOT z.private AND involved))
    ORDER BY z.created_at,z.id LIMIT 100) x
   JOIN pactaris.memberships dm ON dm.household_id=target AND dm.id=x.dom_id JOIN pactaris.memberships sm ON sm.household_id=target AND sm.id=x.sub_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('delegationId',e.id,'linkId',e.link_id,'delegateId',e.delegate_id,'delegateName',dm.display_name,
    'tasks',e.tasks,'outcomes',e.outcomes,'endsAt',e.ends_at,'version',e.version::text) ORDER BY e.id),'[]'::jsonb) INTO delegations
   FROM pactaris.authority_delegations e JOIN pactaris.authority_links z ON z.household_id=e.household_id AND z.id=e.link_id AND z.state='active'
   JOIN pactaris.memberships dm ON dm.household_id=e.household_id AND dm.id=e.delegate_id
   WHERE e.household_id=target AND e.state='active' AND m.id IN (z.dom_id,z.sub_id,e.delegate_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',o.id,'name',o.display_name,'owner',o.technical_role='owner',
    'rank',CASE WHEN o.id=m.id OR (h.subs_visible AND involved) OR pactaris.authority_area(target,m.id,o.id,'tasks') OR pactaris.authority_area(target,m.id,o.id,'manage') THEN o.sub_rank END) ORDER BY o.display_name,o.id),'[]'::jsonb) INTO members
   FROM (SELECT * FROM pactaris.memberships WHERE household_id=target AND status='active' ORDER BY display_name,id LIMIT 100) o;
  SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',o.id,'tasks',pactaris.authority_area(target,m.id,o.id,'tasks'),
    'outcomes',pactaris.authority_area(target,m.id,o.id,'outcomes'),'manage',pactaris.authority_area(target,m.id,o.id,'manage'),
    'points',pactaris.authority_points(target,o.id)::text) ORDER BY o.id),'[]'::jsonb) INTO powers
   FROM pactaris.memberships o WHERE o.household_id=target AND o.status='active' AND o.id<>m.id
    AND (pactaris.authority_area(target,m.id,o.id,'tasks') OR pactaris.authority_area(target,m.id,o.id,'outcomes'));
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'recipientId',a.recipient_id,'issuerId',a.issuer_id,'points',a.points,'reason',a.reason,'createdAt',a.created_at) ORDER BY a.created_at DESC),'[]'::jsonb) INTO adjustments
   FROM (SELECT * FROM pactaris.point_adjustments WHERE household_id=target AND m.id IN (recipient_id,issuer_id) ORDER BY created_at DESC LIMIT 10) a;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','links',links,'delegations',delegations,
   'members',members,'powers',powers,'adjustments',adjustments,'subsVisible',h.subs_visible,'settingsVersion',h.authority_version::text,
   'canSetVisibility',m.technical_role='owner','myPoints',pactaris.authority_points(target,m.id)::text,'myRank',m.sub_rank);
 END IF;

 SELECT * INTO prior FROM pactaris.authority_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.actor_membership_id<>m.id OR prior.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  RETURN prior.result;
 END IF;

 IF action='linkInvite' THEN
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'subId')::uuid AND status='active';
  IF NOT FOUND OR other.id=m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF h.status<>'active' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state<>'ended' AND dom_id=m.id AND sub_id=other.id) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  IF (SELECT count(*) FROM pactaris.authority_links WHERE household_id=target AND state<>'ended')>=100 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.capacity'; END IF;
  INSERT INTO pactaris.authority_links(household_id,id,dom_id,sub_id,label) VALUES(target,operation,m.id,other.id,payload->>'label');
  resource=operation;
 ELSIF action IN ('linkAccept','linkDecline','linkEnd','linkSettings') THEN
  SELECT * INTO l FROM pactaris.authority_links WHERE household_id=target AND id=(payload->>'linkId')::uuid FOR UPDATE;
  IF NOT FOUND OR (action IN ('linkAccept','linkDecline') AND l.sub_id<>m.id) OR (action='linkSettings' AND l.dom_id<>m.id) OR (action='linkEnd' AND m.id NOT IN (l.dom_id,l.sub_id)) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF l.version::text IS DISTINCT FROM payload->>'version' OR l.state='ended' OR (action IN ('linkAccept','linkDecline') AND l.state<>'invited') OR (action='linkSettings' AND l.state<>'active') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  IF action='linkAccept' THEN
   IF h.status<>'active' OR m.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
   UPDATE pactaris.authority_links SET state='active',accepted_at=statement_timestamp(),version=version+1 WHERE household_id=target AND id=l.id;
  ELSIF action='linkSettings' THEN
   UPDATE pactaris.authority_links SET rank_authority=payload->>'rankAuthority',private=(payload->>'private')::boolean,version=version+1 WHERE household_id=target AND id=l.id;
  ELSE
   -- Ending or declining is always possible, also during a pause.
   UPDATE pactaris.authority_links SET state='ended',ended_at=statement_timestamp(),ended_by=m.id,version=version+1 WHERE household_id=target AND id=l.id;
  END IF;
  resource=l.id;
 ELSIF action='delegationSet' THEN
  SELECT * INTO l FROM pactaris.authority_links WHERE household_id=target AND id=(payload->>'linkId')::uuid AND dom_id=m.id AND state='active';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'delegateId')::uuid AND status='active';
  IF NOT FOUND OR other.id IN (l.dom_id,l.sub_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  ends=(payload->>'endsAt')::timestamptz;
  IF ends IS NOT NULL AND ends<=statement_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid'; END IF;
  SELECT * INTO d FROM pactaris.authority_delegations WHERE household_id=target AND link_id=l.id AND delegate_id=other.id AND state='active' FOR UPDATE;
  IF coalesce(d.version,0)::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  IF d.id IS NULL THEN
   INSERT INTO pactaris.authority_delegations(household_id,id,link_id,delegate_id,tasks,outcomes,ends_at,created_by)
    VALUES(target,operation,l.id,other.id,(payload->>'tasks')::boolean,(payload->>'outcomes')::boolean,ends,m.id);
   resource=operation;
  ELSE
   UPDATE pactaris.authority_delegations SET tasks=(payload->>'tasks')::boolean,outcomes=(payload->>'outcomes')::boolean,ends_at=ends,version=version+1
    WHERE household_id=target AND id=d.id;
   resource=d.id;
  END IF;
 ELSIF action='delegationRevoke' THEN
  SELECT e.* INTO d FROM pactaris.authority_delegations e JOIN pactaris.authority_links z ON z.household_id=e.household_id AND z.id=e.link_id
   WHERE e.household_id=target AND e.id=(payload->>'delegationId')::uuid AND m.id IN (z.dom_id,z.sub_id,e.delegate_id) FOR UPDATE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF d.version::text IS DISTINCT FROM payload->>'version' OR d.state<>'active' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  UPDATE pactaris.authority_delegations SET state='revoked',version=version+1 WHERE household_id=target AND id=d.id;
  resource=d.id;
 ELSIF action='rankSet' THEN
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'subjectId')::uuid AND status='active';
  IF NOT FOUND OR NOT (m.technical_role='owner' OR pactaris.authority_area(target,m.id,other.id,'manage')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF (payload->>'rank') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND sub_id=other.id) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  UPDATE pactaris.memberships SET sub_rank=(payload->>'rank')::integer WHERE household_id=target AND id=other.id;
  resource=other.id;
 ELSIF action='visibilitySet' THEN
  IF m.technical_role<>'owner' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF h.authority_version::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  UPDATE pactaris.households SET subs_visible=(payload->>'subsVisible')::boolean,authority_version=authority_version+1 WHERE id=target;
  resource=target;
 ELSE
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'subjectId')::uuid AND status='active';
  IF NOT FOUND OR NOT pactaris.authority_area(target,m.id,other.id,'outcomes') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF h.status<>'active' OR m.safety_paused OR other.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF EXISTS(SELECT 1 FROM pactaris.personal_limits WHERE household_id=target AND membership_id=other.id AND coalesce(limits->'blockedActivities','[]'::jsonb)?'consequence')
   AND action='punishmentGive' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF action='pointsAdjust' THEN
   IF NOT h.points_enabled THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
   INSERT INTO pactaris.point_adjustments(household_id,id,recipient_id,issuer_id,points,reason)
    VALUES(target,operation,other.id,m.id,(payload->>'points')::integer,payload->>'reason');
  ELSE
   IF payload->>'exchangeId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pactaris.exchanges WHERE household_id=target AND id=(payload->>'exchangeId')::uuid
     AND kind='breach' AND author_id=m.id AND recipient_id=other.id AND state<>'withdrawn') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
   PERFORM pactaris.authority_sync(target);
   SELECT * INTO pair FROM pactaris.authority_pairs WHERE household_id=target AND holder_id=m.id AND subject_id=other.id;
   SELECT version INTO policy_version FROM pactaris.assignment_policies WHERE household_id=target AND id=pair.policy_id AND state='active';
   IF pair.policy_id IS NULL OR policy_version IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
   -- A punishment is an ordinary task, assigned directly, with the usual inbox notice.
   INSERT INTO pactaris.partner_receipts VALUES(operation,target,m.id,fingerprint,jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','taskId',operation));
   INSERT INTO pactaris.partner_tasks(household_id,id,creator_id,assignee_id,agreement_id,agreement_version,fields,policy_id,policy_version,state)
    VALUES(target,operation,m.id,other.id,pair.agreement_id,1,jsonb_build_object('title',payload->>'title','description',payload->>'description','priority','normal','dueAt',NULL),
     pair.policy_id,policy_version,'assigned');
   INSERT INTO pactaris.partner_events(household_id,task_id,version,action,actor_id,note) VALUES(target,operation,1,'partnerAssign',m.id,'');
   INSERT INTO pactaris.authority_punishments VALUES(target,operation,m.id,other.id,(payload->>'exchangeId')::uuid);
   INSERT INTO pactaris.partner_outbox VALUES(operation,target,'partner.partnerAssign',now());
  END IF;
  resource=operation;
 END IF;
 IF action IN ('linkAccept','linkDecline','linkEnd','linkSettings','delegationSet','delegationRevoke','rankSet') THEN PERFORM pactaris.authority_sync(target); END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','resourceId',resource);
 INSERT INTO pactaris.authority_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'authority.'||action,resource,jsonb_build_object('operationId',operation));
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.authority_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
