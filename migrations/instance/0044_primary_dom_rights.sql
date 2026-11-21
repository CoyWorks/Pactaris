-- Primary Dom and rights (owner decision, 21 November 2026; docs/HOUSEHOLD_AUTHORITY.md).
-- Every sub has exactly one primary Dom, who alone has all rights over the sub by default. The primary
-- Dom delegates separate rights (create tasks, approve tasks, points and punishments) to members ranked
-- above the sub. Rank by itself no longer grants anything. The role moves by a transfer the current
-- primary Dom proposes and that both the new Dom and the sub accept.
ALTER TABLE pactaris.authority_links ADD COLUMN is_primary boolean NOT NULL DEFAULT false,
 ADD COLUMN legacy_full boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX authority_links_primary ON pactaris.authority_links(household_id,sub_id) WHERE is_primary AND state='active';
COMMENT ON COLUMN pactaris.authority_links.rank_authority IS 'Unused since 0044: rank no longer grants authority.';
COMMENT ON COLUMN pactaris.authority_links.legacy_full IS 'Set by 0044 for subs that had several Doms; all keep their rights until a primary Dom is chosen.';
ALTER TABLE pactaris.authority_delegations ADD COLUMN approve boolean NOT NULL DEFAULT false;
ALTER TABLE pactaris.authority_delegations DROP CONSTRAINT authority_delegations_check,
 ADD CONSTRAINT authority_delegations_check CHECK(tasks OR approve OR outcomes);

CREATE TABLE pactaris.authority_transfers (
 household_id uuid NOT NULL,id uuid NOT NULL,sub_id uuid NOT NULL,from_dom uuid,to_dom uuid NOT NULL,proposer_id uuid NOT NULL,
 to_accepted boolean NOT NULL DEFAULT false,sub_accepted boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','completed','declined','cancelled')),version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),decided_at timestamptz,
 PRIMARY KEY(household_id,id),CHECK(to_dom<>sub_id),
 FOREIGN KEY(household_id,sub_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,from_dom) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,to_dom) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,proposer_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE UNIQUE INDEX authority_transfers_open ON pactaris.authority_transfers(household_id,sub_id) WHERE state='proposed';
ALTER TABLE pactaris.authority_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.authority_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.authority_transfers FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

-- Who may receive rights over a sub: anyone not ranked as a sub, or a sub ranked above them.
CREATE FUNCTION pactaris.ranks_above(target uuid,holder uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT holder IS DISTINCT FROM subject AND EXISTS(SELECT 1 FROM pactaris.memberships hm JOIN pactaris.memberships sm ON sm.household_id=hm.household_id AND sm.id=subject
  WHERE hm.household_id=target AND hm.id=holder AND (hm.sub_rank IS NULL OR (sm.sub_rank IS NOT NULL AND hm.sub_rank<sm.sub_rank)))
$$;
REVOKE ALL ON FUNCTION pactaris.ranks_above(uuid,uuid,uuid) FROM PUBLIC;

-- Areas: manage (rank, settings, delegation, transfer), tasks (create tasks and habits), approve (approve
-- submitted tasks) and outcomes (points, punishments, rewards). Rank alone grants nothing.
CREATE OR REPLACE FUNCTION pactaris.authority_area(target uuid,holder uuid,subject uuid,area text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT holder IS DISTINCT FROM subject AND area IN ('manage','tasks','approve','outcomes')
  AND EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=holder AND status='active')
  AND EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=subject AND status='active')
  AND (EXISTS(SELECT 1 FROM pactaris.authority_links l WHERE l.household_id=target AND l.state='active' AND l.dom_id=holder AND l.sub_id=subject AND (l.is_primary OR l.legacy_full))
   OR (area<>'manage' AND pactaris.ranks_above(target,holder,subject) AND EXISTS(SELECT 1 FROM pactaris.authority_delegations d
     JOIN pactaris.authority_links l ON l.household_id=d.household_id AND l.id=d.link_id AND l.state='active' AND (l.is_primary OR l.legacy_full)
     WHERE d.household_id=target AND d.state='active' AND d.delegate_id=holder AND l.sub_id=subject
      AND (d.ends_at IS NULL OR d.ends_at>statement_timestamp())
      AND CASE area WHEN 'tasks' THEN d.tasks WHEN 'approve' THEN d.approve ELSE d.outcomes END)))
$$;

