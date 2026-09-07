// Logika bodovanja ribolovnih natjecanja

export type Sector = "A" | "B" | "C";

// Status pozicije
// - "normal": normalan unos težine
// - "absent": član nije došao (bez člana) -> fiksni bodovi = broj ekipa + 1
// - "yellow": žuti karton -> rangira se s -10% težine, na kraju +1 bod
// - "red": crveni karton -> težina = 0 (zadnje mjesto), na kraju +1 bod
export type PositionStatus = "normal" | "absent" | "yellow" | "red";

// Stanje jedne pozicije
export interface PositionState {
  weight: number | null; // grami (null = neuneseno) — za absent/red se ignorira
  status: PositionStatus;
}

// Stanje težina: positions[sector][teamIndex]
export interface WeightsState {
  A: PositionState[];
  B: PositionState[];
  C: PositionState[];
}

export interface SectorResultRow {
  teamNumber: number; // startni broj ekipe (pozicija unutar sektora)
  weight: number | null; // unesena (originalna) težina u gramima (null = neizvagano)
  effectiveWeight: number; // težina korištena u rangiranju (žuti = -10%, crveni = 0)
  tieWeight: number; // kilaža za ekipni tiebreak (žuti = umanjena, crveni/absent = 0)
  status: PositionStatus;
  points: number | null; // konačni bodovi (uključuje +1 za kartone)
  rank: number | null; // mjesto prije dodavanja +1 (1 = najbolje, prosjek kod izjednačenja)
  isZero: boolean; // efektivna težina = 0
  entered: boolean; // sudjeluje u rezultatu (izvagano ili karton/absent)
}

export interface TeamResultRow {
  teamNumber: number;
  teamName: string; // razriješeno ime ("Ekipa N" ako prazno)
  pointsA: number | null;
  pointsB: number | null;
  pointsC: number | null;
  totalPoints: number | null; // null ako bilo koji član nije "uknjižen"
  totalWeight: number; // ukupna kilaža za tiebreak (umanjena za žuti, 0 za crveni/absent)
  enteredCount: number; // koliko od 3 člana ima rezultat (uključuje kartone i absent)
  complete: boolean; // sva 3 člana imaju rezultat
  hasAbsent: boolean; // ima li ekipa barem jednog člana "bez člana"
  placement: number | null; // konačno mjesto u ekipnom poretku
}

// ----------- pomoćne funkcije za status -----------

export function emptyPosition(): PositionState {
  return { weight: null, status: "normal" };
}

// Je li pozicija "uknjižena" (ima rezultat za bodovanje)?
// - normal: izvagano (weight != null)
// - yellow: izvagano (weight != null)
// - red: uvijek (kilaža 0)
// - absent: uvijek (fiksni bodovi)
function isAccounted(p: PositionState): boolean {
  if (p.status === "red" || p.status === "absent") return true;
  return p.weight !== null;
}

// Efektivna težina za rangiranje
function effWeight(p: PositionState): number {
  if (p.status === "red" || p.status === "absent") return 0;
  if (p.status === "yellow") return (p.weight ?? 0) * 0.9;
  return p.weight ?? 0;
}

// Kilaža za ekipni tiebreak
function tieWeight(p: PositionState): number {
  if (p.status === "red" || p.status === "absent") return 0;
  if (p.status === "yellow") return (p.weight ?? 0) * 0.9;
  return p.weight ?? 0;
}

/**
 * Rangira jedan sektor i dodjeljuje bodove.
 *
 * Pravila:
 * - Bodovi za "bez člana" (absent) su fiksni: broj ekipa + 1. Te pozicije NE
 *   ulaze u rangiranje ostalih.
 * - Ostali natjecatelji (normal/yellow/red) rangiraju se samo međusobno,
 *   mjesta idu 1..m gdje je m broj prisutnih (uknjiženih ne-absent) pozicija.
 * - Veća efektivna težina = bolje mjesto. Žuti karton koristi -10% težine.
 * - Crveni karton ima efektivnu težinu 0 (zadnje mjesto, dijeli prosjek s nulama).
 * - Izjednačenje (ista efektivna težina) => prosjek pripadajućih mjesta.
 * - Nakon rangiranja: žuti i crveni karton dobivaju +1 bod na izračunato mjesto.
 * - Neizvagani (normal/yellow bez težine) se NE rangiraju (nemaju bodove).
 *
 * @param positions pozicije u sektoru
 * @param numTeams ukupan broj ekipa (za izračun absent bodova = numTeams + 1)
 */
