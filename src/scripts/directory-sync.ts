import { validateWorkerConfig } from "@/lib/config";
import { getPool } from "@/lib/db/client";
import { getDirectory } from "@/lib/directory/directory";
import { logger } from "@/lib/logger";

// Runs one Keycloak directory sync now: `npm run directory:sync`, or in the
// container `node dist/directory-sync.mjs`. The manual directory has nothing
// to sync.
async function main() {
  validateWorkerConfig();
  const sync = getDirectory().sync;
  if (!sync) {
    console.log("DIRECTORY=manual: people and teams are managed in Logbuch. There is nothing to sync.");
    process.exit(0);
  }
  const result = await sync.run("manual");
  await getPool().end();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "failed" ? 1 : 0);
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "directory sync failed");
  process.exit(1);
});
