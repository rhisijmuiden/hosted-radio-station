ALTER TABLE "node_probes" ADD COLUMN "bitrate_kbps" integer;--> statement-breakpoint
ALTER TABLE "node_probes" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "node_probes" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "node_probes" ADD COLUMN "level_db" double precision;--> statement-breakpoint
ALTER TABLE "node_probes" ADD COLUMN "silent" boolean;
