ALTER TABLE "stations" ADD COLUMN "news" jsonb DEFAULT '{}'::jsonb NOT NULL;
