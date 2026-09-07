import { describe, it, expect } from "vitest";
import {
  rankSector,
  computeTeamResults,
  type PositionState,
  type WeightsState,
} from "./scoring";

// pomoćne funkcije za kreiranje pozicija
const w = (weight: number | null): PositionState => ({ weight, status: "normal" });
const yellow = (weight: number): PositionState => ({ weight, status: "yellow" });
const red = (): PositionState => ({ weight: null, status: "red" });
const absent = (): PositionState => ({ weight: null, status: "absent" });

function row(rows: ReturnType<typeof rankSector>, teamNumber: number) {
  return rows.find((r) => r.teamNumber === teamNumber)!;
}

describe("rankSector — osnovno rangiranje", () => {
  it("veća težina = bolje mjesto (manje bodova)", () => {
    const rows = rankSector([w(5000), w(3000), w(4000)], 3);
    expect(row(rows, 1).points).toBe(1); // 5000 = 1. mjesto
    expect(row(rows, 3).points).toBe(2); // 4000 = 2.
    expect(row(rows, 2).points).toBe(3); // 3000 = 3.
  });

  it("izjednačenje dijeli prosjek mjesta", () => {
    const rows = rankSector([w(4000), w(4000), w(2000)], 3);
    // dva po 4000 dijele mjesta 1 i 2 -> 1.5
    expect(row(rows, 1).points).toBe(1.5);
    expect(row(rows, 2).points).toBe(1.5);
    expect(row(rows, 3).points).toBe(3);
  });

  it("nule dijele prosjek zadnjih mjesta", () => {
    const rows = rankSector([w(5000), w(0), w(0)], 3);
    expect(row(rows, 1).points).toBe(1);
    // dvije nule dijele mjesta 2 i 3 -> 2.5
    expect(row(rows, 2).points).toBe(2.5);
    expect(row(rows, 3).points).toBe(2.5);
  });

  it("neizvagani (normal bez težine) se ne rangiraju", () => {
    const rows = rankSector([w(5000), w(null), w(3000)], 3);
    expect(row(rows, 2).entered).toBe(false);
    expect(row(rows, 2).points).toBeNull();
    expect(row(rows, 1).points).toBe(1);
    expect(row(rows, 3).points).toBe(2);
  });
});

describe("Žuti karton", () => {
  it("rangira se s -10% i dobije +1 bod", () => {
    // unesena 5000 -> efektivno 4500; ostali: 6000, 4000
    // sortirano efektivno: 6000(1.), 4500(2.), 4000(3.)
    // žuti je 2. -> +1 = 3 bodova
    const rows = rankSector([w(6000), yellow(5000), w(4000)], 3);
    expect(row(rows, 1).points).toBe(1);
    expect(row(rows, 2).rank).toBe(2); // mjesto prije bonusa
    expect(row(rows, 2).points).toBe(3); // 2 + 1
    expect(row(rows, 3).points).toBe(3); // 4000 je 3.? ne — provjeri
  });

  it("primjer iz specifikacije: 5000 -> 4500 -> 3. mjesto -> 4 boda", () => {
    // namjesti da žuti efektivno (4500) bude 3.: tri jača iznad
    const rows = rankSector([w(6000), w(5500), yellow(5000), w(4800)], 4);
    // efektivno: 6000, 5500, 4800, 4500(žuti)
    // žuti je 4. mjesto -> +1 = 5? Napravimo precizniji primjer dolje.
    expect(row(rows, 3).rank).toBe(4);
    expect(row(rows, 3).points).toBe(5);
  });

  it("žuti s umanjenom težinom 3. mjesto -> 4 boda (spec primjer)", () => {
    // 2 jača, žuti 4500 treći
    const rows = rankSector([w(6000), w(5000), yellow(5000)], 3);
    // efektivno: 6000(1.), 5000(2.), 4500(žuti, 3.) -> 3 + 1 = 4
    expect(row(rows, 3).rank).toBe(3);
    expect(row(rows, 3).points).toBe(4);
  });

  it("kod izjednačenja prvo rangira (prosjek) pa dodaje +1", () => {
    // žuti efektivno 4500, normalni 4500 -> dijele mjesta; žuti +1
    const rows = rankSector([w(6000), w(4500), yellow(5000)], 3);
    // efektivno: 6000(1.), zatim 4500 i 4500 dijele mjesta 2 i 3 -> 2.5
    expect(row(rows, 2).points).toBe(2.5); // normalni
    expect(row(rows, 3).rank).toBe(2.5); // žuti rank prije bonusa
    expect(row(rows, 3).points).toBe(3.5); // 2.5 + 1
  });

  it("za ekipni tiebreak žuti koristi umanjenu kilažu", () => {
    const rows = rankSector([yellow(5000)], 1);
    expect(row(rows, 1).tieWeight).toBe(4500);
  });
});

