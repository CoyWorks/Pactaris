-- Authority can change without changing a link's state (primary transfer or rank edits).
-- Fence the overlapping periods so restoring authority cannot create delayed outcomes.
CREATE OR REPLACE FUNCTION pactaris.habit_link_safety_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.state IS DISTINCT FROM NEW.state OR OLD.is_primary IS DISTINCT FROM NEW.is_primary OR OLD.legacy_full IS DISTINCT FROM NEW.legacy_full THEN
  UPDATE pactaris.authority_habits SET skip_through=greatest(skip_through,pactaris.habit_period_start(period,time_zone,now()))
   WHERE household_id=NEW.household_id AND subject_id=NEW.sub_id AND state<>'archived';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER habit_link_safety_fence ON pactaris.authority_links;
CREATE TRIGGER habit_link_safety_fence AFTER UPDATE OF state,is_primary,legacy_full ON pactaris.authority_links FOR EACH ROW EXECUTE FUNCTION pactaris.habit_link_safety_fence();

CREATE FUNCTION pactaris.habit_rank_safety_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.sub_rank IS DISTINCT FROM NEW.sub_rank THEN
  UPDATE pactaris.authority_habits SET skip_through=greatest(skip_through,pactaris.habit_period_start(period,time_zone,now()))
   WHERE household_id=NEW.household_id AND NEW.id IN (holder_id,subject_id) AND state<>'archived';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.habit_rank_safety_fence() FROM PUBLIC;
CREATE TRIGGER habit_rank_safety_fence AFTER UPDATE OF sub_rank ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.habit_rank_safety_fence();
