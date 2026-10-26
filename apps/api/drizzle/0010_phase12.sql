ALTER TABLE "stations" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "node_runtime" jsonb;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "node_move" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "station_node_id" uuid;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_station_node_id_nodes_id_fk" FOREIGN KEY ("station_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stations_node_idx" ON "stations" USING btree ("node_id");