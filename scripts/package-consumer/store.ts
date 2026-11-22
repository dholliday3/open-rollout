// An adapter author's code, compiled with declarations on: every type inferred below has to be nameable from the
// package's entry points, or tsc stops with TS2742. This is how a database-backed store is written.
import type { Autopilot, PlanRequest, RolloutRecord, RolloutStore, Stored } from "open-rollout";
import { RECORD_SCHEMA_VERSION } from "open-rollout";
import type { RolloutTools, ToolRequest } from "open-rollout/tools";
import { rolloutTools } from "open-rollout/tools";

type Query = (sql: string, values: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;

export function createSqlStore(query: Query): RolloutStore {
  return {
    create: async (record) => {
      const inserted = await query("INSERT INTO rollouts (id, flag_key, settled, version, record) VALUES ($1, $2, $3, 1, $4) ON CONFLICT DO NOTHING", [record.id, record.plan.flagKey, record.settled, JSON.stringify(record)]);
      return inserted.rowCount === 1;
    },
    load: async (id): Promise<Stored | null> => {
      const { rows } = await query("SELECT record, version FROM rollouts WHERE id = $1", [id]);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const record = JSON.parse(String(row["record"])) as RolloutRecord;
      if (record.schemaVersion !== RECORD_SCHEMA_VERSION) {
        throw new Error(`Rollout ${id} was saved by another version of open-rollout.`);
      }
      return { record, version: Number(row["version"]) };
    },
    save: async (record, expectedVersion) => {
      const { rows } = await query("UPDATE rollouts SET record = $1, settled = $2, version = version + 1 WHERE id = $3 AND version = $4 RETURNING version", [JSON.stringify(record), record.settled, record.id, expectedVersion]);
      const row = rows[0];
      return row === undefined ? null : Number(row["version"]);
    },
    listUnsettled: async () => {
      const { rows } = await query("SELECT id FROM rollouts WHERE NOT settled", []);
      return rows.map((row) => String(row["id"]));
    },
  };
}

export const attemptOf = (record: RolloutRecord) => record.attempt;
export const baselineOf = (record: RolloutRecord) => record.freshBaseline;
export const commandsOf = (record: RolloutRecord) => record.commands;
export const outboxOf = (record: RolloutRecord) => record.outbox;
export const outcomeOf = (record: RolloutRecord) => record.outcome;
export const limitsOf = (record: RolloutRecord) => record.plan.limits;
export const everyStepOf = (request: PlanRequest) => request.overrides?.everyStep;
export const limitOverridesOf = (request: PlanRequest) => request.overrides?.limits;
export const toolsFor = (autopilot: Autopilot) => rolloutTools(autopilot);
export const startSchemaOf = (tools: RolloutTools) => tools.rollout_start.inputSchema;
export const approveRunOf = (tools: RolloutTools) => tools.rollout_approve.run;
export const inputOf = (request: ToolRequest) => request.input;
export const authorizeOf = (options: Parameters<typeof rolloutTools>[1]) => options?.authorize;
