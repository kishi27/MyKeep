-- Per-note change markers let clients reconcile only changed note payloads.
-- The table contains identifiers and counters only, never note contents.
CREATE TABLE note_sync_versions (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  sync_version INTEGER NOT NULL CHECK (sync_version >= 1)
);

INSERT INTO note_sync_versions (note_id, sync_version)
SELECT id, 1 FROM notes;

CREATE TRIGGER sync_notes_insert AFTER INSERT ON notes BEGIN
  INSERT INTO note_sync_versions (note_id, sync_version) VALUES (NEW.id, 1)
  ON CONFLICT(note_id) DO UPDATE SET sync_version = sync_version + 1;
END;
CREATE TRIGGER sync_notes_update AFTER UPDATE ON notes BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1 WHERE note_id = NEW.id;
END;

CREATE TRIGGER sync_attachments_insert AFTER INSERT ON attachments BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1 WHERE note_id = NEW.note_id;
END;
CREATE TRIGGER sync_attachments_update AFTER UPDATE ON attachments BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1 WHERE note_id = OLD.note_id;
  UPDATE note_sync_versions SET sync_version = sync_version + 1
  WHERE note_id = NEW.note_id AND NEW.note_id <> OLD.note_id;
END;
CREATE TRIGGER sync_attachments_delete AFTER DELETE ON attachments BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1 WHERE note_id = OLD.note_id;
END;

CREATE TRIGGER sync_checklist_insert AFTER INSERT ON checklist_items BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1 WHERE note_id = NEW.note_id;
END;
CREATE TRIGGER sync_checklist_update AFTER UPDATE ON checklist_items BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1 WHERE note_id = OLD.note_id;
  UPDATE note_sync_versions SET sync_version = sync_version + 1
  WHERE note_id = NEW.note_id AND NEW.note_id <> OLD.note_id;
END;
CREATE TRIGGER sync_checklist_delete AFTER DELETE ON checklist_items BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1 WHERE note_id = OLD.note_id;
END;

CREATE TRIGGER sync_note_labels_insert AFTER INSERT ON note_labels BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1 WHERE note_id = NEW.note_id;
END;
CREATE TRIGGER sync_note_labels_update AFTER UPDATE ON note_labels BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1 WHERE note_id = OLD.note_id;
  UPDATE note_sync_versions SET sync_version = sync_version + 1
  WHERE note_id = NEW.note_id AND NEW.note_id <> OLD.note_id;
END;
CREATE TRIGGER sync_note_labels_delete AFTER DELETE ON note_labels BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1 WHERE note_id = OLD.note_id;
END;
-- The earlier global revision migration covered label-link inserts and deletes,
-- but not a direct link update. Keep every relationship mutation observable.
CREATE TRIGGER revision_note_labels_update AFTER UPDATE ON note_labels BEGIN
  UPDATE data_revision SET revision = revision + 1 WHERE id = 1;
END;

-- Label renames change the rendered labels on each affected note. Group-only
-- updates do not change a note payload and intentionally do not bump versions.
CREATE TRIGGER sync_label_name_update AFTER UPDATE OF name ON labels
WHEN OLD.name IS NOT NEW.name BEGIN
  UPDATE note_sync_versions SET sync_version = sync_version + 1
  WHERE note_id IN (SELECT note_id FROM note_labels WHERE label_key = NEW.name_key);
END;
