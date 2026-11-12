CREATE TABLE "project_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"project_code" text NOT NULL,
	"project_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"created_by_id" integer,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_snapshots_project" ON "project_snapshots" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_snapshots_closed" ON "project_snapshots" USING btree ("closed_at");