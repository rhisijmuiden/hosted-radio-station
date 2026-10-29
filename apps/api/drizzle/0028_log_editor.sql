ALTER TABLE "queue_items" ADD COLUMN "slot" text;--> statement-breakpoint
ALTER TABLE "queue_items" ADD COLUMN "slot_hour" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "autodj_state" ADD COLUMN "clock_n" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "queue_items_slot_idx" ON "queue_items" USING btree ("station_id","slot");
