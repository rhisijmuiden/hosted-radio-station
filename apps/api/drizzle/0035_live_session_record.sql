-- Phase 21 step 4: a DJ can stop or start the recording of a live broadcast from RHIS Studio.
ALTER TABLE "live_sessions" ADD COLUMN "record" boolean;
