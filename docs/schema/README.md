# Database schema snapshots

`gateway.md` and `instance.md` describe the database each component has after all of its migrations run. They are generated, not written by hand. Do not edit them; change a migration and regenerate.

## How to read them

Each file has, in order:

1. **Tables**: a summary row per table with its column count, row-level security (RLS) state and what the runtime role may do with it.
2. **Relations**: a Mermaid diagram of foreign-key edges. GitHub renders it in place.
3. **Per-table sections**: for each table, its columns, constraints, indexes, RLS policies and triggers.
4. **Functions** (instance only; the gateway has none): every function in the schema, whether it runs as `SECURITY DEFINER`, and whether the runtime role may execute it.

Role names are normalized: `{runtime}` is the service's runtime role and `{backup}` the read-only backup role. Real role names differ per install.

## Access model

**Instance.** Tenant data is protected twice:

- Nearly every table has RLS enabled and forced, so even the table owner is filtered by policy.
- The runtime role has no direct table privileges on almost all tables ("functions only" in the summary). It reads and writes through `SECURITY DEFINER` functions that check the transaction-local household and account context first.

The exceptions are listed in the summary: a few tables the runtime role may `SELECT` directly (still behind forced RLS), and `delegation_uses`, which has no RLS and limited direct grants.

Some functions appear in chains (for example `partner_command` and its `_before_…` predecessors). A later migration renames the existing function and wraps it, so new behavior is added without rewriting the earlier body.

**Gateway.** The gateway holds accounts, sessions and sign-in state, not tenant data. Its tables have no RLS; the runtime role has direct grants scoped per table.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for why the roles are separated.

## Regenerating

The script creates a throwaway database and roles, runs every migration, introspects the catalog, writes the files and drops what it created. It needs a PostgreSQL superuser connection, the same one the integration tests use:

```sh
TEST_DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/postgres npm run schema:snapshot
```

Commit the regenerated files together with the migration that changed them. CI runs `npm run schema:check`, which fails with `schema.stale` when the committed files no longer match the migrations.
