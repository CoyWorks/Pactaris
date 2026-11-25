-- Cursor metadata follows the membership when it is physically removed during cleanup.
ALTER TABLE pactaris.workspace_change_tokens DROP CONSTRAINT workspace_change_tokens_household_id_member_id_fkey,
 ADD CONSTRAINT workspace_change_tokens_household_id_member_id_fkey FOREIGN KEY(household_id,member_id) REFERENCES pactaris.memberships(household_id,id) ON DELETE CASCADE;
ALTER TABLE pactaris.workspace_change_cursors DROP CONSTRAINT workspace_change_cursors_household_id_member_id_fkey,
 ADD CONSTRAINT workspace_change_cursors_household_id_member_id_fkey FOREIGN KEY(household_id,member_id) REFERENCES pactaris.memberships(household_id,id) ON DELETE CASCADE;
