/** Technical permissions only. Dynamic titles, payment and consent are separate. */
export type TechnicalRole = 'owner' | 'admin' | 'participant';
export type MemberActor = {
  accountId: string; membershipId: string; householdId: string;
  status: string; technicalRole: string;
};
export type ResourceScope = {
  householdId: string; ownerMembershipId: string;
  visibility: 'private' | 'participants' | 'household';
  participantMembershipIds?: readonly string[];
};
export type Permission = 'household.view' | 'household.settings.update' |
  'invitations.manage' | 'membership.leave' | 'consent.self.manage' |
  'safety.self.pause' | 'safety.household.stop' | 'resource.read';

export function permits(actor: MemberActor, permission: string, householdId: string, resource?: ResourceScope): boolean {
  if (!actor.accountId || !actor.membershipId || !householdId || actor.householdId !== householdId ||
      actor.status !== 'active' || !['owner', 'admin', 'participant'].includes(actor.technicalRole)) return false;
  switch (permission) {
    case 'household.view':
    case 'membership.leave':
    case 'consent.self.manage':
    case 'safety.self.pause':
    case 'safety.household.stop': return true;
    case 'household.settings.update':
    case 'invitations.manage': return actor.technicalRole === 'owner' || actor.technicalRole === 'admin';
    case 'resource.read': {
      if (!resource || resource.householdId !== householdId || !resource.ownerMembershipId ||
          !['private', 'participants', 'household'].includes(resource.visibility)) return false;
      return resource.ownerMembershipId === actor.membershipId || resource.visibility === 'household' ||
        (resource.visibility === 'participants' && !!resource.participantMembershipIds?.includes(actor.membershipId));
    }
    default: return false;
  }
}
