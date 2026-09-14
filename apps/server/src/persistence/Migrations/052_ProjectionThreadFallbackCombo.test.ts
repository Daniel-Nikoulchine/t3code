import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateFallbackCombo from "./052_ProjectionThreadFallbackCombo.ts";

it.layer(NodeSqliteClient.layerMemory())("052_ProjectionThreadFallbackCombo", (it) => {
  it.effect("adds a nullable combo column without touching existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 52 });
      const migrated = yield* sql<{ readonly combo: string | null }>`
        SELECT fallback_combo_json AS "combo" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(migrated, [{ combo: null }]);
      // Recovery may run the same migration against a database that already
      // has the column, including a combo written after the upgrade.
      const storedCombo =
        '{"targets":[{"instanceId":"codex","model":"gpt-5.4"}],"strategy":"priority","fallbackOn":["rate-limit","provider-error"]}';
      yield* sql`UPDATE projection_threads SET fallback_combo_json = ${storedCombo} WHERE thread_id = 'thread-1'`;
      yield* migrateFallbackCombo;
      const rows = yield* sql<{
        readonly combo: string | null;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>`
        SELECT fallback_combo_json AS "combo", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ combo: storedCombo, createdAt: now, updatedAt: now }]);
    }),
  );
});
