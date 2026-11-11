import { describe, expect, it, vi } from "vitest";
import { createDateFormatter, dateToken } from "@/lib/format";
import { emailContent, slackText } from "./format-message";
import { createMailerSendTransport, createSlackTransport, createSmtpTransport, DeliveryError } from "./transports";
import type { NotificationMessage } from "./types";

const MESSAGE: NotificationMessage = {
  subject: "Feedback requested: LB-12 Tools <& costs>",
  ref: "LB-12",
  title: "Tools <& costs>",
  text: "Pia asks for your feedback.",
  deadline: { label: "Feedback deadline", date: "2026-11-06" },
  path: "/e/LB-12",
};

// Tests run with TZ=Europe/Amsterdam, the time zone deadlines end in.
const fmt = createDateFormatter();

describe("message formats", () => {
  it("link the title in Slack, escape control characters, and show the deadline", () => {
    expect(slackText(MESSAGE, "https://logbuch.example/", fmt)).toBe(
      [
        "*<https://logbuch.example/e/LB-12|LB-12 · Tools &lt;&amp; costs&gt;>*",
        "Pia asks for your feedback.",
        "Feedback deadline: Friday, 06.11.2026, 23:59 (Europe/Amsterdam)",
      ].join("\n"),
    );
  });

  it("write dates in the reader's format", () => {
    const message = { ...MESSAGE, text: `The deadline passed on ${dateToken("2026-11-06")}.` };
    expect(slackText(message, "https://logbuch.example", createDateFormatter({ dateFormat: "MM/DD/YYYY" })).split("\n")).toEqual([
      "*<https://logbuch.example/e/LB-12|LB-12 · Tools &lt;&amp; costs&gt;>*",
      "The deadline passed on Friday, 11/06/2026.",
      "Feedback deadline: Friday, 11/06/2026, 23:59 (Europe/Amsterdam)",
    ]);
  });

  it("show a channel post's summary as a quote, with type, impact, and affected teams", () => {
    const post = { type: "Decision", summary: "One tool <for all>.\nFrom March.", impact: "Medium", mustRead: false, affectedTeams: ["Ops", "Tech"] };
    const text = slackText({ ...MESSAGE, deadline: undefined, post }, "https://logbuch.example", fmt);
    expect(text.split("\n")).toEqual([
      "*<https://logbuch.example/e/LB-12|LB-12 · Tools &lt;&amp; costs&gt;>*",
      "Pia asks for your feedback.",
      ">One tool &lt;for all&gt;.",
      ">From March.",
      "Decision · Impact: Medium · Affected teams: Ops, Tech",
    ]);
  });

  it("mark a Large entry as must read, and leave out empty affected teams", () => {
    const post = { type: "Update", summary: "Office closed.", impact: "Large", mustRead: true, affectedTeams: [] };
    const text = slackText({ ...MESSAGE, deadline: undefined, post }, "https://logbuch.example", fmt);
    expect(text.split("\n")[0]).toBe("*Must read* · *<https://logbuch.example/e/LB-12|LB-12 · Tools &lt;&amp; costs&gt;>*");
    expect(text.split("\n").at(-1)).toBe("Update · Impact: Large");
  });

  it("write emails in text and escaped HTML, without the proposal text", () => {
    const email = emailContent(MESSAGE, "Ana <Admin>", "https://logbuch.example", fmt);
    expect(email.subject).toBe(MESSAGE.subject);
    expect(email.text).toContain("Hello Ana <Admin>,\n\nPia asks for your feedback.\nFeedback deadline: Friday, 06.11.2026, 23:59 (Europe/Amsterdam)");
    expect(email.text).toContain("https://logbuch.example/e/LB-12");
    expect(email.html).toContain("Hello Ana &lt;Admin&gt;,");
    expect(email.html).toContain('<a href="https://logbuch.example/e/LB-12">LB-12 · Tools &lt;&amp; costs&gt;</a>');
  });
});

function fakeFetch(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no response");
    return next;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });

describe("Slack", () => {
  it("looks up a user by work email with the bot token", async () => {
    const { fetchImpl, calls } = fakeFetch(json({ ok: true, user: { id: "U123" } }));
    await expect(createSlackTransport("xoxb-1", fetchImpl).lookupUserByEmail("ana@example.org")).resolves.toBe("U123");
    expect(calls[0]!.url).toBe("https://slack.com/api/users.lookupByEmail?email=ana%40example.org");
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer xoxb-1" });
  });

  it("treats an unknown or deactivated user as no Slack account", async () => {
    const { fetchImpl } = fakeFetch(json({ ok: false, error: "users_not_found" }), json({ ok: true, user: { id: "U9", deleted: true } }));
    const slack = createSlackTransport("xoxb-1", fetchImpl);
    await expect(slack.lookupUserByEmail("x@example.org")).resolves.toBeNull();
    await expect(slack.lookupUserByEmail("y@example.org")).resolves.toBeNull();
  });

  it("sends a direct message to the user ID, without link previews", async () => {
    const { fetchImpl, calls } = fakeFetch(json({ ok: true }));
    await createSlackTransport("xoxb-1", fetchImpl).postMessage("U123", "Hello");
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ channel: "U123", text: "Hello", unfurl_links: false, unfurl_media: false });
  });

  it("reports Slack errors and rate limits so the worker can retry", async () => {
    const { fetchImpl } = fakeFetch(json({ ok: false, error: "invalid_auth" }), new Response("", { status: 429, headers: { "Retry-After": "30" } }));
    const slack = createSlackTransport("xoxb-1", fetchImpl);
    await expect(slack.postMessage("U1", "x")).rejects.toMatchObject({ name: "DeliveryError", code: "invalid_auth" });
    const limited = await slack.postMessage("U1", "x").catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(DeliveryError);
    expect((limited as DeliveryError).retryAfterMs).toBe(30_000);
  });

  it("marks errors that trying again cannot fix as permanent", async () => {
    const { fetchImpl } = fakeFetch(
      json({ ok: false, error: "invalid_auth" }),
      json({ ok: false, error: "missing_scope" }),
      json({ ok: false, error: "channel_not_found" }),
      json({ ok: false, error: "internal_error" }),
      json({ ok: false, error: "ratelimited" }),
      json({ ok: false, error: "rate_limited" }),
      new Response("", { status: 429 }),
      new Response("", { status: 503 }),
      new Response("", { status: 404 }),
      json({ ok: false }),
    );
    const slack = createSlackTransport("xoxb-1", fetchImpl);
    const permanent = async (send: Promise<unknown>) => ((await send.catch((error: unknown) => error)) as DeliveryError).permanent;
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(true);
    expect(await permanent(slack.lookupUserByEmail("ana@example.org"))).toBe(true);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(true);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(true);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false); // no error code
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false); // no response at all
  });
});

