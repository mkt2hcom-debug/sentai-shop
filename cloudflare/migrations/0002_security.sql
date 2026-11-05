CREATE TABLE IF NOT EXISTS cf_revoked_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cf_revoked_expiry_idx ON cf_revoked_tokens(expires_at);
CREATE TABLE IF NOT EXISTS cf_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cf_rate_expiry_idx ON cf_rate_limits(expires_at);
