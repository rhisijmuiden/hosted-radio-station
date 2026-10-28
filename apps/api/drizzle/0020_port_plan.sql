-- 1.3, port plan: every role gets its own ports (ingest 8200/8201, relay push 8301, Shoutcast v1 8210-8299). Nodes and
-- servers set up before keep their old ports open next to the new ones ("old ports") until the administrator switches
-- them off. A node with a port of its own choosing keeps its ports as they are and gets no old ports.
UPDATE "nodes" SET "config" = "config"
	|| jsonb_build_object(
		'sourcePlainPort', CASE WHEN "config"->'sourcePlainPort' = 'null'::jsonb THEN 'null'::jsonb ELSE '8200'::jsonb END,
		'sourceTlsPort', CASE WHEN "config"->'sourceTlsPort' = 'null'::jsonb THEN 'null'::jsonb ELSE '8201'::jsonb END,
		'pushPort', CASE WHEN "config"->'pushPort' = 'null'::jsonb THEN 'null'::jsonb ELSE '8301'::jsonb END,
		'oldPorts', true)
WHERE coalesce("config"->'sourcePlainPort', '8010'::jsonb) IN ('8010'::jsonb, 'null'::jsonb)
	AND coalesce("config"->'sourceTlsPort', '8443'::jsonb) IN ('8443'::jsonb, 'null'::jsonb)
	AND coalesce("config"->'pushPort', '8001'::jsonb) IN ('8001'::jsonb, 'null'::jsonb);
--> statement-breakpoint
-- This server: the old encoder ports stay open next to the new ones when it used the defaults; a fresh install (no
-- users yet) starts without them.
INSERT INTO "settings" ("key", "value")
SELECT 'orchestrator', '{"oldPorts": true}'::jsonb
WHERE EXISTS (SELECT 1 FROM "users")
	AND NOT EXISTS (
		SELECT 1 FROM "settings" WHERE "key" = 'streaming'
		AND (coalesce("value"->'ingestTlsPort', '8443'::jsonb) <> '8443'::jsonb OR coalesce("value"->'ingestPlainPort', '8010'::jsonb) NOT IN ('8010'::jsonb, '0'::jsonb)))
ON CONFLICT ("key") DO UPDATE SET "value" = "settings"."value" || '{"oldPorts": true}'::jsonb;
--> statement-breakpoint
UPDATE "settings" SET "value" = "value"
	|| CASE WHEN "value"->'ingestTlsPort' = '8443'::jsonb THEN '{"ingestTlsPort": 8201}'::jsonb ELSE '{}'::jsonb END
	|| CASE WHEN "value"->'ingestPlainPort' = '8010'::jsonb THEN '{"ingestPlainPort": 8200}'::jsonb ELSE '{}'::jsonb END
	|| CASE WHEN "value"->'legacyPortFrom' = '8100'::jsonb AND "value"->'legacyPortTo' = '8199'::jsonb THEN '{"legacyPortFrom": 8210, "legacyPortTo": 8299}'::jsonb ELSE '{}'::jsonb END
WHERE "key" = 'streaming';
