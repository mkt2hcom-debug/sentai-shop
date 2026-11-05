-- Public passkey material and hashed bearer tokens only.
CREATE TABLE IF NOT EXISTS cf_admin_sessions (
  token_hash TEXT PRIMARY KEY, csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cf_admin_sessions_expiry_idx ON cf_admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS cf_admin_grants (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed_at INTEGER);
CREATE TABLE IF NOT EXISTS cf_passkeys (
  credential_id TEXT PRIMARY KEY, public_key TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK(counter>=0), transports TEXT NOT NULL DEFAULT '[]', label TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cf_auth_challenges (
  id_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('registration','authentication')),
  challenge TEXT NOT NULL, session_hash TEXT, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cf_auth_challenges_expiry_idx ON cf_auth_challenges(expires_at);
