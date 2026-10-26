ALTER TABLE "live_sessions" ADD COLUMN "on_node" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "routing" jsonb DEFAULT '{}'::jsonb NOT NULL;