export function rankSector(positions: PositionState[], numTeams: number): SectorResultRow[] {
  const rows: SectorResultRow[] = positions.map((p, i) => ({
    teamNumber: i + 1,
    weight: p.status === "red" || p.status === "absent" ? null : p.weight,
    effectiveWeight: effWeight(p),
    tieWeight: tieWeight(p),
    status: p.status,
    points: null,
    rank: null,
    isZero: effWeight(p) === 0,
    entered: isAccounted(p),
  }));

  // Absent pozicije: fiksni bodovi = numTeams + 1, ne ulaze u rangiranje.
  rows.forEach((r) => {
    if (r.status === "absent") {
      r.points = numTeams + 1;
      r.rank = null;
    }
  });

  // Pozicije koje sudjeluju u rangiranju: uknjižene I nisu absent.
  const ranking = rows.filter((r) => r.entered && r.status !== "absent");
  const m = ranking.length;
  if (m === 0) return rows;

  // sortiraj silazno po efektivnoj težini (veća = bolje). 0 ide na dno.
  const sorted = [...ranking].sort((a, b) => b.effectiveWeight - a.effectiveWeight);

  // dodijeli mjesta s tie-handlingom: grupiraj po jednakoj efektivnoj težini
  let idx = 0;
  while (idx < sorted.length) {
    let j = idx;
    const w = sorted[idx].effectiveWeight;
    while (j < sorted.length && sorted[j].effectiveWeight === w) j++;
    const startPlace = idx + 1;
    const endPlace = j;
    let sum = 0;
    for (let p = startPlace; p <= endPlace; p++) sum += p;
    const avg = sum / (endPlace - startPlace + 1);
    for (let k = idx; k < j; k++) {
      sorted[k].rank = avg;
      // bodovi = mjesto; +1 za žuti/crveni karton
      const bonus = sorted[k].status === "yellow" || sorted[k].status === "red" ? 1 : 0;
      sorted[k].points = avg + bonus;
    }
    idx = j;
  }

  return rows;
}

export function computeSectorResults(state: WeightsState, numTeams: number): Record<Sector, SectorResultRow[]> {
  return {
    A: rankSector(state.A, numTeams),
    B: rankSector(state.B, numTeams),
    C: rankSector(state.C, numTeams),
  };
}

export function computeTeamResults(
  state: WeightsState,
  numTeams: number,
  teamNames: string[] = []
): TeamResultRow[] {
  const sectorResults = computeSectorResults(state, numTeams);
  const n = state.A.length;

  const teams: TeamResultRow[] = [];
  for (let i = 0; i < n; i++) {
    const a = sectorResults.A[i];
    const b = sectorResults.B[i];
    const c = sectorResults.C[i];

    const pointsA = a.points;
    const pointsB = b.points;
    const pointsC = c.points;

    const enteredCount = [a.entered, b.entered, c.entered].filter(Boolean).length;
    const complete = enteredCount === 3;

    const totalPoints =
      pointsA !== null && pointsB !== null && pointsC !== null
        ? pointsA + pointsB + pointsC
        : null;

    // tiebreak kilaža: umanjena za žuti, 0 za crveni/absent
    const totalWeight = a.tieWeight + b.tieWeight + c.tieWeight;

    const hasAbsent =
      a.status === "absent" || b.status === "absent" || c.status === "absent";

    const rawName = (teamNames[i] ?? "").trim();
    const teamName = rawName !== "" ? rawName : `Ekipa ${i + 1}`;

    teams.push({
      teamNumber: i + 1,
      teamName,
      pointsA,
      pointsB,
      pointsC,
      totalPoints,
      totalWeight,
      enteredCount,
      complete,
      hasAbsent,
      placement: null,
    });
  }

  // Poredak: potpune ekipe prvo, manji bodovi bolji; tiebreak = veća kilaža.
  const ranked = teams.filter((t) => t.complete);
  ranked.sort((x, y) => {
    if (x.totalPoints! !== y.totalPoints!) return x.totalPoints! - y.totalPoints!;
    return y.totalWeight - x.totalWeight;
  });

  let place = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (
      i === 0 ||
      ranked[i].totalPoints !== ranked[i - 1].totalPoints ||
      ranked[i].totalWeight !== ranked[i - 1].totalWeight
    ) {
      place = i + 1;
    }
    ranked[i].placement = place;
  }

  const placementMap = new Map<number, number>();
  ranked.forEach((t) => placementMap.set(t.teamNumber, t.placement!));
  teams.forEach((t) => {
    t.placement = placementMap.get(t.teamNumber) ?? null;
  });

  return teams;
}

// Formatira bod (može biti decimalan kod izjednačenja)
export function fmtPoints(p: number | null): string {
  if (p === null) return "—";
  return Number.isInteger(p) ? String(p) : p.toFixed(1).replace(".", ",");
}

export function fmtWeight(g: number | null): string {
  if (g === null) return "";
  return Math.round(g).toLocaleString("hr-HR");
}

export function countEntered(state: WeightsState): { entered: number; total: number } {
  const total = state.A.length * 3;
  const count = (arr: PositionState[]) => arr.filter((p) => isAccounted(p)).length;
  const entered = count(state.A) + count(state.B) + count(state.C);
  return { entered, total };
}

// Oznaka statusa za prikaz badge-a
export function statusBadge(status: PositionStatus): { label: string; cls: string } | null {
  switch (status) {
    case "yellow":
      return { label: "Ž", cls: "status-yellow" };
    case "red":
      return { label: "C", cls: "status-red" };
    case "absent":
      return { label: "X", cls: "status-absent" };
    default:
      return null;
  }
}
