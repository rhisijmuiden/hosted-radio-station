CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"node_id" uuid,
	"station_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"notified" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_key_idx" ON "alerts" USING btree ("key") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "alerts_opened_idx" ON "alerts" USING btree ("opened_at");
