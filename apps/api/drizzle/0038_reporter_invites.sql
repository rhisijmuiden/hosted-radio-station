-- Reporter mode, step 1: the invitation code reporters on location join a broadcast with.
CREATE TABLE "reporter_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reporter_invites" ADD CONSTRAINT "reporter_invites_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reporter_invites" ADD CONSTRAINT "reporter_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "reporter_invites_station_idx" ON "reporter_invites" USING btree ("station_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "reporter_invites_code_idx" ON "reporter_invites" USING btree ("code");
