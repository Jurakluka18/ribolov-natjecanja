import { describe, expect, it } from "vitest";
import {
  applyQueuedUpdates,
  buildOnlineCompetition,
  enqueue,
  pendingForCompetition,
  removeAcknowledged,
  type QueuedUpdate,
} from "./sync";
import type { CompetitionRow, PositionRow } from "./supabase";

function update(overrides: Partial<QueuedUpdate> = {}): QueuedUpdate {
  return {
    competitionId: "comp-1",
    sector: "A",
    teamNumber: 1,
    weightGrams: 1000,
    status: "normal",
    ts: 1,
    token: "v1",
    ...overrides,
  };
}

function competition(): CompetitionRow {
  return {
    id: "comp-1",
    code: "123456",
    name: "Kup",
    num_teams: 2,
    team_names: { "1": "Prva", "2": "Druga" },
    created_at: "2026-09-21T10:00:00Z",
    updated_at: "2026-09-21T10:00:00Z",
  };
}

function positions(): PositionRow[] {
  return (["A", "B", "C"] as const).flatMap((sector) =>
    [1, 2].map((teamNumber) => ({
      competition_id: "comp-1",
      sector,
      team_number: teamNumber,
      weight_grams: null,
      status: "normal" as const,
      updated_at: "2026-09-21T10:00:00Z",
      updated_by: null,
    }))
  );
}

describe("offline sync queue", () => {
  it("zadnja izmjena iste pozicije pobjeđuje, ali druga natjecanja ostaju odvojena", () => {
    const first = update();
    const newer = update({ weightGrams: 1250, ts: 2, token: "v2" });
    const otherCompetition = update({
      competitionId: "comp-2",
      weightGrams: 900,
      token: "other",
    });

    const queue = enqueue(enqueue(enqueue([], first), otherCompetition), newer);

    expect(queue).toHaveLength(2);
    expect(pendingForCompetition(queue, "comp-1")).toEqual([newer]);
    expect(pendingForCompetition(queue, "comp-2")).toEqual([otherCompetition]);
  });

  it("potvrda starog slanja ne uklanja noviju izmjenu iste pozicije", () => {
    const sent = update();
    const newer = update({ weightGrams: 1500, ts: 2, token: "v2" });
    const queueWhileSending = enqueue([sent], newer);

    expect(removeAcknowledged(queueWhileSending, sent)).toEqual([newer]);
    expect(removeAcknowledged([sent], sent)).toEqual([]);
  });

  it("refresh baze ne pregazi lokalni rezultat koji još čeka slanje", () => {
    const remote = buildOnlineCompetition(competition(), positions());
    const pending = update({
      sector: "B",
      teamNumber: 2,
      weightGrams: 2345,
      status: "yellow",
    });

    const merged = applyQueuedUpdates(remote, [pending]);

    expect(merged.weights.B[1]).toEqual({ weight: 2345, status: "yellow" });
    expect(merged.weights.A[0]).toEqual({ weight: null, status: "normal" });
  });
});

