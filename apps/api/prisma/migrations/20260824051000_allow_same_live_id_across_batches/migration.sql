-- A stable live_id can legitimately appear in more than one source batch.
-- Keep each imported row unique by (batch_id, row_number) instead.
DROP INDEX IF EXISTS "live_session_live_id_key";
