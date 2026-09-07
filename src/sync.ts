// Sloj sinkronizacije: spaja lokalni CompetitionState s online Supabase bazom.
//
// Sadrži:
//  - mapiranje DB redova <-> lokalni WeightsState
//  - localStorage perzistencija aktivnog online natjecanja (id + code)
//  - offline queue (debounce + retry pri povratku mreže)

import type {
  PositionState,
  PositionStatus,
  Sector,
  WeightsState,
} from "./scoring";
import { emptyPosition } from "./scoring";
import type { CompetitionRow, PositionRow } from "./supabase";

export const SECTORS: Sector[] = ["A", "B", "C"];

// Aktivno online natjecanje spremamo zasebno od legacy v2 state-a.
export const ACTIVE_KEY = "ribolovni-bodovnik-online-active";
export const QUEUE_KEY = "ribolovni-bodovnik-sync-queue";

export interface ActiveOnline {
  id: string;
  code: string;
}

export interface OnlineCompetition {
  // version: 2 da je strukturno kompatibilan s CompetitionState (pages).
  version: 2;
  id: string;
  code: string;
  name: string;
  numTeams: number;
  teamNames: string[];
  weights: WeightsState;
}

// ---------- localStorage: aktivno online natjecanje ----------
export function loadActiveOnline(): ActiveOnline | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === "string" && typeof parsed.code === "string") {
      return parsed as ActiveOnline;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveActiveOnline(a: ActiveOnline | null) {
  try {
    if (a) localStorage.setItem(ACTIVE_KEY, JSON.stringify(a));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

// Postoji li legacy offline (v2) natjecanje?
export function hasLegacyOffline(): boolean {
  try {
    const raw = localStorage.getItem("ribolovni-bodovnik-v2");
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return !!(parsed && parsed.numTeams && parsed.weights);
  } catch {
    return false;
  }
}

// ---------- Mapiranje DB -> lokalni WeightsState ----------
export function buildOnlineCompetition(
  comp: CompetitionRow,
  positions: PositionRow[]
): OnlineCompetition {
  const n = comp.num_teams;
  const make = () => Array.from({ length: n }, () => emptyPosition());
  const weights: WeightsState = { A: make(), B: make(), C: make() };

  for (const p of positions) {
    const sector = p.sector as Sector;
    const idx = p.team_number - 1;
    if (!weights[sector] || idx < 0 || idx >= n) continue;
    weights[sector][idx] = {
      weight: p.weight_grams,
      status: (p.status as PositionStatus) ?? "normal",
    };
  }

  const teamNames = Array.from({ length: n }, (_, i) => {
    const v = comp.team_names?.[String(i + 1)];
    return (v ?? "").trim();
  });

  return {
    version: 2,
    id: comp.id,
    code: comp.code,
    name: comp.name ?? "",
    numTeams: n,
    teamNames,
    weights,
  };
}

// Primijeni jednu položajnu promjenu iz Realtime-a na lokalni weights.
export function applyPositionChange(
  weights: WeightsState,
  row: PositionRow
): WeightsState {
  const sector = row.sector as Sector;
  const idx = row.team_number - 1;
  if (!weights[sector] || idx < 0 || idx >= weights[sector].length) return weights;
  const next: PositionState = {
    weight: row.weight_grams,
    status: (row.status as PositionStatus) ?? "normal",
  };
  const arr = [...weights[sector]];
  arr[idx] = next;
  return { ...weights, [sector]: arr };
}

// ---------- Offline queue ----------
export interface QueuedUpdate {
  competitionId: string;
  sector: Sector;
  teamNumber: number;
  weightGrams: number | null;
  status: PositionStatus;
  ts: number; // vrijeme zadnje izmjene (za dedupe — zadnji pobjeđuje)
}

function queueKeyFor(u: { sector: Sector; teamNumber: number }): string {
  return `${u.sector}-${u.teamNumber}`;
}

export function loadQueue(): QueuedUpdate[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedUpdate[]) : [];
  } catch {
    return [];
  }
}

export function saveQueue(q: QueuedUpdate[]) {
  try {
    if (q.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    else localStorage.removeItem(QUEUE_KEY);
  } catch {
    /* ignore */
  }
}

// Dodaj/zamijeni u queue (po poziciji zadržavamo samo zadnju vrijednost).
export function enqueue(q: QueuedUpdate[], u: QueuedUpdate): QueuedUpdate[] {
  const key = queueKeyFor(u);
  const filtered = q.filter((x) => queueKeyFor(x) !== key);
  filtered.push(u);
  return filtered;
}