describe("MailerSend", () => {
  const options = { token: "mlsn.secret", from: "logbuch@example.org", fromName: "Logbuch" };
  const email = { to: "ana@example.org", toName: "Ana", subject: "S", text: "T", html: "<p>T</p>" };

  it("sends from the configured address", async () => {
    const { fetchImpl, calls } = fakeFetch(new Response(null, { status: 202 }));
    await createMailerSendTransport(options, fetchImpl).send(email);
    expect(calls[0]!.url).toBe("https://api.mailersend.com/v1/email");
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer mlsn.secret" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: { email: "logbuch@example.org", name: "Logbuch" },
      to: [{ email: "ana@example.org", name: "Ana" }],
      subject: "S",
      text: "T",
      html: "<p>T</p>",
    });
  });

  it("reports a rejected email with the status and body", async () => {
    const { fetchImpl } = fakeFetch(new Response('{"message":"The from.email domain must be verified"}', { status: 422 }));
    await expect(createMailerSendTransport(options, fetchImpl).send(email)).rejects.toThrow(/HTTP 422 .*must be verified/);
  });

  it("treats a rejected email as permanent, and outages and rate limits as temporary", async () => {
    const { fetchImpl } = fakeFetch(new Response("", { status: 401 }), new Response("", { status: 429 }), new Response("", { status: 502 }));
    const transport = createMailerSendTransport(options, fetchImpl);
    const permanent = async () => ((await transport.send(email).catch((error: unknown) => error)) as DeliveryError).permanent;
    expect([await permanent(), await permanent(), await permanent(), await permanent()]).toEqual([true, false, false, false]);
  });
});

describe("SMTP", () => {
  const email = { to: "ana@example.org", toName: "Ana", subject: "S", text: "T", html: "<p>T</p>" };

  function fakeNodemailer(sendMail: (message: unknown) => Promise<unknown>) {
    const created: unknown[] = [];
    const createTransport = ((options: unknown) => {
      created.push(options);
      return { sendMail };
    }) as unknown as Parameters<typeof createSmtpTransport>[1];
    return { createTransport, created };
  }

  it("sends through the SMTP URL from the configured address", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "1" }));
    const { createTransport, created } = fakeNodemailer(sendMail);
    await createSmtpTransport({ url: "smtps://user:pass@mail.example.org:465", from: "logbuch@example.org", fromName: "Logbuch" }, createTransport).send(email);
    expect(created[0]).toEqual({
      url: "smtps://user:pass@mail.example.org:465",
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 15_000,
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: "Logbuch", address: "logbuch@example.org" },
      to: { name: "Ana", address: "ana@example.org" },
      subject: "S",
      text: "T",
      html: "<p>T</p>",
    });
  });

  it("reports a rejected email with the server's reply code", async () => {
    const error = Object.assign(new Error("Mailbox unavailable"), { responseCode: 550, code: "EENVELOPE" });
    const { createTransport } = fakeNodemailer(async () => Promise.reject(error));
    const transport = createSmtpTransport({ url: "smtp://mail.example.org", from: "logbuch@example.org", fromName: "Logbuch" }, createTransport);
    await expect(transport.send(email)).rejects.toThrow(/SMTP 550: Mailbox unavailable/);
    await expect(transport.send(email)).rejects.toBeInstanceOf(DeliveryError);
  });

  it("treats 5xx replies and failed logins as permanent, 4xx replies and connection errors as temporary", async () => {
    const errors = [
      Object.assign(new Error("Mailbox unavailable"), { responseCode: 550, code: "EENVELOPE" }),
      Object.assign(new Error("Invalid login"), { responseCode: 535, code: "EAUTH" }),
      Object.assign(new Error("Missing credentials"), { code: "EAUTH" }),
      Object.assign(new Error("Try again later"), { responseCode: 421, code: "EENVELOPE" }),
      Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }),
    ];
    const { createTransport } = fakeNodemailer(async () => Promise.reject(errors.shift()));
    const transport = createSmtpTransport({ url: "smtp://mail.example.org", from: "logbuch@example.org", fromName: "Logbuch" }, createTransport);
    const permanent = async () => ((await transport.send(email).catch((error: unknown) => error)) as DeliveryError).permanent;
    expect([await permanent(), await permanent(), await permanent(), await permanent(), await permanent()]).toEqual([true, true, true, false, false]);
  });
});
