CREATE TYPE "public"."backup_run_kind" AS ENUM('full', 'incremental', 'restore');--> statement-breakpoint
CREATE TYPE "public"."backup_run_state" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."backup_target_type" AS ENUM('ftp', 'ftps', 'sftp', 'onedrive', 'local');--> statement-breakpoint
CREATE TYPE "public"."sso_type" AS ENUM('oidc', 'saml');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_email" text,
	"via" text NOT NULL,
	"tenant_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"success" boolean DEFAULT true NOT NULL,
	"ip" text,
	"user_agent" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid,
	"target_name" text NOT NULL,
	"kind" "backup_run_kind" NOT NULL,
	"state" "backup_run_state" DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" text,
	"params" jsonb,
	"snapshot_id" text,
	"files_new" integer,
	"files_changed" integer,
	"bytes_added" bigint,
	"bytes_total" bigint,
	"message" text,
	"log" text DEFAULT '' NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backup_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "backup_target_type" NOT NULL,
	"config" jsonb NOT NULL,
	"repo_password" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule" jsonb NOT NULL,
	"retention" jsonb NOT NULL,
	"last_full_slot_at" timestamp with time zone,
	"last_incremental_slot_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"type" "sso_type" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"email_domains" text[] DEFAULT '{}' NOT NULL,
	"allow_password_login" boolean DEFAULT true NOT NULL,
	"auto_create_users" boolean DEFAULT false NOT NULL,
	"default_role" "member_role" DEFAULT 'dj' NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_tenant_id_subject_pk" PRIMARY KEY("tenant_id","subject")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_target_id_backup_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."backup_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_tokens" ADD CONSTRAINT "password_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_idx" ON "audit_log" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id","at");--> statement-breakpoint
CREATE INDEX "backup_runs_queued_idx" ON "backup_runs" USING btree ("queued_at");--> statement-breakpoint
CREATE INDEX "backup_runs_target_idx" ON "backup_runs" USING btree ("target_id","queued_at");--> statement-breakpoint
CREATE INDEX "password_tokens_user_idx" ON "password_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");