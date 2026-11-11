-- Logbuch never deletes data. Only unsubmitted drafts may be discarded, and
-- the audit log is append-only. Better Auth tables, rate limits, and the link
-- tables entry_tag and entry_relation (changed when an update is edited; every
-- revision keeps a snapshot) are not covered.

CREATE FUNCTION logbuch_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Logbuch never deletes rows from %', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION logbuch_forbid_entry_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Only unsubmitted drafts can be deleted, not % entries', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
-- Rows that belong to a draft entry may be deleted together with it.
CREATE FUNCTION logbuch_forbid_delete_unless_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM entry WHERE entry.id = OLD.entry_id AND entry.status = 'draft') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Logbuch never deletes rows from %', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION logbuch_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER entry_no_delete BEFORE DELETE ON entry FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_entry_delete();
--> statement-breakpoint
CREATE TRIGGER person_no_delete BEFORE DELETE ON person FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER person_active_month_no_delete BEFORE DELETE ON person_active_month FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER team_no_delete BEFORE DELETE ON team FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER tag_no_delete BEFORE DELETE ON tag FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER participant_no_delete BEFORE DELETE ON participant FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete_unless_draft();
--> statement-breakpoint
CREATE TRIGGER proposal_no_delete BEFORE DELETE ON proposal FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete_unless_draft();
--> statement-breakpoint
CREATE TRIGGER proposal_version_no_delete BEFORE DELETE ON proposal_version FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete_unless_draft();
--> statement-breakpoint
CREATE TRIGGER response_no_delete BEFORE DELETE ON response FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER outcome_no_delete BEFORE DELETE ON outcome FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER entry_revision_no_delete BEFORE DELETE ON entry_revision FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER entry_revision_no_update BEFORE UPDATE ON entry_revision FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_update();
--> statement-breakpoint
CREATE TRIGGER addendum_no_delete BEFORE DELETE ON addendum FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER addendum_no_update BEFORE UPDATE ON addendum FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_update();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_update();
--> statement-breakpoint
CREATE TRIGGER app_setting_no_delete BEFORE DELETE ON app_setting FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER notification_delivery_no_delete BEFORE DELETE ON notification_delivery FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER webhook_state_no_delete BEFORE DELETE ON webhook_state FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER entry_import_no_delete BEFORE DELETE ON entry_import FOR EACH ROW EXECUTE FUNCTION logbuch_forbid_delete();
--> statement-breakpoint
-- The statistics count activity from this moment on and show earlier months as not recorded.
INSERT INTO app_setting (key, value) VALUES ('activity_tracking_since', to_jsonb(now())) ON CONFLICT (key) DO NOTHING;
