CREATE TABLE "addendum" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entry_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"personal_data_confirmed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entry_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"reversibility" text,
	"reversibility_reason" text,
	"decider_id" uuid NOT NULL,
	"how_decided" text NOT NULL,
	"effective_date" date,
	"review_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_reversibility_check" CHECK ("decision"."reversibility" is null or "decision"."reversibility" in ('two_way', 'one_way')),
	CONSTRAINT "decision_how_decided_check" CHECK ("decision"."how_decided" in ('integrative_process', 'role_decision', 'management_decision', 'other'))
);
--> statement-breakpoint
CREATE TABLE "directory_sync_run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"people_received" integer,
	"teams_received" integer,
	"access_granted" integer,
	"access_removed" integer,
	"sessions_ended" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "entry" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "entry_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"impact" text,
	"team_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supersedes_id" uuid,
	"superseded_by_id" uuid,
	"personal_data_confirmed_at" timestamp with time zone,
	"search_text" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(summary, '')), 'B') || setweight(to_tsvector('simple', coalesce(summary, '')), 'B') || setweight(to_tsvector('english', coalesce(search_text, '')), 'C') || setweight(to_tsvector('simple', coalesce(search_text, '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_number_unique" UNIQUE("number"),
	CONSTRAINT "entry_type_check" CHECK ("entry"."type" in ('update', 'decision', 'learning')),
	CONSTRAINT "entry_status_check" CHECK ("entry"."status" in ('draft', 'feedback', 'objection_round', 'decided', 'rejected', 'withdrawn', 'published')),
	CONSTRAINT "entry_impact_check" CHECK ("entry"."impact" is null or "entry"."impact" in ('small', 'medium', 'large'))
);
--> statement-breakpoint
CREATE TABLE "entry_affected_team" (
	"entry_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "entry_affected_team_entry_id_team_id_pk" PRIMARY KEY("entry_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "entry_import" (
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_import_source_external_id_pk" PRIMARY KEY("source","external_id"),
	CONSTRAINT "entry_import_entry_id_unique" UNIQUE("entry_id")
);
--> statement-breakpoint
CREATE TABLE "entry_relation" (
	"entry_id" uuid NOT NULL,
	"related_entry_id" uuid NOT NULL,
	CONSTRAINT "entry_relation_entry_id_related_entry_id_pk" PRIMARY KEY("entry_id","related_entry_id"),
	CONSTRAINT "entry_relation_not_self" CHECK ("entry_relation"."entry_id" <> "entry_relation"."related_entry_id")
);
--> statement-breakpoint
CREATE TABLE "entry_revision" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entry_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"rationale" text NOT NULL,
	"impact" text,
	"team_id" uuid NOT NULL,
	"tag_ids" jsonb NOT NULL,
	"affected_team_ids" jsonb NOT NULL,
	"links" jsonb NOT NULL,
	"related_entry_ids" jsonb NOT NULL,
	"edited_by_id" uuid NOT NULL,
	"personal_data_confirmed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_tag" (
	"entry_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "entry_tag_entry_id_tag_id_pk" PRIMARY KEY("entry_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"delivery_key" text NOT NULL,
	"event" text NOT NULL,
	"entry_id" uuid,
	"recipient_id" uuid,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "notification_delivery_delivery_key_unique" UNIQUE("delivery_key"),
	CONSTRAINT "notification_delivery_channel_check" CHECK ("notification_delivery"."channel" in ('slack', 'email', 'slack_channel')),
	CONSTRAINT "notification_delivery_status_check" CHECK ("notification_delivery"."status" in ('pending', 'sent', 'skipped', 'failed')),
	CONSTRAINT "notification_delivery_recipient_check" CHECK (("notification_delivery"."channel" = 'slack_channel') = ("notification_delivery"."recipient_id" is null))
);
--> statement-breakpoint
CREATE TABLE "outcome" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"result" text NOT NULL,
	"final_text" text NOT NULL,
	"objection_handling" text,
	"decided_by_id" uuid NOT NULL,
	"decided_on" date NOT NULL,
	"personal_data_confirmed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_result_check" CHECK ("outcome"."result" in ('adopted', 'rejected', 'withdrawn', 'recorded'))
);
--> statement-breakpoint
CREATE TABLE "participant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entry_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_id" uuid,
	"removal_reason" text,
	CONSTRAINT "participant_role_check" CHECK ("participant"."role" in ('involved', 'consent_giver', 'feedback_giver'))
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"external_id" text,
	"oidc_subject" text,
	"display_name" text NOT NULL,
	"work_email" text,
	"team_id" uuid,
	"has_access" boolean DEFAULT false NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"access_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_in_directory_at" timestamp with time zone,
	"time_zone" text,
	"date_format" text,
	"slack_user_id" text,
	"slack_lookup_failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "person_oidc_subject_unique" UNIQUE("oidc_subject")
);
--> statement-breakpoint
CREATE TABLE "person_active_month" (
	"person_id" uuid NOT NULL,
	"month" date NOT NULL,
	CONSTRAINT "person_active_month_person_id_month_pk" PRIMARY KEY("person_id","month")
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"feedback_deadline" date NOT NULL,
	"objection_period_days" integer NOT NULL,
	"objection_round_started_at" timestamp with time zone,
	"objection_deadline" date,
	"current_version" integer DEFAULT 1 NOT NULL,
	"go_reset_at" timestamp with time zone,
	"ready_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_objection_period_check" CHECK ("proposal"."objection_period_days" >= 1)
);
--> statement-breakpoint
CREATE TABLE "proposal_version" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entry_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"text" text NOT NULL,
	"change_note" text,
	"created_by_id" uuid NOT NULL,
	"personal_data_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "response" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entry_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version_id" uuid NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"parent_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by_id" uuid,
	"resolution_note" text,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "response_kind_check" CHECK ("response"."kind" in ('question', 'answer', 'feedback', 'go', 'objection'))
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_state" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone,
	"payload_hash" text,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeat" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	"channels" jsonb
);
--> statement-breakpoint
ALTER TABLE "addendum" ADD CONSTRAINT "addendum_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addendum" ADD CONSTRAINT "addendum_author_id_person_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_setting" ADD CONSTRAINT "app_setting_updated_by_id_person_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_person_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_decider_id_person_id_fk" FOREIGN KEY ("decider_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry" ADD CONSTRAINT "entry_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry" ADD CONSTRAINT "entry_author_id_person_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry" ADD CONSTRAINT "entry_supersedes_id_entry_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry" ADD CONSTRAINT "entry_superseded_by_id_entry_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_affected_team" ADD CONSTRAINT "entry_affected_team_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_affected_team" ADD CONSTRAINT "entry_affected_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_import" ADD CONSTRAINT "entry_import_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_relation" ADD CONSTRAINT "entry_relation_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_relation" ADD CONSTRAINT "entry_relation_related_entry_id_entry_id_fk" FOREIGN KEY ("related_entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_revision" ADD CONSTRAINT "entry_revision_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_revision" ADD CONSTRAINT "entry_revision_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_revision" ADD CONSTRAINT "entry_revision_edited_by_id_person_id_fk" FOREIGN KEY ("edited_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_tag" ADD CONSTRAINT "entry_tag_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_tag" ADD CONSTRAINT "entry_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_recipient_id_person_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome" ADD CONSTRAINT "outcome_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome" ADD CONSTRAINT "outcome_decided_by_id_person_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_added_by_id_person_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_removed_by_id_person_id_fk" FOREIGN KEY ("removed_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_active_month" ADD CONSTRAINT "person_active_month_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_version" ADD CONSTRAINT "proposal_version_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_version" ADD CONSTRAINT "proposal_version_created_by_id_person_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response" ADD CONSTRAINT "response_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response" ADD CONSTRAINT "response_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response" ADD CONSTRAINT "response_version_id_proposal_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."proposal_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response" ADD CONSTRAINT "response_parent_id_response_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."response"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response" ADD CONSTRAINT "response_resolved_by_id_person_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_state" ADD CONSTRAINT "webhook_state_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addendum_entry_id_idx" ON "addendum" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "audit_event_entry_id_idx" ON "audit_event" USING btree ("entry_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_account_provider_account_idx" ON "auth_account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "directory_sync_run_started_at_idx" ON "directory_sync_run" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "entry_published_at_idx" ON "entry" USING btree ("published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "entry_team_id_idx" ON "entry" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "entry_author_id_idx" ON "entry" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "entry_search_vector_idx" ON "entry" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_revision_entry_revision_idx" ON "entry_revision" USING btree ("entry_id","revision");--> statement-breakpoint
CREATE INDEX "entry_tag_tag_id_idx" ON "entry_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_pending_idx" ON "notification_delivery" USING btree ("next_attempt_at") WHERE "notification_delivery"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "notification_delivery_entry_id_idx" ON "notification_delivery" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_status_idx" ON "notification_delivery" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "participant_active_role_idx" ON "participant" USING btree ("entry_id","person_id","role") WHERE "participant"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "participant_person_id_idx" ON "participant" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_has_access_idx" ON "person" USING btree ("has_access");--> statement-breakpoint
CREATE INDEX "person_work_email_lower_idx" ON "person" USING btree (lower("work_email"));--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_version_entry_number_idx" ON "proposal_version" USING btree ("entry_id","number");--> statement-breakpoint
CREATE INDEX "response_entry_id_idx" ON "response" USING btree ("entry_id","created_at");--> statement-breakpoint
CREATE INDEX "response_person_id_idx" ON "response" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_name_lower_idx" ON "tag" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "webhook_state_requested_idx" ON "webhook_state" USING btree ("requested_at") WHERE "webhook_state"."requested_at" is not null;