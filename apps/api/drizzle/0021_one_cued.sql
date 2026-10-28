-- Only one queue entry is cued (on air next); tracks the player loaded behind it are `loaded`.
ALTER TYPE "public"."queue_state" ADD VALUE IF NOT EXISTS 'loaded';