-- A notice when a primary-Dom transfer is proposed, decided or completed.
ALTER TABLE pactaris.member_notices DROP CONSTRAINT member_notices_kind_check,
 ADD CONSTRAINT member_notices_kind_check CHECK(kind IN ('permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase','transfer'));
ALTER TABLE pactaris.notice_preferences DROP CONSTRAINT notice_preferences_muted_check,
 ADD CONSTRAINT notice_preferences_muted_check CHECK(muted <@ ARRAY['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase','transfer']::text[]);
-- Identical to 0042 apart from the transfer notice kind.
CREATE OR REPLACE FUNCTION pactaris.notice_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;items jsonb;unread integer;chosen text[];
BEGIN
 IF action IS NULL OR action NOT IN ('noticeList','noticeRead','noticePreferences','noticeConfigure') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid';
 END IF;
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
 IF action IN ('noticePreferences','noticeConfigure') THEN
  IF action='noticeConfigure' THEN
   IF jsonb_typeof(payload->'muted')<>'array' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   SELECT coalesce(array_agg(DISTINCT k ORDER BY k),'{}') INTO chosen FROM jsonb_array_elements_text(payload->'muted') k;
   IF NOT chosen <@ ARRAY['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase','transfer']::text[] THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   INSERT INTO pactaris.notice_preferences(household_id,member_id,muted) VALUES(target,m.id,chosen)
    ON CONFLICT(household_id,member_id) DO UPDATE SET muted=EXCLUDED.muted,version=pactaris.notice_preferences.version+1;
  END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticePreferences' THEN 'listed' ELSE 'applied' END,
   'muted',to_jsonb(coalesce((SELECT muted FROM pactaris.notice_preferences WHERE household_id=target AND member_id=m.id),'{}'::text[])));
 END IF;
 IF action='noticeRead' THEN
  -- Marking read is idempotent and needs no receipt.
  UPDATE pactaris.member_notices SET read=true WHERE household_id=target AND recipient_id=m.id AND NOT read
   AND (payload->'ids' IS NULL OR jsonb_typeof(payload->'ids')<>'array' OR id::text IN (SELECT jsonb_array_elements_text(payload->'ids')));
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'resourceId',n.resource_id,'actorName',a.display_name,'read',n.read,'createdAt',n.created_at) ORDER BY n.push_seq DESC),'[]'::jsonb) INTO items
  FROM (SELECT * FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id ORDER BY push_seq DESC LIMIT 30) n
  LEFT JOIN pactaris.memberships a ON a.household_id=n.household_id AND a.id=n.actor_id;
 SELECT count(*) INTO unread FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND NOT read;
 RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticeList' THEN 'listed' ELSE 'applied' END,
  'notices',items,'unread',unread);
END $$;

-- Losing the primary role must not come back from a backup.
ALTER TABLE pactaris.revocation_journal DROP CONSTRAINT revocation_journal_kind_check;
ALTER TABLE pactaris.revocation_journal ADD CONSTRAINT revocation_journal_kind_check CHECK(kind IN ('membership.ended','member.paused',
 'household.stopped','relationship.paused','relationship.ended','agreement.revoked','consent.withdrawn','taskAuthority.revoked',
 'document.deleted','attachment.deleted','checkin.withdrawn','account.erased','exchange.withdrawn','authority.ended','delegation.revoked','primary.released'));
CREATE FUNCTION pactaris.journal_primary() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF (OLD.is_primary AND NOT NEW.is_primary) OR (OLD.legacy_full AND NOT NEW.legacy_full) THEN
  PERFORM pactaris.journal_record(NEW.household_id,'primary.released',jsonb_build_object('linkId',NEW.id));
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.journal_primary() FROM PUBLIC;
CREATE TRIGGER journal_primary AFTER UPDATE OF is_primary,legacy_full ON pactaris.authority_links FOR EACH ROW EXECUTE FUNCTION pactaris.journal_primary();
-- Identical to 0037 apart from the primary.released branch.
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
 ELSIF entry_kind='primary.released' THEN
  UPDATE pactaris.authority_links SET is_primary=false,legacy_full=false,version=version+1
   WHERE household_id=target AND id=(s->>'linkId')::uuid AND (is_primary OR legacy_full);
  PERFORM pactaris.authority_sync(target);
 ELSE
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid';
 END IF;
END $$;

