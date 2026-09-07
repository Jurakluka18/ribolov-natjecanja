// Supabase client + sync funkcije za online natjecanja u realnom vremenu.
//
// VITE_SUPABASE_URL / VITE_SUPABASE_KEY se ugrađuju u bundle pri buildu.
// RLS je otvoren (svi koji znaju 6-znamenkasti `code` mogu CRUD), nema auth.

import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import type { PositionStatus, Sector } from "./scoring";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY as string;

export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

// Single instance clienta. Ako env nije postavljen, kreiramo "prazan" client
// koji ipak postoji da app ne crasha — pozivi će jednostavno failati i pasti
// u offline mod.
export const supabase = createClient(
  SUPABASE_URL || "https://placeholder.supabase.co",
  SUPABASE_KEY || "placeholder",
  {
    realtime: { params: { eventsPerSecond: 10 } },
  }
);

// ---------- Tipovi redova u bazi ----------
export interface CompetitionRow {
  id: string;
  code: string;
  name: string;
  num_teams: number;
  team_names: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface PositionRow {
  competition_id: string;
  sector: Sector;
  team_number: number;
  weight_grams: number | null;
  status: PositionStatus;
  updated_at: string;
  updated_by: string | null;
}

const SECTORS: Sector[] = ["A", "B", "C"];

// ---------- Pomoćno: generiranje 6-znamenkaste šifre ----------
function generateCode(): string {
  // 6 znamenki, prva ne smije biti 0 da uvijek bude 6-znamenkasta.
  const first = Math.floor(Math.random() * 9) + 1; // 1..9
  let rest = "";
  for (let i = 0; i < 5; i++) rest += Math.floor(Math.random() * 10);
  return `${first}${rest}`;
}

// ---------- createCompetition ----------
// Generira jedinstvenu šifru, insertira natjecanje, pa prazne pozicije
// (A1..An, B1..Bn, C1..Cn) sa status='normal', weight_grams=NULL.
export async function createCompetition({
  name,
  numTeams,
  teamNames,
}: {
  name: string;
  numTeams: number;
  teamNames: string[];
}): Promise<{ id: string; code: string }> {
  const teamNamesMap: Record<string, string> = {};
  for (let i = 0; i < numTeams; i++) {
    teamNamesMap[String(i + 1)] = (teamNames[i] ?? "").trim();
  }

  let inserted: CompetitionRow | null = null;
  let lastErr: unknown = null;

  // Retry do 5x ako je šifra zauzeta (unique constraint violation = 23505).
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const { data, error } = await supabase
      .from("competitions")
      .insert({
        code,
        name: name.trim(),
        num_teams: numTeams,
        team_names: teamNamesMap,
      })
      .select()
      .single();

    if (!error && data) {
      inserted = data as CompetitionRow;
      break;
    }
    lastErr = error;
    // 23505 = unique_violation (kolizija šifre) -> pokušaj ponovno
    if (error && (error as { code?: string }).code !== "23505") {
      // Druga vrsta greške — ne pokušavaj dalje.
      break;
    }
  }

  if (!inserted) {
    throw new Error(
      `Kreiranje natjecanja nije uspjelo: ${
        (lastErr as { message?: string })?.message ?? "nepoznata greška"
      }`
    );
  }

  // Pripremi sve prazne pozicije.
  const positions: Partial<PositionRow>[] = [];
  for (const sector of SECTORS) {
    for (let t = 1; t <= numTeams; t++) {
      positions.push({
        competition_id: inserted.id,
        sector,
        team_number: t,
        weight_grams: null,
        status: "normal",
      });
    }
  }

  const { error: posErr } = await supabase.from("positions").insert(positions);
  if (posErr) {
    // Rollback — obriši natjecanje da ne ostane "pola" kreirano.
    await supabase.from("competitions").delete().eq("id", inserted.id);
    throw new Error(`Kreiranje pozicija nije uspjelo: ${posErr.message}`);
  }

  return { id: inserted.id, code: inserted.code };
}

