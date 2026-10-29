-- The edition moves from the customer to each station: customers and packages get "maxRadioStations" instead.
UPDATE "tenants" SET "limits" = "limits" || jsonb_build_object('maxRadioStations', CASE WHEN "plan" = 'station' THEN COALESCE(("limits"->>'maxStations')::int, 1) ELSE 0 END) WHERE NOT ("limits" ? 'maxRadioStations');--> statement-breakpoint
UPDATE "packages" SET "limits" = "limits" || jsonb_build_object('maxRadioStations', CASE WHEN "edition" = 'station' THEN COALESCE(("limits"->>'maxStations')::int, 1) ELSE 0 END) WHERE NOT ("limits" ? 'maxRadioStations');