-- Departure cancels open transfers involving the member.
CREATE FUNCTION pactaris.transfer_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN
  UPDATE pactaris.authority_transfers SET state='cancelled',version=version+1,decided_at=statement_timestamp()
   WHERE household_id=NEW.household_id AND state='proposed' AND NEW.id IN (sub_id,to_dom,proposer_id,coalesce(from_dom,proposer_id));
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.transfer_departure() FROM PUBLIC;
CREATE TRIGGER transfer_departure AFTER UPDATE OF status ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.transfer_departure();

-- Identical to 0038 apart from primary Dom, approve rights, transfers and dropping rank authority.
CREATE OR REPLACE FUNCTION pactaris.authority_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;other pactaris.memberships;l pactaris.authority_links;d pactaris.authority_delegations;
 prior pactaris.authority_receipts;pair pactaris.authority_pairs;answer jsonb;resource uuid;links jsonb;delegations jsonb;members jsonb;powers jsonb;
 adjustments jsonb;ends timestamptz;policy_version bigint;involved boolean;transfers jsonb;tr pactaris.authority_transfers;primary_link pactaris.authority_links;to_link pactaris.authority_links;
BEGIN
 IF action IS NULL OR action NOT IN ('authorityList','linkInvite','linkAccept','linkDecline','linkEnd','linkSettings','delegationSet','delegationRevoke',
   'rankSet','visibilitySet','pointsAdjust','punishmentGive','transferPropose','transferAccept','transferDecline','transferCancel') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
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
    'state',x.state,'label',x.label,'isPrimary',x.is_primary,'legacy',x.legacy_full,'subHasPrimary',EXISTS(SELECT 1 FROM pactaris.authority_links q WHERE q.household_id=target AND q.sub_id=x.sub_id AND q.state='active' AND q.is_primary),'private',x.private,'canSpendPoints',x.can_spend_points,'canPropose',x.can_propose,'version',x.version::text,
    'role',CASE WHEN x.dom_id=m.id THEN 'dom' WHEN x.sub_id=m.id THEN 'sub' ELSE 'viewer' END) ORDER BY x.created_at,x.id),'[]'::jsonb) INTO links
   FROM (SELECT * FROM pactaris.authority_links z WHERE z.household_id=target AND z.state<>'ended'
    AND (m.id IN (z.dom_id,z.sub_id)
     OR EXISTS(SELECT 1 FROM pactaris.authority_delegations e WHERE e.household_id=target AND e.link_id=z.id AND e.delegate_id=m.id AND e.state='active')
     OR (z.state='active' AND h.subs_visible AND NOT z.private AND involved))
    ORDER BY z.created_at,z.id LIMIT 100) x
   JOIN pactaris.memberships dm ON dm.household_id=target AND dm.id=x.dom_id JOIN pactaris.memberships sm ON sm.household_id=target AND sm.id=x.sub_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('delegationId',e.id,'linkId',e.link_id,'delegateId',e.delegate_id,'delegateName',dm.display_name,
    'tasks',e.tasks,'approve',e.approve,'outcomes',e.outcomes,'endsAt',e.ends_at,'version',e.version::text) ORDER BY e.id),'[]'::jsonb) INTO delegations
   FROM pactaris.authority_delegations e JOIN pactaris.authority_links z ON z.household_id=e.household_id AND z.id=e.link_id AND z.state='active'
   JOIN pactaris.memberships dm ON dm.household_id=e.household_id AND dm.id=e.delegate_id
   WHERE e.household_id=target AND e.state='active' AND m.id IN (z.dom_id,z.sub_id,e.delegate_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',o.id,'name',o.display_name,'owner',o.technical_role='owner',
    'rank',CASE WHEN o.id=m.id OR (h.subs_visible AND involved) OR pactaris.authority_area(target,m.id,o.id,'tasks') OR pactaris.authority_area(target,m.id,o.id,'manage') THEN o.sub_rank END) ORDER BY o.display_name,o.id),'[]'::jsonb) INTO members
   FROM (SELECT * FROM pactaris.memberships WHERE household_id=target AND status='active' ORDER BY display_name,id LIMIT 100) o;
  SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',o.id,'tasks',pactaris.authority_area(target,m.id,o.id,'tasks'),
    'approve',pactaris.authority_area(target,m.id,o.id,'approve'),'outcomes',pactaris.authority_area(target,m.id,o.id,'outcomes'),'manage',pactaris.authority_area(target,m.id,o.id,'manage'),
    'points',pactaris.authority_points(target,o.id)::text) ORDER BY o.id),'[]'::jsonb) INTO powers
   FROM pactaris.memberships o WHERE o.household_id=target AND o.status='active' AND o.id<>m.id
    AND (pactaris.authority_area(target,m.id,o.id,'tasks') OR pactaris.authority_area(target,m.id,o.id,'approve') OR pactaris.authority_area(target,m.id,o.id,'outcomes'));
  SELECT coalesce(jsonb_agg(jsonb_build_object('transferId',z.id,'subId',z.sub_id,'subName',sm.display_name,'fromId',z.from_dom,'fromName',fm.display_name,
    'toId',z.to_dom,'toName',tm.display_name,'proposerId',z.proposer_id,'toAccepted',z.to_accepted,'subAccepted',z.sub_accepted,'version',z.version::text,
    'canAccept',(m.id=z.to_dom AND NOT z.to_accepted) OR (m.id=z.sub_id AND NOT z.sub_accepted),'canCancel',m.id=z.proposer_id) ORDER BY z.created_at),'[]'::jsonb) INTO transfers
   FROM pactaris.authority_transfers z JOIN pactaris.memberships sm ON sm.household_id=z.household_id AND sm.id=z.sub_id
   JOIN pactaris.memberships tm ON tm.household_id=z.household_id AND tm.id=z.to_dom
   LEFT JOIN pactaris.memberships fm ON fm.household_id=z.household_id AND fm.id=z.from_dom
   WHERE z.household_id=target AND z.state='proposed' AND m.id IN (z.proposer_id,z.to_dom,z.sub_id,coalesce(z.from_dom,z.proposer_id));
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'recipientId',a.recipient_id,'issuerId',a.issuer_id,'points',a.points,'reason',a.reason,'createdAt',a.created_at) ORDER BY a.created_at DESC),'[]'::jsonb) INTO adjustments
   FROM (SELECT * FROM pactaris.point_adjustments WHERE household_id=target AND m.id IN (recipient_id,issuer_id) ORDER BY created_at DESC LIMIT 10) a;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','links',links,'delegations',delegations,
   'members',members,'powers',powers,'adjustments',adjustments,'transfers',transfers,'subsVisible',h.subs_visible,'settingsVersion',h.authority_version::text,
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
   -- The first Dom a sub links with becomes the primary Dom; later Doms only get rights through delegation.
   UPDATE pactaris.authority_links SET state='active',accepted_at=statement_timestamp(),version=version+1,
    is_primary=NOT EXISTS(SELECT 1 FROM pactaris.authority_links q WHERE q.household_id=target AND q.sub_id=l.sub_id AND q.state='active' AND (q.is_primary OR q.legacy_full))
    WHERE household_id=target AND id=l.id;
  ELSIF action='linkSettings' THEN
   UPDATE pactaris.authority_links SET private=(payload->>'private')::boolean,
    can_spend_points=(payload->>'canSpendPoints')::boolean,can_propose=(payload->>'canPropose')::boolean,version=version+1 WHERE household_id=target AND id=l.id;
  ELSE
   -- Ending or declining is always possible, also during a pause.
   UPDATE pactaris.authority_links SET state='ended',ended_at=statement_timestamp(),ended_by=m.id,version=version+1 WHERE household_id=target AND id=l.id;
    -- Rights the primary Dom handed out end with the primary link; open transfers for the sub are cancelled.
    IF l.is_primary OR l.legacy_full THEN
     UPDATE pactaris.authority_delegations SET state='revoked',version=version+1 WHERE household_id=target AND link_id=l.id AND state='active';
    END IF;
    UPDATE pactaris.authority_transfers SET state='cancelled',version=version+1,decided_at=statement_timestamp()
     WHERE household_id=target AND sub_id=l.sub_id AND state='proposed' AND (l.is_primary OR l.dom_id IN (to_dom,proposer_id));
  END IF;
  resource=l.id;
 ELSIF action='delegationSet' THEN
  SELECT * INTO l FROM pactaris.authority_links WHERE household_id=target AND id=(payload->>'linkId')::uuid AND dom_id=m.id AND state='active' AND (is_primary OR legacy_full);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'delegateId')::uuid AND status='active';
  IF NOT FOUND OR other.id IN (l.dom_id,l.sub_id) OR NOT pactaris.ranks_above(target,other.id,l.sub_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  ends=(payload->>'endsAt')::timestamptz;
  IF ends IS NOT NULL AND ends<=statement_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid'; END IF;
  SELECT * INTO d FROM pactaris.authority_delegations WHERE household_id=target AND link_id=l.id AND delegate_id=other.id AND state='active' FOR UPDATE;
  IF coalesce(d.version,0)::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  IF d.id IS NULL THEN
   INSERT INTO pactaris.authority_delegations(household_id,id,link_id,delegate_id,tasks,approve,outcomes,ends_at,created_by)
    VALUES(target,operation,l.id,other.id,(payload->>'tasks')::boolean,(payload->>'approve')::boolean,(payload->>'outcomes')::boolean,ends,m.id);
   resource=operation;
  ELSE
   UPDATE pactaris.authority_delegations SET tasks=(payload->>'tasks')::boolean,approve=(payload->>'approve')::boolean,outcomes=(payload->>'outcomes')::boolean,ends_at=ends,version=version+1
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
 ELSIF action='transferPropose' THEN
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'subId')::uuid AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  SELECT * INTO primary_link FROM pactaris.authority_links WHERE household_id=target AND sub_id=other.id AND state='active' AND is_primary;
  -- With a primary Dom only that Dom may propose; without one any of the sub's own Doms may.
  IF (primary_link.id IS NOT NULL AND primary_link.dom_id<>m.id) OR (primary_link.id IS NULL AND NOT EXISTS(SELECT 1 FROM pactaris.authority_links
    WHERE household_id=target AND sub_id=other.id AND dom_id=m.id AND state='active')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF (payload->>'toId')::uuid IN (other.id) OR (payload->>'toId')::uuid IS NOT DISTINCT FROM primary_link.dom_id
   OR NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'toId')::uuid AND status='active')
   OR NOT pactaris.ranks_above(target,(payload->>'toId')::uuid,other.id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF h.status<>'active' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF EXISTS(SELECT 1 FROM pactaris.authority_transfers WHERE household_id=target AND sub_id=other.id AND state='proposed') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  INSERT INTO pactaris.authority_transfers(household_id,id,sub_id,from_dom,to_dom,proposer_id,to_accepted)
   VALUES(target,operation,other.id,primary_link.dom_id,(payload->>'toId')::uuid,m.id,(payload->>'toId')::uuid=m.id);
  PERFORM pactaris.notice(target,other.id,m.id,'transfer',operation);
  PERFORM pactaris.notice(target,(payload->>'toId')::uuid,m.id,'transfer',operation);
  resource=operation;
 ELSIF action IN ('transferAccept','transferDecline','transferCancel') THEN
  SELECT * INTO tr FROM pactaris.authority_transfers WHERE household_id=target AND id=(payload->>'transferId')::uuid FOR UPDATE;
  IF NOT FOUND OR (action='transferCancel' AND m.id<>tr.proposer_id) OR (action<>'transferCancel' AND m.id NOT IN (tr.to_dom,tr.sub_id)) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF tr.version::text IS DISTINCT FROM payload->>'version' OR tr.state<>'proposed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  IF action='transferAccept' THEN
   IF h.status<>'active' OR m.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
   UPDATE pactaris.authority_transfers SET to_accepted=to_accepted OR m.id=to_dom,sub_accepted=sub_accepted OR m.id=sub_id,version=version+1
    WHERE household_id=target AND id=tr.id RETURNING * INTO tr;
   IF tr.to_accepted AND tr.sub_accepted THEN
    -- The primary Dom must still be the one the proposal was made against.
    SELECT * INTO primary_link FROM pactaris.authority_links WHERE household_id=target AND sub_id=tr.sub_id AND state='active' AND is_primary;
    IF primary_link.dom_id IS DISTINCT FROM tr.from_dom THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
    UPDATE pactaris.authority_links SET is_primary=false,legacy_full=false,version=version+1
     WHERE household_id=target AND sub_id=tr.sub_id AND state<>'ended' AND (is_primary OR legacy_full);
    UPDATE pactaris.authority_delegations e SET state='revoked',version=e.version+1 FROM pactaris.authority_links z
     WHERE e.household_id=target AND z.household_id=e.household_id AND z.id=e.link_id AND z.sub_id=tr.sub_id AND e.state='active';
    SELECT * INTO to_link FROM pactaris.authority_links WHERE household_id=target AND dom_id=tr.to_dom AND sub_id=tr.sub_id AND state<>'ended' FOR UPDATE;
    IF to_link.id IS NULL THEN
     -- The sub's acceptance is their consent to this new Dom link.
     INSERT INTO pactaris.authority_links(household_id,id,dom_id,sub_id,state,label,accepted_at,is_primary)
      VALUES(target,gen_random_uuid(),tr.to_dom,tr.sub_id,'active','',statement_timestamp(),true);
    ELSE
     UPDATE pactaris.authority_links SET state='active',accepted_at=coalesce(accepted_at,statement_timestamp()),is_primary=true,version=version+1
      WHERE household_id=target AND id=to_link.id;
    END IF;
    UPDATE pactaris.authority_transfers SET state='completed',version=version+1,decided_at=statement_timestamp() WHERE household_id=target AND id=tr.id;
    IF tr.from_dom IS NOT NULL THEN PERFORM pactaris.notice(target,tr.from_dom,m.id,'transfer',tr.id); END IF;
    PERFORM pactaris.notice(target,tr.proposer_id,m.id,'transfer',tr.id);
   END IF;
  ELSE
   UPDATE pactaris.authority_transfers SET state=CASE WHEN action='transferCancel' THEN 'cancelled' ELSE 'declined' END,version=version+1,decided_at=statement_timestamp()
    WHERE household_id=target AND id=tr.id;
   PERFORM pactaris.notice(target,tr.proposer_id,m.id,'transfer',tr.id);
  END IF;
  resource=tr.id;
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
   IF NOT pactaris.authority_punish(target,m.id,other.id,operation,payload->>'title',payload->>'description',(payload->>'exchangeId')::uuid) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  END IF;
  resource=operation;
 END IF;
 IF action IN ('linkAccept','linkDecline','linkEnd','linkSettings','delegationSet','delegationRevoke','rankSet','transferAccept') THEN PERFORM pactaris.authority_sync(target); END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','resourceId',resource);
 INSERT INTO pactaris.authority_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'authority.'||action,resource,jsonb_build_object('operationId',operation));
 RETURN answer;
