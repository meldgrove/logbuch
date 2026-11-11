import { z } from "zod";
import { DATE_FORMATS, isTimeZone } from "@/lib/preferences";

/* Forms of the manual directory and of the personal settings, shared by the browser and the Server Actions. */

export const PERSON_NAME_MAX = 120;
export const TEAM_NAME_MAX = 80;

const name = (label: string, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be at most ${max} characters.`);

const optionalTeam = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : null))
  .pipe(z.uuid({ error: "Choose a valid team." }).nullable());

export const invitePersonSchema = z.object({
  email: z
    .string({ error: "Email is required." })
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: "Enter a valid email address." })),
  name: name("Name", PERSON_NAME_MAX),
  teamId: optionalTeam,
  isAdmin: z
    .string()
    .optional()
    .transform((value) => value === "on"),
});

export const updatePersonSchema = z.object({
  name: name("Name", PERSON_NAME_MAX),
  teamId: optionalTeam,
});

export const teamInputSchema = z.object({
  name: name("Name", TEAM_NAME_MAX),
});

export const preferencesSchema = z.object({
  timeZone: z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : null))
    .refine((value) => value === null || isTimeZone(value), "Choose a valid time zone."),
  dateFormat: z.enum(DATE_FORMATS, { error: "Choose a date format." }),
});

export type InvitePersonInput = z.infer<typeof invitePersonSchema>;
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>;
export type TeamInput = z.infer<typeof teamInputSchema>;
export type PreferencesInput = z.infer<typeof preferencesSchema>;
