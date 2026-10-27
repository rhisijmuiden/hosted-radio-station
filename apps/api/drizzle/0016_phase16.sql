CREATE TABLE "node_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"token_hash" text NOT NULL,
	"hostname" text DEFAULT '' NOT NULL,
	"ip" text,
	"addresses" text[] DEFAULT '{}' NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"preferred_role" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"node_id" uuid,
	"secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_registrations" ADD CONSTRAINT "node_registrations_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "node_registrations_token_idx" ON "node_registrations" USING btree ("token_hash");