END $$;
-- Identical to 0038 apart from primary-Dom transfers.
CREATE OR REPLACE FUNCTION pactaris.authority_export_page(instance uuid,account uuid,after text,max_rows integer) RETURNS jsonb
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
   UNION ALL
   SELECT b.household_id::text||':'||b.id::text,jsonb_build_object('kind','habit')||to_jsonb(b)||jsonb_build_object('entries',
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at),'[]'::jsonb) FROM pactaris.authority_habit_entries e WHERE e.household_id=b.household_id AND e.habit_id=b.id),
    'results',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.period_start),'[]'::jsonb) FROM pactaris.authority_habit_results r WHERE r.household_id=b.household_id AND r.habit_id=b.id))
    FROM pactaris.authority_habits b WHERE b.holder_id=ANY(members) OR b.subject_id=ANY(members)
   UNION ALL
   SELECT t.household_id::text||':'||t.id::text,jsonb_build_object('kind','primaryTransfer')||to_jsonb(t) FROM pactaris.authority_transfers t
    WHERE t.sub_id=ANY(members) OR t.to_dom=ANY(members) OR t.proposer_id=ANY(members) OR t.from_dom=ANY(members)
  ) all_rows WHERE k>coalesce(after,'') ORDER BY k LIMIT max_rows) r;
 rows=coalesce(rows,'[]'::jsonb);
 RETURN jsonb_build_object('section','authority','records',rows,'next',CASE WHEN jsonb_array_length(rows)=max_rows THEN last END);
END $$;

-- Existing data: a sub with one active Dom gets that Dom as primary. A sub with several Doms gets no
-- automatic choice; all of them keep their rights (legacy_full) until a primary Dom is chosen.
UPDATE pactaris.authority_links l SET is_primary=true
 WHERE l.state='active' AND (SELECT count(*) FROM pactaris.authority_links q WHERE q.household_id=l.household_id AND q.sub_id=l.sub_id AND q.state='active')=1;
UPDATE pactaris.authority_links l SET legacy_full=true
 WHERE l.state='active' AND (SELECT count(*) FROM pactaris.authority_links q WHERE q.household_id=l.household_id AND q.sub_id=l.sub_id AND q.state='active')>1;
-- Pairs that only existed through rank lose their backing policy.
SELECT pactaris.authority_sync(id) FROM pactaris.households WHERE EXISTS(SELECT 1 FROM pactaris.authority_links l WHERE l.household_id=households.id);
