-- Phase 21 step 2: a recorded live show knows the broadcast it records.
ALTER TABLE "recordings" ADD COLUMN "session_id" uuid;
