CREATE TABLE label_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

ALTER TABLE labels
ADD COLUMN group_id TEXT DEFAULT NULL REFERENCES label_groups(id) ON DELETE SET NULL;

CREATE INDEX labels_group_id_idx ON labels (group_id);
