CREATE SCHEMA IF NOT EXISTS pactaris;
CREATE TABLE pactaris.accounts (
 id uuid PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL,
 display_name text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (issuer,subject)
);
CREATE TABLE pactaris.login_attempts (
 cookie_hash text PRIMARY KEY CHECK (length(cookie_hash)=64), state text NOT NULL UNIQUE,
 nonce text NOT NULL, verifier text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE pactaris.sessions (
 token_hash text PRIMARY KEY CHECK (length(token_hash)=64), account_id uuid NOT NULL REFERENCES pactaris.accounts(id),
 csrf_token text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, idle_expires_at timestamptz NOT NULL
);
CREATE INDEX ON pactaris.sessions (account_id);
CREATE INDEX ON pactaris.sessions (expires_at);
CREATE TABLE pactaris.auth_limits (bucket_hash text PRIMARY KEY, attempts integer NOT NULL, resets_at timestamptz NOT NULL);
CREATE TABLE pactaris.instances (
 id uuid PRIMARY KEY, endpoint text NOT NULL, tls_server_name text NOT NULL, ca_file text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
);
CREATE TABLE pactaris.placements (
 household_id uuid PRIMARY KEY, instance_id uuid NOT NULL REFERENCES pactaris.instances(id),
 version bigint NOT NULL CHECK (version>0), status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
);
CREATE TABLE pactaris.account_households (
 account_id uuid NOT NULL REFERENCES pactaris.accounts(id), household_id uuid NOT NULL REFERENCES pactaris.placements(household_id),
 PRIMARY KEY (account_id,household_id)
);