describe("Crveni karton", () => {
  it("tretira se kao zadnje mjesto (0 g) i dobije +1", () => {
    // 10 ekipa: jedan crveni + 2 normalne nule + 7 s ulovom
    const positions: PositionState[] = [
      w(9000), w(8000), w(7000), w(6000), w(5000), w(4000), w(3000), // 7 mjesta 1..7
      w(0), w(0), red(), // tri nule dijele mjesta 8,9,10 = 9
    ];
    const rows = rankSector(positions, 10);
    expect(row(rows, 8).points).toBe(9); // normalna nula
    expect(row(rows, 9).points).toBe(9);
    expect(row(rows, 10).rank).toBe(9); // crveni rank prije bonusa
    expect(row(rows, 10).points).toBe(10); // 9 + 1
  });

  it("crveni za ekipni tiebreak ima kilažu 0", () => {
    const rows = rankSector([red()], 1);
    expect(row(rows, 1).tieWeight).toBe(0);
    expect(row(rows, 1).weight).toBeNull();
  });
});

describe("Bez člana (absent)", () => {
  it("dobije fiksno n+1 bodova i ne ulazi u rang ostalih", () => {
    // 10 ekipa, 2 bez člana u sektoru
    const positions: PositionState[] = [
      w(5000), w(4000), w(3000), w(2000), w(1000), w(500), w(100), w(50),
      absent(), absent(),
    ];
    const rows = rankSector(positions, 10);
    // oba absent -> 11 bodova
    expect(row(rows, 9).points).toBe(11);
    expect(row(rows, 10).points).toBe(11);
    // ostalih 8 rangirani 1..8 (kao da odsutnih nema)
    expect(row(rows, 1).points).toBe(1);
    expect(row(rows, 8).points).toBe(8);
  });

  it("prisutni se rangiraju 1..broj prisutnih", () => {
    const rows = rankSector([w(5000), absent(), w(3000)], 3);
    expect(row(rows, 1).points).toBe(1);
    expect(row(rows, 3).points).toBe(2);
    expect(row(rows, 2).points).toBe(4); // n+1 = 3+1
  });

  it("absent za tiebreak ima kilažu 0", () => {
    const rows = rankSector([absent()], 5);
    expect(row(rows, 1).tieWeight).toBe(0);
  });
});

describe("computeTeamResults — kombinacije", () => {
  function buildState(
    a: PositionState[],
    b: PositionState[],
    c: PositionState[]
  ): WeightsState {
    return { A: a, B: b, C: c };
  }

  it("ekipa s normalnim, žutim i crvenim članom", () => {
    // 3 ekipe. Ekipa 1: A normal, B žuti, C crveni
    // Sektor A: [5000, 3000, 1000] -> ekipa1 = 1
    // Sektor B: žuti 5000(eff 4500) vs 6000, 4000 -> eff sort: 6000(1),4500(2),4000(3); ekipa1 žuti 2. +1 = 3
    // Sektor C: crveni vs [4000, 2000] -> red eff 0 zadnji = mjesto 3 +1 = 4
    const a = [w(5000), w(3000), w(1000)];
    const b = [yellow(5000), w(6000), w(4000)];
    const c = [red(), w(4000), w(2000)];
    const teams = computeTeamResults(buildState(a, b, c), 3);
    const t1 = teams.find((t) => t.teamNumber === 1)!;
    expect(t1.pointsA).toBe(1);
    expect(t1.pointsB).toBe(3);
    expect(t1.pointsC).toBe(4);
    expect(t1.totalPoints).toBe(8);
    expect(t1.complete).toBe(true);
    // tiebreak kilaža: A 5000 + B 4500 (umanjeno) + C 0 = 9500
    expect(t1.totalWeight).toBe(9500);
  });

  it("ekipa s 'bez člana' u jednom sektoru — complete i hasAbsent", () => {
    const a = [w(5000), w(3000)];
    const b = [absent(), w(4000)];
    const c = [w(2000), w(1000)];
    const teams = computeTeamResults(buildState(a, b, c), 2);
    const t1 = teams.find((t) => t.teamNumber === 1)!;
    expect(t1.hasAbsent).toBe(true);
    expect(t1.complete).toBe(true); // absent se računa kao uknjižen
    expect(t1.pointsB).toBe(3); // n+1 = 2+1
    // kilaža: A 5000 + B 0 + C 2000 = 7000
    expect(t1.totalWeight).toBe(7000);
  });

  it("razrješava imena ekipa (prazno -> Ekipa N)", () => {
    const a = [w(5000), w(3000)];
    const b = [w(4000), w(2000)];
    const c = [w(1000), w(500)];
    const teams = computeTeamResults(buildState(a, b, c), 2, ["Štuka", ""]);
    expect(teams.find((t) => t.teamNumber === 1)!.teamName).toBe("Štuka");
    expect(teams.find((t) => t.teamNumber === 2)!.teamName).toBe("Ekipa 2");
  });

  it("ekipni tiebreak koristi umanjenu/nultu kilažu", () => {
    // dvije ekipe s istim bodovima, razlikuju se po kilaži
    const a = [w(5000), w(5000)];
    const b = [w(3000), w(3000)];
    const c = [yellow(4000), w(3600)]; // ekipa1 žuti eff 3600, isto kao ekipa2 3600 -> dijele
    const teams = computeTeamResults(buildState(a, b, c), 2);
    const t1 = teams.find((t) => t.teamNumber === 1)!;
    // C: žuti eff 3600 i normalni 3600 dijele mjesta 1,2 -> 1.5; žuti +1 = 2.5
    expect(t1.pointsC).toBe(2.5);
    // tiebreak kilaža za ekipu 1: 5000+3000+3600(umanjeno) = 11600
    expect(t1.totalWeight).toBe(11600);
  });
});
