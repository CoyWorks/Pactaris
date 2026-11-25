# Age confirmation (18+)

Pactaris is for consenting adults only. Owner decision, 25 November 2026: every account confirms once that the person is 18 or older. This is a self-declaration, not age verification.

## Behavior

- After sign-in, an account without a confirmation sees only the confirmation screen: a checkbox "I am 18 years or older", Continue, and Sign out. Nothing else in the app opens until it is confirmed.
- `POST /api/account/adult-confirmation` with `{"adult":true}` (CSRF-protected) stores `accounts.adult_confirmed_at` (gateway migration `0028_adult_confirmation`). A repeat keeps the first time.
- `GET /api/session` returns `adultConfirmed`.
- The gateway also refuses, with `adult_confirmation_required`, to create a dynamic or accept an invitation for an account that has not confirmed. These are the only ways into shared content.
- Existing accounts see the screen once on their next visit.

## Policy notes and limits

- Self-declaration is not considered robust for content restricted to adults under the European Commission's Article 28 DSA guidelines. Whether those obligations apply to Pactaris (private dynamics rather than public dissemination, size exemptions) needs a legal review before public launch.
- Planned later: privacy-friendly age verification through the EU age verification app or a national wallet once available in the Netherlands.
- Reports in the "possible minor" category and suspension pending review stay in place ([PRIVACY_OPERATIONS.md](PRIVACY_OPERATIONS.md), [MODERATION.md](MODERATION.md)).
- The terms text that states the 18+ requirement is owned by the legal review and is not part of this change.
