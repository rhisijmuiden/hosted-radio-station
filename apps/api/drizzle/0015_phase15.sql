ALTER TABLE "tenant_domains" ADD COLUMN "target_label" text;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_target_label_unique" UNIQUE("target_label");
