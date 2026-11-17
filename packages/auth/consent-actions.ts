export const consentActions=['consentState','agreementList','agreementPropose','agreementRevise','agreementAccept','agreementDecline','agreementWithdraw','activityCheck','limitsUpdate','selfPause','selfResume','householdStop','householdResume','relationshipPause','relationshipResume','safetyGrant','localRestrict'] as const;
export type ConsentAction=typeof consentActions[number];
export const isConsentAction=(value:unknown):value is ConsentAction=>typeof value==='string'&&(consentActions as readonly string[]).includes(value);
