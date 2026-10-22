CREATE INDEX notes_created_range_idx
  ON notes (archived, pinned DESC, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX notes_url_recent_idx
  ON notes (url, updated_at DESC, id DESC);
