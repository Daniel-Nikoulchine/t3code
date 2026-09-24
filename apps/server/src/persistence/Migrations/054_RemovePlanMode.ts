import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS projection_thread_proposed_plans`;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const threadColumnNames = new Set(threadColumns.map((column) => column.name));
  if (threadColumnNames.has("interaction_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      DROP COLUMN interaction_mode
    `;
  }
  if (threadColumnNames.has("has_actionable_proposed_plan")) {
    yield* sql`
      ALTER TABLE projection_threads
      DROP COLUMN has_actionable_proposed_plan
    `;
  }

  const turnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;
  const turnColumnNames = new Set(turnColumns.map((column) => column.name));
  if (turnColumnNames.has("source_proposed_plan_thread_id")) {
    yield* sql`
      ALTER TABLE projection_turns
      DROP COLUMN source_proposed_plan_thread_id
    `;
  }
  if (turnColumnNames.has("source_proposed_plan_id")) {
    yield* sql`
      ALTER TABLE projection_turns
      DROP COLUMN source_proposed_plan_id
    `;
  }
});
