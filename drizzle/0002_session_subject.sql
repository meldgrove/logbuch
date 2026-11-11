-- Sessions record the OIDC `sub` they logged in with. Existing sessions do
-- not know theirs, so they end: everyone logs in once more. Adding the column
-- first locks the table until the migration commits, so no session without a
-- subject can be created in between.
ALTER TABLE "auth_session" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
DELETE FROM "auth_session";--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "oidc_subject" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_session_oidc_subject_idx" ON "auth_session" USING btree ("oidc_subject");
