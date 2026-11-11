# Decision process

Logbuch knows three types of entries:

| Type | What it is |
|---|---|
| **Update** | News from a team: progress, a launch, a change of plan, a result |
| **Decision** | Something that was decided and now applies |
| **Learning** | Something a team learned, for example from a retrospective, an experiment, or a mistake |

There are two ways to create one:

- **Log something**: choose the type, fill in the form, and the entry is
  published right away. A decision logged this way documents a decision made
  elsewhere, for example in a meeting or within someone's role.
- **Start a proposal**: the decision process below. It always ends in a
  decision (or a rejection), with "How it was decided: Integrative decision
  process".

Every entry has an **impact**: Small (only the own team needs to know),
Medium (other teams should know), or Large (everyone should read it). Large
entries are marked "Must read" and stay at the top of the timeline for 14
days.

Every form that creates or changes content asks to confirm that the entry
contains no personal data, because everyone with access can read every entry.

## Roles

| Role | Who | Can do |
|---|---|---|
| Proposer | Whoever starts the proposal | Edit the proposal (each edit is a new version), choose people, extend deadlines, start the objection round, answer questions, withdraw |
| Decider | Exactly one person, by default the proposer | Publish the decision once the criteria are met, or reject the proposal |
| Consent givers | One-way proposals only, chosen by the proposer | Give a Go, or raise an objection that blocks |
| Feedback givers | Chosen by the proposer | Are asked for feedback; their objections do not block |
| Everyone with access | | Read, ask questions, give feedback, raise objections that do not block |
| Admins | | Manage tags and default periods, replace a consent giver in a stuck process with a recorded reason, add addenda |

## Phases

```text
draft ──▶ feedback ──▶ objection round ──▶ decided
            │                 │
            ├── reject ──▶ rejected ◀── reject ──┤
            └── withdraw ─▶ withdrawn ◀ withdraw ┘
```

1. **Draft**: only the proposer sees it. The proposer writes the question,
   the context, and the proposal, and chooses the decider and the people to
   ask. A draft that was never submitted can be discarded.
2. **Feedback**: everyone can ask questions and give feedback; the people
   asked are notified. The proposer refines the proposal; each change is a
   new version with a change note.
3. **Objection round**: "Is it safe enough to try?" Everyone answers with a
   Go or an objection with a reason. The proposer integrates objections; the
   objector marks an objection resolved.
4. **Decided**: the decider publishes the decision text and the rationale.
   For a two-way decision with open objections, the decider must say how they
   were addressed.

## Two-way and one-way decisions

Every decision is either two-way (easy to reverse) or one-way (not
reversible, or only at high cost).

| | Two-way | One-way |
|---|---|---|
| Consent givers | None | At least one |
| Objections | Recorded and must be addressed, but never block | Objections of consent givers block |
| Default feedback period | 2 working days | 5 working days |
| Default objection period | 1 working day | 3 working days |
| Minimum periods | 1 working day each | 5 and 3 working days |
| Objection round starts | After the feedback deadline, or once everyone asked has given feedback | After the feedback deadline |
| No answer by the deadline | Counts as no objection | Does not count as a Go; the decision stays blocked |
| Ready to publish | The objection deadline has passed, or everyone asked has answered | Every consent giver gave a Go on the current version, and no objection of a consent giver is open |

A new version of a one-way proposal resets every Go: consent givers confirm
again. Admins can change the default periods; nobody can go below the
minimums.

Working days are Monday to Friday. A deadline ends at 23:59 on its date in
the server's time zone.

## After a decision

- A published decision is never edited. Its decider, its author, or an admin
  adds an **addendum** to correct or complete it.
- A newer decision can **replace** an older one ("Supersedes"). The older one
  keeps its status and is marked as replaced. A one-way decision can only be
  replaced through another one-way proposal.
- A **review date** reminds the decider and the author to check whether the
  decision works.

## Notifications

Process events (feedback requested, a question answered, an objection raised,
ready to decide, and so on) go to the people involved as Slack direct
messages. Reminders go by email at 09:00 on working days: before a deadline,
when the objection round has not been started, when a one-way decision is
blocked, when a decision is ready but not published, and on review dates.
When one channel is not set up, cannot reach a person, or keeps failing, the
message goes out on the other. Nobody is told about their own actions, and
messages never contain the proposal text. Every person also sees what is
waiting for them under **My tasks**.
