-- D1 enables foreign keys. Statements are applied by Wrangler migrations.

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  series TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Mecha',
  price_vnd INTEGER CHECK (price_vnd IS NULL OR (price_vnd > 0 AND price_vnd <= 1000000000)),
  price_original TEXT,
  availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('unknown','available','sold_out')),
  condition TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  source_total TEXT,
  price_overridden INTEGER NOT NULL DEFAULT 0,
  availability_overridden INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS products_series_idx ON products(series);

-- A model groups physical used items; media/order identity remains products.id.
CREATE TABLE IF NOT EXISTS product_families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  series TEXT NOT NULL DEFAULT '',
  grouping_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS product_units (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  family_id TEXT NOT NULL REFERENCES product_families(id),
  unit_label TEXT NOT NULL,
  collection_label TEXT NOT NULL DEFAULT '',
  condition_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS product_units_family_idx ON product_units(family_id);

CREATE TABLE IF NOT EXISTS shop_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT NOT NULL DEFAULT '',
  customer_address TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL CHECK (subtotal > 0),
  total INTEGER NOT NULL CHECK (total = subtotal),
  payment_method TEXT NOT NULL DEFAULT 'cod' CHECK (payment_method = 'cod'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','shipping','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit_price INTEGER NOT NULL CHECK (unit_price > 0),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  line_total INTEGER NOT NULL CHECK (line_total = unit_price * quantity),
  UNIQUE(order_id, product_id)
);

CREATE TABLE IF NOT EXISTS admin_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL DEFAULT 'admin',
  password_version INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Only a hash of a short-lived, one-use local recovery link is stored.
CREATE TABLE IF NOT EXISTS admin_recovery (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_item_options (
  order_item_id INTEGER PRIMARY KEY REFERENCES order_items(id) ON DELETE CASCADE,
  family_name TEXT NOT NULL,
  unit_label TEXT NOT NULL,
  collection_label TEXT NOT NULL DEFAULT '',
  condition_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS media_jobs (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  upload_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  quality TEXT NOT NULL CHECK (quality IN ('high','original')),
  status TEXT NOT NULL CHECK (status IN ('uploading','queued','processing','ready','failed')),
  original_name TEXT NOT NULL,
  original_path TEXT NOT NULL,
  original_bytes INTEGER NOT NULL DEFAULT 0,
  watermark TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS media_jobs_status_idx ON media_jobs(status, created_at);
CREATE TABLE IF NOT EXISTS product_media (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  mime_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  poster_filename TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  duration REAL,
  original_name TEXT NOT NULL,
  original_bytes INTEGER NOT NULL,
  output_bytes INTEGER NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('high','original')),
  watermark TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS product_media_product_idx ON product_media(product_id,active,created_at);

-- Private research data: never included in the public catalog or catalog export.
CREATE TABLE IF NOT EXISTS price_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS price_keywords (
  id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL,
  normalized TEXT NOT NULL UNIQUE,
  product_id TEXT REFERENCES products(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS price_scans (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES price_groups(id),
  keyword_id TEXT NOT NULL REFERENCES price_keywords(id),
  max_posts INTEGER NOT NULL CHECK(max_posts BETWEEN 1 AND 50),
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','needs_login','failed')),
  post_count INTEGER NOT NULL DEFAULT 0,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS price_scans_queue_idx ON price_scans(status,created_at);
CREATE TABLE IF NOT EXISTS price_observations (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES price_groups(id),
  keyword_id TEXT NOT NULL REFERENCES price_keywords(id),
  product_id TEXT REFERENCES products(id),
  scan_id TEXT REFERENCES price_scans(id),
  post_url TEXT NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  price_vnd INTEGER CHECK(price_vnd IS NULL OR (price_vnd > 0 AND price_vnd <= 1000000000)),
  candidates TEXT NOT NULL DEFAULT '[]',
  flags TEXT NOT NULL DEFAULT '[]',
  condition TEXT NOT NULL DEFAULT '',
  published_text TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','accepted','ignored')),
  UNIQUE(group_id,keyword_id,post_url,content_hash)
);
CREATE INDEX IF NOT EXISTS price_observations_recent_idx ON price_observations(fetched_at DESC);

-- First-party visit statistics; no IP address, referrer, or customer data.
CREATE TABLE IF NOT EXISTS analytics_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_views (
  event_id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  page_type TEXT NOT NULL CHECK (page_type IN ('home','product')),
  path TEXT NOT NULL,
  family_id TEXT REFERENCES product_families(id),
  product_id TEXT REFERENCES products(id),
  name TEXT NOT NULL,
  unit_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK ((page_type = 'home' AND family_id IS NULL AND product_id IS NULL AND path = '/')
    OR (page_type = 'product' AND family_id IS NOT NULL AND product_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS analytics_views_created_idx ON analytics_views(created_at);
CREATE INDEX IF NOT EXISTS analytics_views_family_idx ON analytics_views(family_id, created_at);
CREATE INDEX IF NOT EXISTS analytics_views_product_idx ON analytics_views(product_id, created_at);
CREATE INDEX IF NOT EXISTS analytics_views_visit_idx ON analytics_views(visit_id, created_at);

-- Security metadata deliberately contains no request bodies or credentials.
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY, event TEXT NOT NULL, method TEXT NOT NULL, resource TEXT NOT NULL,
  status INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events(created_at);
CREATE TABLE IF NOT EXISTS security_limits (
  bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);

-- Migrated encrypted order fields retain their original authenticated key check.
CREATE TABLE IF NOT EXISTS data_protection_state (
  id INTEGER PRIMARY KEY CHECK(id=1), key_check TEXT NOT NULL,
  scrub_required INTEGER NOT NULL DEFAULT 0 CHECK(scrub_required IN (0,1))
);

-- Unique physical-item labels must remain unique under concurrent admin edits.
CREATE UNIQUE INDEX IF NOT EXISTS product_units_unique_label_idx
  ON product_units(family_id,unit_label COLLATE NOCASE);

-- An invalid condition aborts a D1 batch, including every associated write.
-- Successful batches remove their guard row; no customer data is stored here.
CREATE TABLE IF NOT EXISTS cf_integrity_guard (
  id TEXT PRIMARY KEY, passed INTEGER NOT NULL CHECK(passed=1)
);

-- Private upload drafts and multipart ETags; never returned by the catalog.
CREATE TABLE IF NOT EXISTS cloud_media_uploads (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  manifest TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading','ready','failed')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cloud_media_uploads_created_idx ON cloud_media_uploads(created_at);
CREATE TABLE IF NOT EXISTS cloud_media_parts (
  upload_id TEXT NOT NULL REFERENCES cloud_media_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY(upload_id,part_number)
);
