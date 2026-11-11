import type { ProposalStatus } from "@/lib/process/rules";

export const STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: "Draft",
  feedback: "Feedback",
  objection_round: "Objection round",
  decided: "Decided",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** A proposal is a decision in progress: its badge says where it stands. */
export const PROPOSAL_BADGES: Record<ProposalStatus, string> = {
  draft: "Draft proposal",
  feedback: "Proposal: feedback",
  objection_round: "Proposal: objection round",
  decided: "Decided by proposal",
  rejected: "Rejected proposal",
  withdrawn: "Withdrawn proposal",
};
