-- Free KV media: D1 tracks immutable chunk identities, publication and quota.
ALTER TABLE product_media ADD COLUMN visible_after TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE cloud_media_uploads ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cloud_media_uploads ADD COLUMN visible_after TEXT;
ALTER TABLE cloud_media_uploads ADD COLUMN release_after TEXT;
CREATE TABLE IF NOT EXISTS cloud_media_objects (
  upload_id TEXT NOT NULL REFERENCES cloud_media_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL CHECK(size>0),
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','stored','deleted')),
  PRIMARY KEY(upload_id,part_number)
);
CREATE INDEX IF NOT EXISTS cloud_media_objects_state_idx ON cloud_media_objects(state,upload_id);
CREATE TABLE IF NOT EXISTS cloud_media_operations (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK(count>=0 AND count<=800)
);
