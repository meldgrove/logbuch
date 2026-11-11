import { DEADLINE_END, renderDateTokens, type DateFormatter } from "@/lib/format";
import type { NotificationMessage } from "./types";

/* Turns a channel-neutral message into Slack mrkdwn or an email, in the reader's date format. */

const escapeSlack = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const deadlineLine = (deadline: NonNullable<NotificationMessage["deadline"]>, formatter: DateFormatter) =>
  `${deadline.label}: ${formatter.longDate(deadline.date)}, ${DEADLINE_END}`;

const urlOf = (message: NotificationMessage, baseUrl: string) => `${baseUrl.replace(/\/+$/, "")}${message.path}`;

/**
 * A Slack message: linked title, what to do, and the deadline. A channel post
 * also shows the summary, the impact, and the affected teams; a Large entry
 * is marked "Must read".
 */
export function slackText(message: NotificationMessage, baseUrl: string, formatter: DateFormatter): string {
  const post = message.post;
  const title = `*<${urlOf(message, baseUrl)}|${escapeSlack(`${message.ref} · ${message.title}`)}>*`;
  const lines = [post?.mustRead ? `*Must read* · ${title}` : title, escapeSlack(renderDateTokens(message.text, formatter))];
  if (message.deadline) lines.push(escapeSlack(deadlineLine(message.deadline, formatter)));
  if (post) {
    lines.push(`>${escapeSlack(post.summary).replace(/\n/g, "\n>")}`);
    const facts = [`${post.type}`, `Impact: ${post.impact}`];
    if (post.affectedTeams.length > 0) facts.push(`Affected teams: ${post.affectedTeams.join(", ")}`);
    lines.push(escapeSlack(facts.join(" · ")));
  }
  return lines.join("\n");
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const FOOTER = "You get this email because you take part in this entry in Logbuch.";

/** An email in plain text and HTML. */
export function emailContent(message: NotificationMessage, recipientName: string, baseUrl: string, formatter: DateFormatter): EmailContent {
  const url = urlOf(message, baseUrl);
  const heading = `${message.ref} · ${message.title}`;
  const body = renderDateTokens(message.text, formatter);
  const deadline = message.deadline ? deadlineLine(message.deadline, formatter) : undefined;
  const text = [`Hello ${recipientName},`, "", body, ...(deadline ? [deadline] : []), "", heading, url, "", FOOTER].join("\n");
  const html = [
    `<p>Hello ${escapeHtml(recipientName)},</p>`,
    `<p>${escapeHtml(body)}${deadline ? `<br>${escapeHtml(deadline)}` : ""}</p>`,
    `<p><a href="${escapeHtml(url)}">${escapeHtml(heading)}</a></p>`,
    `<p style="color:#666;font-size:12px">${escapeHtml(FOOTER)}</p>`,
  ].join("\n");
  return { subject: renderDateTokens(message.subject, formatter), text, html };
}
