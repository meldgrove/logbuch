import type { Database, Transaction } from "@/lib/db/client";
import { auditEvent } from "@/lib/db/schema";

export type AuditAction =
  | "entry.published"
  | "entry.edited"
  | "entry.superseded"
  | "entry.addendum_added"
  | "entry.impact_changed"
  | "tag.created"
  | "tag.renamed"
  | "tag.activated"
  | "tag.deactivated"
  | "settings.periods_changed"
  | "person.invited"
  | "person.linked"
  | "person.first_admin"
  | "person.access_granted"
  | "person.access_revoked"
  | "person.admin_granted"
  | "person.admin_revoked"
  | "person.updated"
  | "team.created"
  | "team.renamed"
  | "team.activated"
  | "team.deactivated"
  | "proposal.submitted"
  | "proposal.version_added"
  | "proposal.question_asked"
  | "proposal.question_answered"
  | "proposal.feedback_given"
  | "proposal.go_given"
  | "proposal.go_withdrawn"
  | "proposal.objection_raised"
  | "proposal.objection_resolved"
  | "proposal.objection_round_started"
  | "proposal.deadline_extended"
  | "proposal.type_changed"
  | "proposal.participant_added"
  | "proposal.participant_removed"
  | "proposal.decider_changed"
  | "proposal.decided"
  | "proposal.rejected"
  | "proposal.withdrawn";

/** Appends an audit event in the caller's transaction. Rows are never changed or deleted. */
export async function recordAudit(
  db: Database | Transaction,
  event: { actorId: string | null; action: AuditAction; entryId?: string; payload?: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditEvent).values({
    actorId: event.actorId,
    action: event.action,
    entryId: event.entryId,
    payload: event.payload ?? {},
  });
}
