CREATE TABLE "studio_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code" text NOT NULL,
	"device_secret_hash" text NOT NULL,
	"device_name" text NOT NULL,
	"client_version" text,
	"ip" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"api_key_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_live_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_links" ADD CONSTRAINT "studio_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_links" ADD CONSTRAINT "studio_links_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_live_tokens" ADD CONSTRAINT "studio_live_tokens_account_id_station_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."station_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_live_tokens" ADD CONSTRAINT "studio_live_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "studio_links_code_idx" ON "studio_links" USING btree ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_links_secret_idx" ON "studio_links" USING btree ("device_secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_live_tokens_hash_idx" ON "studio_live_tokens" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "studio_live_tokens_account_idx" ON "studio_live_tokens" USING btree ("account_id");