CREATE TABLE "studio_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"layout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_profiles" ADD CONSTRAINT "studio_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
