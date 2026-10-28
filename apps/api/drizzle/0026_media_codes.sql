ALTER TABLE "media_files" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "isrc" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "bpm" double precision;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "music_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "analysed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_code_idx" ON "media_files" USING btree ("station_id","code");
