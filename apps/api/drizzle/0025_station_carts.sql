CREATE TABLE "station_carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"color" text NOT NULL,
	"looped" boolean DEFAULT false NOT NULL,
	"ext" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "station_carts" ADD CONSTRAINT "station_carts_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "station_carts_button_idx" ON "station_carts" USING btree ("station_id","position");
