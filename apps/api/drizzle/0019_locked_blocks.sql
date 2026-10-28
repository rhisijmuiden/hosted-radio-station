-- A queue entry from a locked item of the hour clock: DJs cannot skip it or play something else over it.
ALTER TABLE "queue_items" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;
