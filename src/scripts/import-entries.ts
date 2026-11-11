import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { ConfigError, parseDatabaseConfig } from "@/lib/config";
import { CsvError } from "@/lib/csv-import/csv";
import { ImportError, runCsvImport } from "@/lib/csv-import/run";
import { getDb, getPool } from "@/lib/db/client";
import { logger } from "@/lib/logger";

// Imports old updates, learnings, and decisions from a CSV file. The columns
// are in docs/entry-import-template.csv. In the worker container (`-` reads
// the file from standard input):
//
//   node dist/import-entries.mjs --file entries.csv --team "Engineering" --as you@example.org
//
// The first run is a dry run that prints every record in full and a review
// fingerprint. Check them for personal data, leave rows out with --skip <id>,
// then run again with the same file and options and
// --confirm-no-personal-data <fingerprint>.
async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      team: { type: "string" },
      as: { type: "string" },
      "fallback-decider": { type: "string" },
      skip: { type: "string", multiple: true },
      "confirm-no-personal-data": { type: "string" },
    },
  });
  if (!values.file || !values.team || !values.as) {
    console.error(
      'Usage: import-entries --file <path or -> --team "<team name>" --as <admin work email> [--fallback-decider <work email>] [--skip <id>]... [--confirm-no-personal-data <fingerprint>]',
    );
    process.exit(2);
  }
  parseDatabaseConfig();
  const csv = values.file === "-" ? await text(process.stdin) : await readFile(values.file, "utf8");
  const report = await runCsvImport(getDb(), csv, {
    teamName: values.team,
    asEmail: values.as,
    fallbackDeciderEmail: values["fallback-decider"],
    skip: values.skip ?? [],
    confirmFingerprint: values["confirm-no-personal-data"],
  });
  console.log(report.lines.join("\n"));
  await getPool().end();
  process.exit(report.failed || (report.problems > 0 && values["confirm-no-personal-data"] !== undefined) ? 1 : 0);
}

main().catch(async (error: unknown) => {
  if (error instanceof ImportError || error instanceof ConfigError || error instanceof CsvError) console.error(error.message);
  else if ((error as { code?: string }).code === "ENOENT") console.error(`File not found: ${(error as { path?: string }).path}`);
  else logger.fatal({ err: error }, "entry import failed");
  try {
    // getPool() itself throws when DATABASE_URL is missing.
    await getPool().end();
  } catch {
    // Nothing to close.
  }
  process.exit(1);
});
