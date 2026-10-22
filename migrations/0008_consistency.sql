-- A durable claim prevents restoration/upload while R2 deletion is in progress.
-- Claims survive interruption and are retried by the existing daily cleanup.
CREATE TABLE note_deletions (
  note_id TEXT PRIMARY KEY,
  r2_keys TEXT NOT NULL
);

CREATE TRIGGER prevent_restore_during_deletion BEFORE UPDATE ON notes
WHEN NEW.deleted_at IS NULL AND EXISTS (SELECT 1 FROM note_deletions WHERE note_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'note_deletion_in_progress'); END;
CREATE TRIGGER prevent_attachment_insert_during_deletion BEFORE INSERT ON attachments
WHEN EXISTS (SELECT 1 FROM note_deletions WHERE note_id = NEW.note_id)
BEGIN SELECT RAISE(ABORT, 'note_deletion_in_progress'); END;
CREATE TRIGGER prevent_attachment_update_during_deletion BEFORE UPDATE ON attachments
WHEN EXISTS (SELECT 1 FROM note_deletions WHERE note_id = NEW.note_id OR note_id = OLD.note_id)
BEGIN SELECT RAISE(ABORT, 'note_deletion_in_progress'); END;

-- A single indexed row makes change checks independent of note count and sort.
CREATE TABLE data_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT INTO data_revision VALUES (1, 0);
CREATE TRIGGER revision_notes_insert AFTER INSERT ON notes BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_notes_update AFTER UPDATE ON notes BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_notes_delete AFTER DELETE ON notes BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_attachments_insert AFTER INSERT ON attachments BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_attachments_update AFTER UPDATE ON attachments BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_attachments_delete AFTER DELETE ON attachments BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_checklist_insert AFTER INSERT ON checklist_items BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_checklist_update AFTER UPDATE ON checklist_items BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_checklist_delete AFTER DELETE ON checklist_items BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_labels_insert AFTER INSERT ON labels BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_labels_update AFTER UPDATE ON labels BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_labels_delete AFTER DELETE ON labels BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_note_labels_insert AFTER INSERT ON note_labels BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_note_labels_delete AFTER DELETE ON note_labels BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_groups_insert AFTER INSERT ON label_groups BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_groups_update AFTER UPDATE ON label_groups BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_groups_delete AFTER DELETE ON label_groups BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_deletions_insert AFTER INSERT ON note_deletions BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER revision_deletions_delete AFTER DELETE ON note_deletions BEGIN UPDATE data_revision SET revision = revision + 1 WHERE id = 1; END;
