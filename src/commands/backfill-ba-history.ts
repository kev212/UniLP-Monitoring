import { Database } from "../db.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const apply = process.argv.includes("--apply");
const groupIdIndex = process.argv.indexOf("--group-id");
const groupId = groupIdIndex >= 0 ? process.argv[groupIdIndex + 1] : undefined;
if (groupIdIndex >= 0 && !groupId) throw new Error("--group-id requires a value");
const database = new Database(databaseUrl);

try {
  await database.connect();
  await database.migrate();
  const candidates = await database.listPositionGroupHistoryBackfillCandidates(groupId);
  for (const candidate of candidates) {
    console.log(`${candidate.id} ${candidate.protocol.toUpperCase()} ${candidate.finalPnlBps.toString()}bps ${candidate.settledAt.toISOString()}`);
  }
  if (!apply) {
    console.log(`dry-run: ${candidates.length} BA history row(s) eligible; rerun with --apply to write`);
  } else {
    const written = await database.backfillPositionGroupHistory(candidates.map((candidate) => candidate.id));
    console.log(`applied: ${written} BA history row(s)`);
  }
} finally {
  await database.close();
}
