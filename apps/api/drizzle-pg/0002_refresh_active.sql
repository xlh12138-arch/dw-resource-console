ALTER TABLE "refresh_tokens" ADD COLUMN "last_used_at" timestamp with time zone DEFAULT now() NOT NULL;