// ---------- joinCompetition ----------
// Dohvati natjecanje po 6-znamenkastoj šifri. Vrati null ako ne postoji.
export async function joinCompetition(
  code: string
): Promise<CompetitionRow | null> {
  const clean = code.replace(/\D/g, "");
  const { data, error } = await supabase
    .from("competitions")
    .select("*")
    .eq("code", clean)
    .maybeSingle();
  if (error) throw new Error(`Pridruživanje nije uspjelo: ${error.message}`);
  return (data as CompetitionRow) ?? null;
}

// ---------- getCompetition (po id) ----------
export async function getCompetition(
  competitionId: string
): Promise<CompetitionRow | null> {
  const { data, error } = await supabase
    .from("competitions")
    .select("*")
    .eq("id", competitionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CompetitionRow) ?? null;
}

// ---------- getPositions ----------
export async function getPositions(
  competitionId: string
): Promise<PositionRow[]> {
  const { data, error } = await supabase
    .from("positions")
    .select("*")
    .eq("competition_id", competitionId);
  if (error) throw new Error(error.message);
  return (data as PositionRow[]) ?? [];
}

// ---------- updatePosition (upsert) ----------
export async function updatePosition({
  competitionId,
  sector,
  teamNumber,
  weightGrams,
  status,
  updatedBy,
}: {
  competitionId: string;
  sector: Sector;
  teamNumber: number;
  weightGrams: number | null;
  status: PositionStatus;
  updatedBy?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("positions").upsert(
    {
      competition_id: competitionId,
      sector,
      team_number: teamNumber,
      weight_grams: weightGrams,
      status,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy ?? null,
    },
    { onConflict: "competition_id,sector,team_number" }
  );
  if (error) throw new Error(error.message);
}

// ---------- updateCompetitionMeta ----------
export async function updateCompetitionMeta({
  competitionId,
  name,
  teamNames,
  numTeams,
}: {
  competitionId: string;
  name?: string;
  teamNames?: string[];
  numTeams?: number;
}): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined) patch.name = name;
  if (numTeams !== undefined) patch.num_teams = numTeams;
  if (teamNames !== undefined) {
    const map: Record<string, string> = {};
    teamNames.forEach((nm, i) => (map[String(i + 1)] = (nm ?? "").trim()));
    patch.team_names = map;
  }
  const { error } = await supabase
    .from("competitions")
    .update(patch)
    .eq("id", competitionId);
  if (error) throw new Error(error.message);
}

// ---------- deleteCompetition (reset, CASCADE briše pozicije) ----------
export async function deleteCompetition(competitionId: string): Promise<void> {
  const { error } = await supabase
    .from("competitions")
    .delete()
    .eq("id", competitionId);
  if (error) throw new Error(error.message);
}

// ---------- subscribeToCompetition ----------
// Realtime pretplata na promjene `positions` i `competitions` za zadani id.
// onChange dobiva tip promjene; vraća unsubscribe funkciju.
export type CompetitionChange =
  | { kind: "position"; row: PositionRow }
  | { kind: "competition"; row: CompetitionRow }
  | { kind: "competition_deleted"; id: string };

export function subscribeToCompetition(
  competitionId: string,
  onChange: (change: CompetitionChange) => void,
  onStatus?: (status: string) => void
): () => void {
  const channel: RealtimeChannel = supabase
    .channel(`comp-${competitionId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "positions",
        filter: `competition_id=eq.${competitionId}`,
      },
      (payload) => {
        const row = (payload.new ?? payload.old) as PositionRow;
        if (row) onChange({ kind: "position", row });
      }
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "competitions",
        filter: `id=eq.${competitionId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") {
          onChange({ kind: "competition_deleted", id: competitionId });
        } else {
          onChange({ kind: "competition", row: payload.new as CompetitionRow });
        }
      }
    )
    .subscribe((status) => {
      if (onStatus) onStatus(status);
    });

  return () => {
    supabase.removeChannel(channel);
  };
}
