-- Cue points of a track, in seconds from the start of the file (RHIS Studio cue editor).
ALTER TABLE "media_files" ADD COLUMN "cue_in" double precision;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "cue_intro" double precision;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "cue_segue" double precision;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "cue_fade_out" double precision;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "cue_out" double precision;
