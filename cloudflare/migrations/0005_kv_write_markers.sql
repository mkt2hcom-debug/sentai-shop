-- A non-expiring write marker prevents delete-before-put races and false quota
-- release when a Worker stops before it confirms whether KV.put completed.
-- Historical code called this field a lease; UUID markers never expire by time.
ALTER TABLE cloud_media_objects ADD COLUMN lease_until TEXT;
