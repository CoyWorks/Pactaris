# BDSM-first domain model

Status: planning requirements, 16 November 2026. Implement the core graph in [#35](https://github.com/CoyWorks/Pactaris/issues/35). This model is central from M0.

## Product focus

The app is for consenting-adult BDSM, SM and kink dynamics: Dom/sub relationships, top/bottom/switch contexts, play partners, protocols, rituals, negotiated tasks, rewards/consequences, sessions and aftercare. Romantic relationships can overlap with BDSM relationships.

A household is a private dynamic space. It does not imply living together, marriage, family structure, exclusivity, a couple, one dominant or an all-to-all relationship. The UI should use dynamic/household in this context, not default to family chores.

## Separate the concepts

| Concept | Purpose | Example |
| --- | --- | --- |
| Account | Independent person with login and privacy rights | One person with memberships on two instances |
| Membership | Person's participation in one household | Active member of Dynamic A |
| Technical role | Application permissions | Owner/admin/participant; an admin may be a sub |
| Identity/preference label | Optional self-description | Dom, sub, switch, top, bottom; multiple labels |
| Relationship | Accepted connection with specific participants and scope | D/s plus a separate romantic relationship |
| Contextual role assignment | How a person participates in that relationship/session | A is Dom to B, bottom to C |
| Agreement | Versioned negotiated scope, limits and consent | Ongoing protocol agreement or session negotiation |
| Standing | Optional household-defined status/history | Does not grant API authority |
| Billing sponsor | Account paying for a household plan | Does not own participants or their private data |
| Instance operator | Infrastructure role | Does not become a household Dom/admin |

Never put a mandatory single `dom/sub` field on a user or infer permissions from a relationship label.

## Required examples

| Dynamic | Relationship assignments | Required result |
| --- | --- | --- |
| Two people | A Dom to B; B sub to A | Simple D/s pair |
| Four people | A Dom to C; B Dom to D | Dom/Dom/sub/sub without inventing other connections |
| Switch/context overlap | A Dom to C; A sub/bottom to B | Both roles valid simultaneously in the same household |
| Overlapping relationship types | A and B romantic; A top to B within agreed play scope | Romance and scene roles remain separate |
| Group agreement | A, B, C and D agree to a group protocol with distinct roles | Each accepts their own scope; no proxy consent |
| Multiple households | A has different roles and permissions in another dynamic on another instance | No automatic sharing of graph, consent or private records |

A role label is optional context, not proof of consent, sexual orientation, capability, authority or permanent hierarchy. Top/bottom and Dom/sub are distinct concepts and must not be silently treated as synonyms.

## Proposed records

| Record | Key fields / invariant |
| --- | --- |
| Household | Stable ID, home instance, lifecycle, settings |
| Membership | Local ID, platform subject, household, active/left/revoked state |
| Relationship type | Household-defined label, symmetry/direction semantics, archived state |
| Relationship | Household, type, scope, state, version, visibility, effective dates |
| Relationship participant | Relationship and membership; at least two distinct accepted participants |
| Relationship role assignment | Participant, role definition, optional counterpart participant, context and dates |
| Dynamic role definition | Household-defined Dom/sub/top/bottom/switch/etc. labels with stable identifiers |
| Agreement and acceptance | Exact version, participants, accepted scope, individual accept/decline/withdraw history |
| Session participant | Session, membership, contextual roles, own agreement state |
| Technical permission grant | Separate authorization record; never inferred solely from the graph |

Use the same household key in all related foreign keys. A role targeting another participant must target someone in that relationship and household. Support group agreements without flattening all participants into pairwise romantic or D/s connections. Directed pairwise links can coexist when explicitly chosen.

MVP relationships stay inside one household on one home instance. Supporting the same global person in other households does not create a cross-household relation. Cross-household graphs are a separate future design.

## Negotiation and play lifecycle

Ongoing relationships and household agreements do not preauthorize every play session. Record negotiated scope, hard/soft limits, safewords/signals, visibility, check-ins and aftercare preferences at the relevant relationship/session level.

Session planning ([#52](https://github.com/CoyWorks/Pactaris/issues/52)) distinguishes proposed, agreed, active, paused/stopped and closed states. Participants accept their own current scope and can withdraw. A role change or material agreement change requires affected participants to review it again. No administrator can accept consent for someone else.

Use a central authorization/safety service for tasks, protocols, ledger entries, jobs and sessions. A participant's pause cannot be cleared through another relationship, by a sponsor or by a plan change. Define individual, relationship/session and household scopes explicitly ([#10](https://github.com/CoyWorks/Pactaris/issues/10), [#11](https://github.com/CoyWorks/Pactaris/issues/11)).

Basic negotiation, limits, stop controls and aftercare check-ins are available free. Rich planners/templates can add paid convenience. Stored text cannot establish real-world consent or automatically detect whether arbitrary prose violates someone's limits.

## Visibility and lifecycle

- Each relationship/agreement/session declares authorized participants and optional wider sharing.
- A household admin does not automatically see personal-private negotiations, notes or check-in responses.
- Graph edges, counts, search snippets, exports, files and audit summaries must apply the same visibility policy.
- Decline, withdrawal, end dates, relationship changes and membership departure preserve minimal permitted history with the defined retention/deletion policy.
- Avoid a forced global rank, public compliance score, punitive withdrawal or hidden monitoring.

## Verification

Exercise every example above through the actual API and database. Add malformed cross-household references, unauthorized graph views, concurrent consent changes, pause during queued execution and free-plan role diversity to the test matrix.
