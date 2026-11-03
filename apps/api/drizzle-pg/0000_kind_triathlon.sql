CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_id" integer,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"target_name" text,
	"changes" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "env_slots" (
	"id" serial PRIMARY KEY NOT NULL,
	"environment_id" integer NOT NULL,
	"resource_type" text NOT NULL,
	"slot_role" text NOT NULL,
	"resource_id" integer,
	"demand_amount" double precision,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"renew_count" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "env_template_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"resource_type" text NOT NULL,
	"slot_role" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"remark" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "env_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_by_id" integer,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"tone" text DEFAULT 'gray' NOT NULL,
	"color" text,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_environments" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"environment" text NOT NULL,
	"status" text DEFAULT 'PLANNING' NOT NULL,
	"template_id" integer,
	"owner" text,
	"description" text,
	"created_by_id" integer,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by_id" integer,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_type_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"type_code" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text DEFAULT 'TEXT' NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_value" text,
	"placeholder" text,
	"unit" text,
	"is_ip" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_types" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"prefix" text NOT NULL,
	"description" text,
	"ip_unique_by_port" boolean DEFAULT false NOT NULL,
	"list_columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"environment" text NOT NULL,
	"status" text DEFAULT 'IN_USE' NOT NULL,
	"datacenter" text,
	"owner" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"remark" text,
	"attrs" jsonb NOT NULL,
	"project_id" integer,
	"project_env_id" integer,
	"capacity_total" double precision,
	"capacity_unit" text,
	"capacity_remark" text,
	"parent_id" integer,
	"demand_amount" double precision,
	"created_by_id" integer,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'READONLY' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "env_slots" ADD CONSTRAINT "env_slots_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_slots" ADD CONSTRAINT "env_slots_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_template_items" ADD CONSTRAINT "env_template_items_template_id_env_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."env_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_template_id_env_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."env_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_type_fields" ADD CONSTRAINT "resource_type_fields_type_code_resource_types_code_fk" FOREIGN KEY ("type_code") REFERENCES "public"."resource_types"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_project_env_id_project_environments_id_fk" FOREIGN KEY ("project_env_id") REFERENCES "public"."project_environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_parent_id_resources_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_target" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "idx_audit_created" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_env_slots_env" ON "env_slots" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_env_slots_resource" ON "env_slots" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "idx_env_slots_period" ON "env_slots" USING btree ("start_at","end_at");--> statement-breakpoint
CREATE INDEX "idx_template_items_template" ON "env_template_items" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_env_templates_code" ON "env_templates" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_env_templates_updated" ON "env_templates" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_env" ON "project_environments" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "idx_project_env_project" ON "project_environments" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_projects_code" ON "projects" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_projects_status" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_projects_updated" ON "projects" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_refresh_token_hash" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_refresh_user" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_type_field" ON "resource_type_fields" USING btree ("type_code","key");--> statement-breakpoint
CREATE INDEX "idx_type_field_type" ON "resource_type_fields" USING btree ("type_code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_resources_code" ON "resources" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_resources_type" ON "resources" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_resources_status" ON "resources" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_resources_env" ON "resources" USING btree ("environment");--> statement-breakpoint
CREATE INDEX "idx_resources_project" ON "resources" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_resources_project_env" ON "resources" USING btree ("project_env_id");--> statement-breakpoint
CREATE INDEX "idx_resources_updated" ON "resources" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_resources_parent" ON "resources" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_username" ON "users" USING btree ("username");