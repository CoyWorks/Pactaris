# English-first internationalization

Required from M0, issue #44. The first release ships English only. Additional languages and regional settings are data packs, not feature-code rewrites.

## Message contract

Application components, domain services and templates contain semantic keys/shortcodes, not literal English/Dutch system sentences. Example use: `t("tasks.actions.complete")` or `t("tasks.assigned", { memberName })`. Use readable stable keys rather than numeric shortcodes.

Proposed layout:

- `locales/en/messages.json`: authoritative English messages, organized by namespace.
- `locales/manifest.json`: enabled language packs, fallback, direction and catalog version.
- Shared frontend/server helpers: key types, parameters, plural/select messages and locale-aware formatting.
- Future `locales/<language>/messages.json`: validated translations of the same contract.

Names/paths are proposed scaffold conventions; no translation runtime exists yet. Choose a maintained message-format library during #1/#44 rather than a custom regex replacement engine.

## Coverage

Translate navigation, buttons, placeholders, headings, tooltips, validation, error/success states, ARIA/alt text, confirmations, dates/relative-time labels, email subjects/bodies, push content, manager status, system audit descriptions, default system role/category/template labels and human-readable export/report headings.

Central login, manager and all instances use the same versioned contract. External identity-provider screens must use that provider's supported localization mechanism and English initial configuration. No English literals hidden in inline fallback arguments or third-party validation defaults.

Source catalogs hold complete messages with parameters/plural rules. Do not concatenate translated fragments or use English sentences as stable keys. Escape interpolated user data; never render translator-supplied arbitrary HTML/scripts. Rich messages use controlled components.

## Data, API and notifications

Persist stable statuses/event codes/message keys plus structured parameters, not pretranslated system prose. API errors expose a stable code/key and safe field parameters; the UI resolves presentation. Keep a resolvable generic catalog fallback for unexpected errors. Workers resolve recipient language/locale when delivering; notifications default to generic private text.

Keep user-authored content unchanged: task names, chat, custom role labels, agreements and private notes are not automatically translated. Seeded system templates use catalog references/versioned localized resources; user-edited copies become user content. Developer-only logs, internal identifiers/protocol constants and test fixtures may contain technical text, but not leak raw errors to users. Documentation naturally contains prose.

## Language, locale and timezone

Treat these as independent preferences:

| Setting | Purpose |
| --- | --- |
| Language | Message catalog; initially en only |
| Formatting locale | BCP 47 regional date, time, number and currency conventions |
| Timezone | Validated IANA zone for display or explicit scheduling semantics |
| Household terminology | Optional user-authored labels, not translation keys or permissions |

Declare explicit configurable formatting/timezone defaults in the scaffold; do not infer language from region or use server locale/timezone implicitly. Store instants consistently and keep recurrence timezone/wall-clock rules separate. Display-format changes must not reschedule tasks. Use shared standard locale-aware formatters, not manual date strings or hardcoded currency symbols. Technical exports use stable machine-readable formats; human-readable headings are localized.

## Fallback and rollout

Explicit supported user preference wins; otherwise use validated supported browser/application defaults. Ship only English initially and fall back to the complete English catalog for unsupported languages. Never silently substitute Dutch or activate an incomplete safety translation.

Language packs declare direction, supported formatting metadata and compatible schema/catalog version. New packs may require a build/deployment depending on packaging, but no feature-component edits. Version/cache updates across manager, identity and instances must not strand unresolved API/error keys.

CI validates key coverage, duplicate/orphan keys, parameter types, plural/select syntax and locale metadata. Static checks catch visible string literals in components, error paths, ARIA, email and notifications. Use reviewed narrow exceptions for technical strings; no blanket disable. Pseudo-localization checks expansion/RTL readiness without shipping a second language. Human review is required before enabling new consent/safety translations.
