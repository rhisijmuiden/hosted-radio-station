-- 1.3: a station has one queue. Waiting Q2 tracks go to the end of Q1, in their order; playlists of Q2 feed Q1.
UPDATE "queue_items" AS qi SET "queue" = 'q1', "position" = sub.newpos FROM (
	SELECT q."id", coalesce((SELECT max(m."position") FROM "queue_items" m WHERE m."station_id" = q."station_id" AND m."queue" = 'q1'), 0)
		+ row_number() OVER (PARTITION BY q."station_id" ORDER BY q."position") AS newpos
	FROM "queue_items" q WHERE q."queue" = 'q2'
) AS sub WHERE qi."id" = sub."id";
--> statement-breakpoint
UPDATE "playlists" SET "queue" = 'q1' WHERE "queue" = 'q2';
