CREATE TABLE "node_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"kind" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_metrics" (
	"node_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"rtt_avg" double precision,
	"rtt_max" double precision,
	"pings" integer DEFAULT 0 NOT NULL,
	"lost" integer DEFAULT 0 NOT NULL,
	"cpu" double precision,
	"memory" double precision,
	"rx_bps" double precision,
	"tx_bps" double precision,
	"listeners" integer,
	CONSTRAINT "node_metrics_node_id_at_pk" PRIMARY KEY("node_id","at")
);
--> statement-breakpoint
CREATE TABLE "node_probes" (
	"node_id" uuid NOT NULL,
	"target" text NOT NULL,
	"station_id" uuid NOT NULL,
	"url" text NOT NULL,
	"ok" boolean NOT NULL,
	"http_status" integer,
	"ttfb_ms" integer,
	"message" text,
	"checked_at" timestamp with time zone NOT NULL,
	"last_ok_at" timestamp with time zone,
	"buckets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "node_probes_node_id_target_pk" PRIMARY KEY("node_id","target")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"name" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pairing_code_hash" text,
	"pairing_expires_at" timestamp with time zone,
	"secret" text,
	"paired_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"status" jsonb DEFAULT '{"online":false}'::jsonb NOT NULL,
	"clients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listener_sessions" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD COLUMN "ingest_node_id" uuid;--> statement-breakpoint
ALTER TABLE "node_events" ADD CONSTRAINT "node_events_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_metrics" ADD CONSTRAINT "node_metrics_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_probes" ADD CONSTRAINT "node_probes_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_probes" ADD CONSTRAINT "node_probes_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_events_node_idx" ON "node_events" USING btree ("node_id","at");--> statement-breakpoint
CREATE INDEX "node_metrics_at_idx" ON "node_metrics" USING btree ("at");--> statement-breakpoint
CREATE INDEX "node_probes_station_idx" ON "node_probes" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "nodes_tenant_idx" ON "nodes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_pairing_idx" ON "nodes" USING btree ("pairing_code_hash");--> statement-breakpoint
ALTER TABLE "listener_sessions" ADD CONSTRAINT "listener_sessions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_ingest_node_id_nodes_id_fk" FOREIGN KEY ("ingest_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "tenants" SET "limits" = "limits" || '{"maxNodes":0}'::jsonb WHERE NOT ("limits" ? 'maxNodes');
