import { useEffect, useMemo, useState, useCallback, useRef, forwardRef, type ReactNode } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import html2canvas from "html2canvas";
import { LIBERATION_SANS_REGULAR_B64, LIBERATION_SANS_BOLD_B64 } from "./pdfFont";
import {
  type Sector,
  type WeightsState,
  type PositionState,
  type PositionStatus,
  type TeamResultRow,
  type SectorResultRow,
  computeSectorResults,
  computeTeamResults,
  emptyPosition,
  fmtPoints,
  fmtWeight,
  countEntered,
  statusBadge,
} from "./scoring";
import { createCompetition, joinCompetition, deleteCompetition } from "./supabase";
import {
  loadActiveOnline,
  saveActiveOnline,
  hasLegacyOffline,
  type ActiveOnline,
} from "./sync";
import { useOnlineSync, type SyncStatus } from "./useOnlineSync";

const APP_TITLE = "Program za izračun rezultata";
const STORAGE_KEY = "ribolovni-bodovnik-v2";
const LEGACY_STORAGE_KEY = "ribolovni-bodovnik-v1";
const SECTORS: Sector[] = ["A", "B", "C"];
const SECTOR_COLORS: Record<Sector, string> = {
  A: "#0c5b52",
  B: "#1e7fb8",
  C: "#c7902b",
};

interface CompetitionState {
  version: 2;
  name: string;
  numTeams: number;
  teamNames: string[];
  weights: WeightsState;
}

type Page = "setup" | "weigh" | "sectors" | "teams";

function emptyWeights(n: number): WeightsState {
  const make = () => Array.from({ length: n }, () => emptyPosition());
  return { A: make(), B: make(), C: make() };
}

// ---------- Migracija / učitavanje ----------
function loadState(): CompetitionState | null {
  // Pokušaj v2
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.numTeams && parsed.weights) {
        return normalize(parsed);
      }
    }
  } catch {
    /* ignore */
  }
  // Pokušaj migracije iz v1 (stari format: weights[s] = (number|null)[])
  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (parsed && parsed.numTeams && parsed.weights) {
        const migrated = migrateV1(parsed);
        saveState(migrated);
        return migrated;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Migracija starog v1 formata u v2
function migrateV1(parsed: {
  name?: string;
  numTeams: number;
  weights: { A: (number | null)[]; B: (number | null)[]; C: (number | null)[] };
}): CompetitionState {
  const conv = (arr: (number | null)[]): PositionState[] =>
    (arr ?? []).map((w) => ({ weight: w ?? null, status: "normal" as PositionStatus }));
  return {
    version: 2,
    name: parsed.name ?? "",
    numTeams: parsed.numTeams,
    teamNames: Array(parsed.numTeams).fill(""),
    weights: {
      A: conv(parsed.weights.A),
      B: conv(parsed.weights.B),
      C: conv(parsed.weights.C),
    },
  };
}

// Osigurava da su sva polja prisutna (graciozno učitavanje nepotpunih podataka)
type RawPos = { weight?: number | null; status?: PositionStatus } | number | null;
function normalize(parsed: {
  name?: string;
  numTeams: number;
  teamNames?: string[];
  weights: { A?: RawPos[]; B?: RawPos[]; C?: RawPos[] };
}): CompetitionState {
  const n = parsed.numTeams;
  const fixArr = (arr: RawPos[] | undefined): PositionState[] => {
    const out: PositionState[] = [];
    for (let i = 0; i < n; i++) {
      const p = arr?.[i];
      if (p && typeof p === "object") {
        out.push({
          weight: p.weight ?? null,
          status: (p.status as PositionStatus) ?? "normal",
        });
      } else if (typeof p === "number") {
        out.push({ weight: p, status: "normal" });
      } else {
        out.push(emptyPosition());
      }
    }
    return out;
  };
  const teamNames = Array.from({ length: n }, (_, i) => parsed.teamNames?.[i] ?? "");
  return {
    version: 2,
    name: parsed.name ?? "",
    numTeams: n,
    teamNames,
    weights: {
      A: fixArr(parsed.weights?.A),
      B: fixArr(parsed.weights?.B),
      C: fixArr(parsed.weights?.C),
    },
  };
}

function saveState(s: CompetitionState | null) {
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

// ---------- Logo ----------
function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-label={`${APP_TITLE} logo`}>
      <path
        d="M6 16c3.5-6 13-8 18 0-4.5 8-14.5 6-18 0z"
        stroke="#7fd4c1"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path d="M24 16l5-3.5v7L24 16z" fill="#7fd4c1" />
      <circle cx="11" cy="14.5" r="1.6" fill="#7fd4c1" />
    </svg>
  );
}

// ---------- Theme toggle ----------
function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

type AppMode = "home" | "online" | "offline";

export default function App() {
  const [active, setActive] = useState<ActiveOnline | null>(() => loadActiveOnline());
  const [offlineComp, setOfflineComp] = useState<CompetitionState | null>(null);
  const [mode, setMode] = useState<AppMode>(() => (loadActiveOnline() ? "online" : "home"));

  const goHome = useCallback(() => {
    saveActiveOnline(null);
    setActive(null);
    setOfflineComp(null);
    setMode("home");
  }, []);

  // Pri ulasku u online natjecanje
  const enterOnline = useCallback((a: ActiveOnline) => {
    saveActiveOnline(a);
    setActive(a);
    setMode("online");
  }, []);

  // Nastavi legacy offline natjecanje
  const enterOffline = useCallback(() => {
    const loaded = loadState();
    setOfflineComp(loaded);
    setMode("offline");
  }, []);

  if (mode === "home") {
    return <HomeScreen onEnterOnline={enterOnline} onEnterOffline={enterOffline} />;
  }

  if (mode === "online" && active) {
    return <OnlineApp active={active} onLeave={goHome} />;
  }

  // offline mod
  return <OfflineApp initial={offlineComp} onLeave={goHome} />;
}

// ===================== HOME SCREEN =====================
function HomeScreen({
  onEnterOnline,
  onEnterOffline,
}: {
  onEnterOnline: (a: ActiveOnline) => void;
  onEnterOffline: () => void;
}) {
  const { theme, toggle } = useTheme();
  const [view, setView] = useState<"choose" | "create" | "join" | "created">("choose");
  const [toast, setToast] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);
  const legacy = useMemo(() => hasLegacyOffline(), []);

  // Stanje forme za kreiranje
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingActive, setPendingActive] = useState<ActiveOnline | null>(null);

  // Stanje forme za pridruživanje
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinErr, setJoinErr] = useState<string | null>(null);

  const doCreate = async (name: string, n: number, teamNames: string[]) => {
    setCreating(true);
    try {
      const { id, code } = await createCompetition({ name, numTeams: n, teamNames });
      setCreatedCode(code);
      setPendingActive({ id, code });
      setView("created");
    } catch (e) {
      showToast(`Greška: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const doJoin = async () => {
    const clean = joinCode.replace(/\D/g, "");
    if (clean.length !== 6) {
      setJoinErr("Šifra mora imati 6 znamenki.");
      return;
    }
    setJoining(true);
    setJoinErr(null);
    try {
      const comp = await joinCompetition(clean);
      if (!comp) {
        setJoinErr("Natjecanje s tom šifrom ne postoji.");
        return;
      }
      onEnterOnline({ id: comp.id, code: comp.code });
    } catch (e) {
      setJoinErr(`Greška: ${(e as Error).message}`);
    } finally {
      setJoining(false);
    }
  };

  return (
    <>
      <HeaderBar theme={theme} toggle={toggle} subtitle="Bodovanje ribolovnih natjecanja" />
      <main className="app">
        {view === "choose" && (
          <div className="home-wrap">
            <div className="home-hero">
              <h2>Online sinkronizacija natjecanja</h2>
              <p className="desc">
                Kreiraj natjecanje i podijeli šifru s vagarima — rezultati se sinkroniziraju
                na svim uređajima u stvarnom vremenu.
              </p>
            </div>
            <div className="home-cards">
              <button className="home-card" onClick={() => setView("create")} data-testid="home-create">
                <span className="home-card-icon home-card-icon-create" aria-hidden>
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </span>
                <span className="home-card-title">Kreiraj novo natjecanje</span>
                <span className="home-card-sub">Generiraj šifru i pozovi druge uređaje</span>
              </button>

              <button className="home-card" onClick={() => setView("join")} data-testid="home-join">
                <span className="home-card-icon home-card-icon-join" aria-hidden>
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                    <path d="M10 17l5-5-5-5M15 12H3" />
                  </svg>
                </span>
                <span className="home-card-title">Pridruži se natjecanju</span>
                <span className="home-card-sub">Upiši 6-znamenkastu šifru</span>
              </button>

              {legacy && (
                <button className="home-card" onClick={onEnterOffline} data-testid="home-offline">
                  <span className="home-card-icon home-card-icon-offline" aria-hidden>
                    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
                      <path d="M12 7v5l3 2" />
                    </svg>
                  </span>
                  <span className="home-card-title">Nastavi offline natjecanje</span>
                  <span className="home-card-sub">Spremljeno lokalno na ovom uređaju</span>
                </button>
              )}
            </div>
          </div>
        )}

        {view === "create" && (
          <div>
            <button className="link-back" onClick={() => setView("choose")}>
              ← Natrag
            </button>
            <CreateForm onCreate={doCreate} creating={creating} />
          </div>
        )}

        {view === "created" && createdCode && pendingActive && (
          <CreatedScreen
            code={createdCode}
            onContinue={() => onEnterOnline(pendingActive)}
            showToast={showToast}
          />
        )}

        {view === "join" && (
          <div>
            <button className="link-back" onClick={() => setView("choose")}>
              ← Natrag
            </button>
            <div className="card">
              <h2>Pridruži se natjecanju</h2>
              <p className="desc">Upiši 6-znamenkastu šifru koju ti je dao organizator.</p>
              <div className="field">
                <label htmlFor="join-code">Šifra natjecanja</label>
                <input
                  id="join-code"
                  className="input code-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={7}
                  placeholder="npr. 847 291"
                  data-testid="join-code-input"
                  value={joinCode}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
                    // prikaži s razmakom u sredini
                    setJoinCode(digits);
                    setJoinErr(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") doJoin();
                  }}
                />
                {joinErr && <div className="form-err">{joinErr}</div>}
              </div>
              <button
                className="btn btn-primary btn-block"
                onClick={doJoin}
                disabled={joining || joinCode.length !== 6}
                data-testid="join-submit"
              >
                {joining ? "Pridružujem…" : "Pridruži se"}
              </button>
            </div>
          </div>
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

// Forma za kreiranje (naziv, broj ekipa, imena ekipa)
function CreateForm({
  onCreate,
  creating,
}: {
  onCreate: (name: string, n: number, teamNames: string[]) => void;
  creating: boolean;
}) {
  const [name, setName] = useState("");
  const [num, setNum] = useState("");
  const [draftNames, setDraftNames] = useState<string[]>([]);
  const n = parseInt(num, 10);
  const valid = Number.isInteger(n) && n >= 2 && n <= 200;

  useEffect(() => {
    if (!valid) return;
    setDraftNames((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? ""));
  }, [n, valid]);

  const teamCount = valid ? n : 0;

  return (
    <div className="card">
      <h2>Kreiraj novo natjecanje</h2>
      <p className="desc">
        Svaka ekipa ima 3 člana koji pecaju u sektorima A, B i C. Ekipa sa startnim brojem 5
        ima pozicije A5, B5 i C5. Unesi broj ekipa da generiraš sve pozicije.
      </p>
      <div className="field">
        <label htmlFor="naziv">Naziv natjecanja (opcionalno)</label>
        <input
          id="naziv"
          className="input"
          type="text"
          placeholder="npr. Kup grada — Feeder liga 2025"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="broj">Broj ekipa</label>
        <input
          id="broj"
          className="input"
          type="number"
          inputMode="numeric"
          min={2}
          max={200}
          placeholder="npr. 10"
          value={num}
          onChange={(e) => setNum(e.target.value)}
        />
        <div className="hint">Generirat će se pozicije A1…An, B1…Bn, C1…Cn.</div>
      </div>
      {teamCount >= 2 && (
        <div className="field">
          <label>Nazivi ekipa (opcionalno)</label>
          <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Ako je polje prazno, ekipa se prikazuje kao „Ekipa {`{broj}`}".
          </div>
          <div className="team-names-grid">
            {Array.from({ length: teamCount }, (_, i) => (
              <div className="team-name-row" key={i}>
                <span className="team-name-num">Ekipa {i + 1}:</span>
                <input
                  className="input team-name-input"
                  type="text"
                  placeholder={`Ekipa ${i + 1}`}
                  aria-label={`Naziv ekipe ${i + 1}`}
                  value={draftNames[i] ?? ""}
                  onChange={(e) =>
                    setDraftNames((prev) => {
                      const next = [...prev];
                      next[i] = e.target.value;
                      return next;
                    })
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )}
      <button
        className="btn btn-primary btn-block"
        disabled={!valid || creating}
        data-testid="create-submit"
        onClick={() =>
          onCreate(
            name.trim(),
            n,
            Array.from({ length: n }, (_, i) => (draftNames[i] ?? "").trim())
          )
        }
      >
        {creating ? "Kreiram…" : "Kreiraj"}
      </button>
    </div>
  );
}

// Ekran nakon kreiranja — prikaže veliku šifru za podijeliti
function CreatedScreen({
  code,
  onContinue,
  showToast,
}: {
  code: string;
  onContinue: () => void;
  showToast: (m: string) => void;
}) {
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      showToast("Šifra kopirana");
    } catch {
      showToast("Kopiranje nije uspjelo");
    }
  };
  return (
    <div className="card created-card">
      <div className="created-check" aria-hidden>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>
      <h2>Natjecanje je kreirano</h2>
      <p className="desc">Podijeli ovu šifru s drugim uređajima da se pridruže istom natjecanju.</p>
      <div className="big-code" data-testid="created-code">{formatCode(code)}</div>
      <div className="row-actions" style={{ justifyContent: "center" }}>
        <button className="btn btn-ghost" onClick={copyCode}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Kopiraj šifru
        </button>
      </div>
      <button className="btn btn-primary btn-block" onClick={onContinue} data-testid="created-continue">
        Otvori vaganje
      </button>
    </div>
  );
}

function formatCode(code: string): string {
  const c = (code || "").replace(/\D/g, "");
  if (c.length === 6) return `${c.slice(0, 3)} ${c.slice(3)}`;
  return c;
}

// Zajednički header (logo + tema). Online verzija dodaje code badge + status.
function HeaderBar({
  theme,
  toggle,
  subtitle,
  children,
}: {
  theme: "light" | "dark";
  toggle: () => void;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <header className="header">
      <div className="header-inner">
        <Logo />
        <div className="header-titles">
          <div className="logo" style={{ fontSize: "1.1rem" }}>
            {APP_TITLE}
          </div>
          <div className="header-sub">{subtitle}</div>
        </div>
        {children}
        <button
          className="theme-toggle"
          onClick={toggle}
          aria-label={theme === "dark" ? "Svijetla tema" : "Tamna tema"}
        >
          {theme === "dark" ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}

// Mali badge sa šifrom + kopiraj, te status sinkronizacije.
function SyncBadge({
  code,
  status,
  pendingCount,
  onCopy,
}: {
  code: string;
  status: SyncStatus;
  pendingCount: number;
  onCopy: () => void;
}) {
  const dotCls =
    status === "synced" ? "sync-dot-green" : status === "syncing" ? "sync-dot-yellow" : "sync-dot-red";
  const tip =
    status === "synced"
      ? "Sinkronizirano sa svim uređajima"
      : status === "syncing"
      ? `Sinkronizacija u tijeku${pendingCount ? ` (${pendingCount} na čekanju)` : ""}`
      : `Izvanmrežno — promjene se spremaju lokalno${pendingCount ? ` (${pendingCount} na čekanju)` : ""}`;
  return (
    <div className="sync-badge">
      <span className="code-pill" data-testid="code-pill">
        Šifra: <b>{formatCode(code)}</b>
      </span>
      <button className="copy-code-btn" onClick={onCopy} aria-label="Kopiraj šifru" data-testid="copy-code">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <span className={`sync-dot ${dotCls}`} title={tip} data-testid="sync-dot" data-status={status} />
    </div>
  );
}

// ===================== ONLINE APP =====================
function OnlineApp({ active, onLeave }: { active: ActiveOnline; onLeave: () => void }) {
  const { theme, toggle } = useTheme();
  const [page, setPage] = useState<Page>("weigh");
  const [activeSector, setActiveSector] = useState<Sector>("A");
  const [toast, setToast] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const sync = useOnlineSync(active.id, showToast);
  const { comp, loading, syncStatus, pendingCount, deletedExternally } = sync;

  // Ako je natjecanje obrisano (lokalno ili izvana) -> vrati na home.
  useEffect(() => {
    if (deletedExternally) {
      showToast("Natjecanje je resetirano.");
      const t = setTimeout(onLeave, 1200);
      return () => clearTimeout(t);
    }
  }, [deletedExternally, onLeave, showToast]);

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(active.code);
      showToast("Šifra kopirana");
    } catch {
      showToast("Kopiranje nije uspjelo");
    }
  }, [active.code, showToast]);

  const doReset = useCallback(async () => {
    setConfirmReset(false);
    try {
      await deleteCompetition(active.id);
      showToast("Natjecanje resetirano");
      saveActiveOnline(null);
      setTimeout(onLeave, 400);
    } catch (e) {
      showToast(`Reset nije uspio: ${(e as Error).message}`);
    }
  }, [active.id, onLeave, showToast]);

  const started = !!comp;

  return (
    <>
      <HeaderBar theme={theme} toggle={toggle} subtitle={comp?.name ? comp.name : "Online natjecanje"}>
        <SyncBadge code={active.code} status={syncStatus} pendingCount={pendingCount} onCopy={copyCode} />
      </HeaderBar>

      <main className="app">
        <nav className="tabs" aria-label="Navigacija">
          <button className={`tab ${page === "weigh" ? "active" : ""}`} onClick={() => setPage("weigh")} disabled={!started}>
            Vaganje
          </button>
          <button className={`tab ${page === "sectors" ? "active" : ""}`} onClick={() => setPage("sectors")} disabled={!started}>
            Sektori
          </button>
          <button className={`tab ${page === "teams" ? "active" : ""}`} onClick={() => setPage("teams")} disabled={!started}>
            Ekipni poredak
          </button>
          <button className={`tab ${page === "setup" ? "active" : ""}`} onClick={() => setPage("setup")} disabled={!started}>
            Postavke
          </button>
        </nav>

        {loading && (
          <div className="card">
            <div className="empty">
              <p>Učitavam natjecanje…</p>
            </div>
          </div>
        )}

        {!loading && comp && (
          <>
            {page === "weigh" && (
              <WeighPage
                comp={comp}
                activeSector={activeSector}
                setActiveSector={setActiveSector}
                onChangeWeight={(sector, idx, val) => sync.setWeight(sector, idx, val)}
                onChangeStatus={(sector, idx, status) => sync.setStatus(sector, idx, status)}
              />
            )}
            {page === "sectors" && <SectorsPage comp={comp} />}
            {page === "teams" && <TeamsPage comp={comp} showToast={showToast} />}
            {page === "setup" && (
              <OnlineSetupPage
                comp={comp}
                code={active.code}
                onRenameTeams={(names) => sync.renameTeams(names)}
                onReset={() => setConfirmReset(true)}
                onCopyCode={copyCode}
              />
            )}
          </>
        )}
      </main>

      {confirmReset && (
        <div className="modal-overlay" onClick={() => setConfirmReset(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Resetirati natjecanje?</h3>
            <p>
              Natjecanje i svi uneseni rezultati bit će trajno obrisani na <strong>svim</strong>{" "}
              povezanim uređajima. Ova radnja se ne može poništiti.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmReset(false)}>
                Odustani
              </button>
              <button className="btn btn-danger" onClick={doReset} data-testid="confirm-reset">
                Resetiraj
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

// Online "Postavke" — nazivi ekipa (mijenjaju se live), šifra, reset.
function OnlineSetupPage({
  comp,
  code,
  onRenameTeams,
  onReset,
  onCopyCode,
}: {
  comp: CompetitionState;
  code: string;
  onRenameTeams: (names: string[]) => void;
  onReset: () => void;
  onCopyCode: () => void;
}) {
  const setTeamName = (i: number, v: string) => {
    const next = [...comp.teamNames];
    next[i] = v;
    onRenameTeams(next);
  };
  return (
    <div className="card">
      <h2>Postavke natjecanja</h2>
      <div className="field">
        <label>Šifra za pridruživanje</label>
        <div className="row-actions" style={{ marginTop: 6 }}>
          <span className="big-code big-code-sm">{formatCode(code)}</span>
          <button className="btn btn-ghost" onClick={onCopyCode}>Kopiraj šifru</button>
        </div>
        <div className="hint">Podijeli ovu šifru s drugim uređajima da se pridruže istom natjecanju.</div>
      </div>

      {comp.name && (
        <div className="field">
          <label>Naziv natjecanja</label>
          <div className="big-code big-code-sm" style={{ fontSize: "1.05rem", letterSpacing: 0 }}>
            {comp.name}
          </div>
        </div>
      )}

      <div className="field">
        <label>Nazivi ekipa</label>
        <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
          Promjene se odmah sinkroniziraju na sve uređaje.
        </div>
        <div className="team-names-grid">
          {Array.from({ length: comp.numTeams }, (_, i) => (
            <div className="team-name-row" key={i}>
              <span className="team-name-num">Ekipa {i + 1}:</span>
              <input
                className="input team-name-input"
                type="text"
                placeholder={`Ekipa ${i + 1}`}
                aria-label={`Naziv ekipe ${i + 1}`}
                value={comp.teamNames[i] ?? ""}
                onChange={(e) => setTeamName(i, e.target.value)}
              />
            </div>
          ))}
        </div>
      </div>

      <button className="btn btn-danger btn-block" onClick={onReset} data-testid="reset-btn">
        Resetiraj natjecanje
      </button>
    </div>
  );
}

// ===================== OFFLINE APP (legacy v2) =====================
function OfflineApp({
  initial,
  onLeave,
}: {
  initial: CompetitionState | null;
  onLeave: () => void;
}) {
  const { theme, toggle } = useTheme();
  const [comp, setComp] = useState<CompetitionState | null>(initial);
  const [page, setPage] = useState<Page>(initial ? "weigh" : "setup");
  const [activeSector, setActiveSector] = useState<Sector>("A");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    saveState(comp);
  }, [comp]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  const started = !!comp;

  return (
    <>
      <HeaderBar
        theme={theme}
        toggle={toggle}
        subtitle={comp?.name ? comp.name : "Offline natjecanje (lokalno)"}
      >
        <span className="offline-pill" title="Lokalno spremljeno natjecanje">Offline</span>
        <button className="btn btn-ghost btn-sm" onClick={onLeave}>Početni ekran</button>
      </HeaderBar>

      <main className="app">
        <nav className="tabs" aria-label="Navigacija">
          <button className={`tab ${page === "setup" ? "active" : ""}`} onClick={() => setPage("setup")}>
            Postavke
          </button>
          <button className={`tab ${page === "weigh" ? "active" : ""}`} onClick={() => setPage("weigh")} disabled={!started}>
            Vaganje
          </button>
          <button className={`tab ${page === "sectors" ? "active" : ""}`} onClick={() => setPage("sectors")} disabled={!started}>
            Sektori
          </button>
          <button className={`tab ${page === "teams" ? "active" : ""}`} onClick={() => setPage("teams")} disabled={!started}>
            Ekipni poredak
          </button>
        </nav>

        {page === "setup" && (
          <SetupPage
            comp={comp}
            onStart={(name, n, teamNames) => {
              setComp({ version: 2, name, numTeams: n, teamNames, weights: emptyWeights(n) });
              setPage("weigh");
              showToast("Natjecanje pokrenuto");
            }}
            onRenameTeams={(teamNames) => setComp((c) => (c ? { ...c, teamNames } : c))}
            onReset={() => {
              setComp(null);
              saveState(null);
              onLeave();
            }}
          />
        )}

        {page === "weigh" && comp && (
          <WeighPage
            comp={comp}
            activeSector={activeSector}
            setActiveSector={setActiveSector}
            onChangeWeight={(sector, idx, val) =>
              setComp((c) => {
                if (!c) return c;
                const arr = [...c.weights[sector]];
                arr[idx] = { ...arr[idx], weight: val };
                return { ...c, weights: { ...c.weights, [sector]: arr } };
              })
            }
            onChangeStatus={(sector, idx, status) =>
              setComp((c) => {
                if (!c) return c;
                const arr = [...c.weights[sector]];
                const next = { ...arr[idx], status };
                if (status === "absent" || status === "red") {
                  next.weight = null;
                }
                arr[idx] = next;
                return { ...c, weights: { ...c.weights, [sector]: arr } };
              })
            }
          />
        )}

        {page === "sectors" && comp && <SectorsPage comp={comp} />}
        {page === "teams" && comp && <TeamsPage comp={comp} showToast={showToast} />}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

// ===================== SETUP =====================
function SetupPage({
  comp,
  onStart,
  onRenameTeams,
  onReset,
}: {
  comp: CompetitionState | null;
  onStart: (name: string, n: number, teamNames: string[]) => void;
  onRenameTeams: (teamNames: string[]) => void;
  onReset: () => void;
}) {
  const [name, setName] = useState(comp?.name ?? "");
  const [num, setNum] = useState(comp ? String(comp.numTeams) : "");
  const [draftNames, setDraftNames] = useState<string[]>(comp?.teamNames ?? []);
  const [confirmReset, setConfirmReset] = useState(false);

  const n = parseInt(num, 10);
  const valid = Number.isInteger(n) && n >= 2 && n <= 200;

  // sinkroniziraj duljinu draftNames s n (samo prije pokretanja)
  useEffect(() => {
    if (comp) return;
    if (!valid) return;
    setDraftNames((prev) => {
      const next = Array.from({ length: n }, (_, i) => prev[i] ?? "");
      return next;
    });
  }, [n, valid, comp]);

  const teamNames = comp ? comp.teamNames : draftNames;
  const setTeamName = (i: number, v: string) => {
    if (comp) {
      const next = [...comp.teamNames];
      next[i] = v;
      onRenameTeams(next);
    } else {
      setDraftNames((prev) => {
        const next = [...prev];
        next[i] = v;
        return next;
      });
    }
  };

  const teamCount = comp ? comp.numTeams : valid ? n : 0;

  return (
    <div className="card">
      <h2>Postavljanje natjecanja</h2>
      <p className="desc">
        Svaka ekipa ima 3 člana koji pecaju u sektorima A, B i C. Ekipa sa startnim brojem 5
        ima pozicije A5, B5 i C5. Unesi broj ekipa da generiraš sve pozicije.
      </p>

      <div className="field">
        <label htmlFor="naziv">Naziv natjecanja (opcionalno)</label>
        <input
          id="naziv"
          className="input"
          type="text"
          placeholder="npr. Kup grada — Feeder liga 2025"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!!comp}
        />
      </div>

      <div className="field">
        <label htmlFor="broj">Broj ekipa</label>
        <input
          id="broj"
          className="input"
          type="number"
          inputMode="numeric"
          min={2}
          max={200}
          placeholder="npr. 10"
          value={num}
          onChange={(e) => setNum(e.target.value)}
          disabled={!!comp}
        />
        <div className="hint">
          {comp
            ? `Aktivno natjecanje: ${comp.numTeams} ekipa (${comp.numTeams * 3} pozicija). Za promjenu broja ekipa resetiraj natjecanje.`
            : "Generirat će se pozicije A1…An, B1…Bn, C1…Cn."}
        </div>
      </div>

      {teamCount >= 2 && (
        <div className="field">
          <label>Nazivi ekipa (opcionalno)</label>
          <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Ako je polje prazno, ekipa se prikazuje kao „Ekipa {`{broj}`}".
            {comp && " Nazive možeš mijenjati i tijekom natjecanja."}
          </div>
          <div className="team-names-grid">
            {Array.from({ length: teamCount }, (_, i) => (
              <div className="team-name-row" key={i}>
                <span className="team-name-num">Ekipa {i + 1}:</span>
                <input
                  className="input team-name-input"
                  type="text"
                  placeholder={`Ekipa ${i + 1}`}
                  aria-label={`Naziv ekipe ${i + 1}`}
                  value={teamNames[i] ?? ""}
                  onChange={(e) => setTeamName(i, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {!comp ? (
        <button
          className="btn btn-primary btn-block"
          disabled={!valid}
          onClick={() => onStart(name.trim(), n, Array.from({ length: n }, (_, i) => (draftNames[i] ?? "").trim()))}
        >
          Pokreni natjecanje
        </button>
      ) : (
        <button className="btn btn-danger btn-block" onClick={() => setConfirmReset(true)}>
          Resetiraj natjecanje
        </button>
      )}

      {confirmReset && (
        <div className="modal-overlay" onClick={() => setConfirmReset(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Resetirati natjecanje?</h3>
            <p>
              Svi uneseni rezultati i postavke bit će trajno obrisani. Ova radnja se ne može
              poništiti.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmReset(false)}>
                Odustani
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setConfirmReset(false);
                  onReset();
                  setName("");
                  setNum("");
                  setDraftNames([]);
                }}
              >
                Resetiraj
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===================== WEIGH =====================
function StatusBar({ comp }: { comp: CompetitionState }) {
  const { entered, total } = countEntered(comp.weights);
  const pct = total === 0 ? 0 : Math.round((entered / total) * 100);
  return (
    <div className="status-bar">
      <span className="progress-pill">
        Uneseno: <b>{entered}/{total}</b>
      </span>
      <div className="progress-track" aria-hidden>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-pill">{pct}%</span>
    </div>
  );
}

const STATUS_OPTIONS: { value: PositionStatus; label: string; title: string }[] = [
  { value: "normal", label: "Norm.", title: "Normalno — unosi se težina" },
  { value: "absent", label: "Bez člana", title: "Član nije došao" },
  { value: "yellow", label: "Žuti", title: "Žuti karton (−10%, +1 bod)" },
  { value: "red", label: "Crveni", title: "Crveni karton (0 g, +1 bod)" },
];

function teamLabel(comp: CompetitionState, idx: number): string {
  const nm = (comp.teamNames[idx] ?? "").trim();
  return nm !== "" ? nm : `Ekipa ${idx + 1}`;
}

// Čitljiva oznaka statusa za printable view
function statusText(status: PositionStatus): string {
  switch (status) {
    case "yellow":
      return "Žuti karton";
    case "red":
      return "Crveni karton";
    case "absent":
      return "Bez člana";
    default:
      return "Normalno";
  }
}

// Slugify naziv natjecanja za naziv datoteke
function fileSlug(name: string): string {
  const base = (name || "").trim();
  if (!base) {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return base
    .toLowerCase()
    .replace(/[čć]/g, "c")
    .replace(/đ/g, "d")
    .replace(/š/g, "s")
    .replace(/ž/g, "z")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "rezultati";
}

// ---------- Native PDF (jsPDF + autoTable) ----------
// Boje za izvoz: klasičan crno-bijeli dokument za ispis.
const PDF_COLORS = {
  text: [26, 26, 26] as [number, number, number], // #1a1a1a
  headerFill: [232, 232, 232] as [number, number, number], // #e8e8e8
  zebra: [245, 245, 245] as [number, number, number], // #f5f5f5
  border: [204, 204, 204] as [number, number, number], // #cccccc
  accent: [12, 91, 82] as [number, number, number], // #0c5b52 (brand)
  muted: [120, 120, 120] as [number, number, number],
};

const PDF_FONT = "LiberationSans";
let fontRegistered = false;

// Registrira embedded Unicode font (potreban za č/ć/đ/š/ž)
function ensurePdfFont(doc: jsPDF) {
  if (fontRegistered) {
    // VFS je per-document u jsPDF; registriraj svaki put po dokumentu
  }
  doc.addFileToVFS("LiberationSans-Regular.ttf", LIBERATION_SANS_REGULAR_B64);
  doc.addFont("LiberationSans-Regular.ttf", PDF_FONT, "normal");
  doc.addFileToVFS("LiberationSans-Bold.ttf", LIBERATION_SANS_BOLD_B64);
  doc.addFont("LiberationSans-Bold.ttf", PDF_FONT, "bold");
  doc.setFont(PDF_FONT, "normal");
  fontRegistered = true;
}

// Generira nativni (tekstualni) PDF s pravilnim prijelomom stranica.
function buildPdf(
  comp: CompetitionState,
  teams: TeamResultRow[],
  sectorResults: Record<Sector, SectorResultRow[]>
): jsPDF {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  ensurePdfFont(doc);

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginX = 14;

  const now = new Date();
  const stamp = now.toLocaleString("hr-HR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // ---- Header (na prvoj stranici) ----
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(15);
  doc.setTextColor(...PDF_COLORS.accent);
  doc.text(APP_TITLE, marginX, 18);

  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(13);
  doc.setTextColor(...PDF_COLORS.text);
  const compName = comp.name?.trim() ? comp.name : "Ribolovno natjecanje";
  doc.text(compName, marginX, 26);

  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(...PDF_COLORS.muted);
  doc.text(`Generirano: ${stamp}`, marginX, 32);

  let cursorY = 38;

  const commonStyles = {
    font: PDF_FONT,
    fontSize: 9,
    cellPadding: 2,
    textColor: PDF_COLORS.text,
    lineColor: PDF_COLORS.border,
    lineWidth: 0.2,
  } as const;
  const headStyles = {
    font: PDF_FONT,
    fontStyle: "bold" as const,
    fontSize: 9,
    fillColor: PDF_COLORS.headerFill,
    textColor: PDF_COLORS.text,
    lineColor: PDF_COLORS.border,
    lineWidth: 0.2,
  };
  const alternateRowStyles = { fillColor: PDF_COLORS.zebra };

  const drawSectionTitle = (title: string) => {
    // osiguraj prostor; ako nema mjesta, nova stranica
    if (cursorY > pageH - 30) {
      doc.addPage();
      cursorY = 18;
    }
    doc.setFont(PDF_FONT, "bold");
    doc.setFontSize(11.5);
    doc.setTextColor(...PDF_COLORS.text);
    doc.text(title, marginX, cursorY);
    cursorY += 2;
  };

  const sectorRows = (s: Sector) =>
    [...sectorResults[s]]
      .filter((r) => r.entered)
      .sort((a, b) => (a.points ?? 9999) - (b.points ?? 9999));

  // ============================================================
  // ---- 1) EKIPNI POREDAK — PRVI i najistaknutiji (na vrhu) ----
  // ============================================================
  const ranked = teams
    .filter((t) => t.complete)
    .sort((a, b) => (a.placement ?? 999) - (b.placement ?? 999));

  // Istaknuti naslov ekipnog poretka: veći, bold, s linijom ispod.
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(15);
  doc.setTextColor(...PDF_COLORS.accent);
  doc.text("EKIPNI POREDAK", marginX, cursorY + 4);
  doc.setDrawColor(...PDF_COLORS.accent);
  doc.setLineWidth(0.6);
  doc.line(marginX, cursorY + 6.5, pageW - marginX, cursorY + 6.5);
  cursorY += 9;

  if (ranked.length === 0) {
    doc.setFont(PDF_FONT, "normal");
    doc.setFontSize(9);
    doc.setTextColor(...PDF_COLORS.muted);
    doc.text("Nijedna ekipa nema sva 3 člana uknjižena.", marginX, cursorY + 5);
    cursorY += 12;
  } else {
    autoTable(doc, {
      startY: cursorY + 3,
      margin: { left: marginX, right: marginX },
      tableWidth: pageW - marginX * 2,
      theme: "grid",
      styles: commonStyles,
      headStyles,
      alternateRowStyles,
      rowPageBreak: "avoid",
      // Naglasi tablicu ekipnog poretka debljim okvirom oko cijele tablice.
      tableLineColor: PDF_COLORS.accent,
      tableLineWidth: 0.5,
      head: [[
        "Mjesto",
        "Startni br.",
        "Ekipa",
        "Bod. A",
        "Bod. B",
        "Bod. C",
        "Ukupno bod.",
        "Ukupna kilaža",
      ]],
      body: ranked.map((t) => [
        String(t.placement ?? ""),
        String(t.teamNumber),
        `${t.teamName}${t.hasAbsent ? " (bez člana)" : ""}`,
        fmtPoints(t.pointsA),
        fmtPoints(t.pointsB),
        fmtPoints(t.pointsC),
        fmtPoints(t.totalPoints),
        `${fmtWeight(t.totalWeight)} g`,
      ]),
      columnStyles: {
        0: { halign: "center", cellWidth: 16 },
        1: { halign: "center", cellWidth: 20 },
        2: { halign: "left" },
        3: { halign: "right", cellWidth: 15 },
        4: { halign: "right", cellWidth: 15 },
        5: { halign: "right", cellWidth: 15 },
        6: { halign: "right", cellWidth: 22, fontStyle: "bold" },
        7: { halign: "right", cellWidth: 26 },
      },
    });
    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  }

  // ============================================================
  // ---- 2) Sektorske tablice (A, B, C) — nakon ekipnog poretka ----
  // ============================================================
  for (const s of SECTORS) {
    drawSectionTitle(`Sektor ${s}`);
    const rows = sectorRows(s);
    if (rows.length === 0) {
      doc.setFont(PDF_FONT, "normal");
      doc.setFontSize(9);
      doc.setTextColor(...PDF_COLORS.muted);
      doc.text("Nema unesenih rezultata u ovom sektoru.", marginX, cursorY + 5);
      cursorY += 12;
      continue;
    }
    autoTable(doc, {
      startY: cursorY + 3,
      margin: { left: marginX, right: marginX },
      tableWidth: pageW - marginX * 2,
      theme: "grid",
      styles: commonStyles,
      headStyles,
      alternateRowStyles,
      rowPageBreak: "avoid",
      head: [["Mjesto", "Startni br.", "Ekipa", "Težina", "Status", "Bodovi"]],
      body: rows.map((r) => [
        r.status === "absent" ? "—" : fmtPoints(r.rank),
        String(r.teamNumber),
        teamLabel(comp, r.teamNumber - 1),
        sectorWeightCell(r),
        statusText(r.status),
        fmtPoints(r.points),
      ]),
      columnStyles: {
        0: { halign: "center", cellWidth: 18 },
        1: { halign: "center", cellWidth: 22 },
        2: { halign: "left" },
        3: { halign: "right", cellWidth: 34 },
        4: { halign: "center", cellWidth: 26 },
        5: { halign: "right", cellWidth: 18, fontStyle: "bold" },
      },
    });
    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  }

  // ---- Footer napomena na svakoj stranici ----
  const note =
    "Manji ukupni broj bodova = bolji plasman. Kod izjednačenja odlučuje veća ukupna kilaža.";
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont(PDF_FONT, "normal");
    doc.setFontSize(8);
    doc.setTextColor(...PDF_COLORS.muted);
    doc.text("Created by Luka Jurak", pageW / 2, pageH - 12, { align: "center" });
    doc.text(note, marginX, pageH - 8, { maxWidth: pageW - marginX * 2 });
    doc.text(`${p} / ${pageCount}`, pageW - marginX, pageH - 8, { align: "right" });
  }

  return doc;
}

function WeighPage({
  comp,
  activeSector,
  setActiveSector,
  onChangeWeight,
  onChangeStatus,
}: {
  comp: CompetitionState;
  activeSector: Sector;
  setActiveSector: (s: Sector) => void;
  onChangeWeight: (s: Sector, idx: number, val: number | null) => void;
  onChangeStatus: (s: Sector, idx: number, status: PositionStatus) => void;
}) {
  const n = comp.numTeams;

  const handleInput = (idx: number, raw: string) => {
    if (raw === "") {
      onChangeWeight(activeSector, idx, null);
      return;
    }
    const cleaned = raw.replace(/[^\d]/g, "");
    if (cleaned === "") {
      onChangeWeight(activeSector, idx, null);
      return;
    }
    onChangeWeight(activeSector, idx, parseInt(cleaned, 10));
  };

  return (
    <div>
      <StatusBar comp={comp} />

      <div className="sector-tabs" role="tablist">
        {SECTORS.map((s) => {
          const cnt = comp.weights[s].filter((p) =>
            p.status === "absent" || p.status === "red" ? true : p.weight !== null
          ).length;
          return (
            <button
              key={s}
              role="tab"
              aria-selected={activeSector === s}
              className={`sector-tab ${activeSector === s ? "active" : ""}`}
              onClick={() => setActiveSector(s)}
              style={activeSector === s ? { borderColor: SECTOR_COLORS[s] } : undefined}
            >
              Sektor {s}
              <small>
                {cnt}/{n} uneseno
              </small>
            </button>
          );
        })}
      </div>

      <div className="card">
        <h2>
          <span
            className="dot"
            style={{ width: 12, height: 12, borderRadius: "50%", background: SECTOR_COLORS[activeSector], display: "inline-block" }}
          />
          Vaganje — Sektor {activeSector}
        </h2>
        <p className="desc">
          Unesi težinu u <strong>gramima</strong> (cijeli broj). Prazno znači da natjecatelj
          još nije izvagan. Upiši <strong>0</strong> ako nema ulova. Status označava izostanak
          člana ili karton.
        </p>

        <div className="weigh-list">
          {Array.from({ length: n }, (_, i) => {
            const pos = comp.weights[activeSector][i];
            const status = pos.status;
            const val = pos.weight;
            const filled = val !== null;
            const isZero = val === 0;
            const disabledInput = status === "absent" || status === "red";
            const rowCls =
              status === "yellow"
                ? "yellow"
                : status === "red"
                ? "red"
                : status === "absent"
                ? "absent"
                : isZero
                ? "zero"
                : filled
                ? "filled"
                : "";
            return (
              <div key={i} className={`weigh-row ${rowCls}`} data-testid={`weigh-row-${activeSector}-${i + 1}`}>
                <span className="pos-tag" title={teamLabel(comp, i)}>
                  {activeSector}
                  {i + 1}
                </span>
                <input
                  className="weigh-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder={disabledInput ? "—" : "—"}
                  aria-label={`Težina za poziciju ${activeSector}${i + 1} u gramima`}
                  data-testid={`weigh-input-${activeSector}-${i + 1}`}
                  value={disabledInput ? "" : val === null ? "" : String(val)}
                  disabled={disabledInput}
                  onChange={(e) => handleInput(i, e.target.value)}
                />
                <span className="unit">g</span>
                <select
                  className={`status-select status-sel-${status}`}
                  aria-label={`Status pozicije ${activeSector}${i + 1}`}
                  data-testid={`status-select-${activeSector}-${i + 1}`}
                  value={status}
                  onChange={(e) => onChangeStatus(activeSector, i, e.target.value as PositionStatus)}
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value} title={o.title}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  className="clear-btn"
                  aria-label={`Obriši unos za ${activeSector}${i + 1}`}
                  onClick={() => {
                    onChangeWeight(activeSector, i, null);
                    onChangeStatus(activeSector, i, "normal");
                  }}
                  style={{ visibility: filled || status !== "normal" ? "visible" : "hidden" }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ===================== SECTORS =====================
function rankBadgeClass(rank: number | null): string {
  if (rank === 1) return "rank-badge rank-1";
  if (rank === 2) return "rank-badge rank-2";
  if (rank === 3) return "rank-badge rank-3";
  return "rank-badge";
}

function StatusTag({ status }: { status: PositionStatus }) {
  const b = statusBadge(status);
  if (!b) return null;
  const title =
    status === "yellow"
      ? "Žuti karton (−10%, +1 bod)"
      : status === "red"
      ? "Crveni karton (0 g, +1 bod)"
      : "Bez člana";
  return (
    <span className={`status-badge ${b.cls}`} title={title}>
      {b.label}
    </span>
  );
}

function SectorsPage({ comp }: { comp: CompetitionState }) {
  const results = useMemo(
    () => computeSectorResults(comp.weights, comp.numTeams),
    [comp.weights, comp.numTeams]
  );
  const anyEntered = countEntered(comp.weights).entered > 0;

  if (!anyEntered) {
    return (
      <div className="card">
        <div className="empty">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 13c4-7 14-9 18 0-4 7-14 7-18 0z" />
            <circle cx="9" cy="11" r="1" />
          </svg>
          <p>Još nema unesenih rezultata. Idi na karticu Vaganje i unesi rezultate da vidiš rangiranje po sektorima.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {SECTORS.map((s) => {
        const rows = [...results[s]]
          .filter((r) => r.entered)
          .sort((a, b) => {
            // absent na dno (najveći bodovi), inače po mjestu/bodovima
            const ap = a.points ?? 9999;
            const bp = b.points ?? 9999;
            return ap - bp;
          });
        const notEntered = results[s].filter((r) => !r.entered).length;
        return (
          <div className="card" key={s}>
            <div className="section-title">
              <span className="dot" style={{ background: SECTOR_COLORS[s] }} />
              Sektor {s}
              {notEntered > 0 && (
                <span className="muted" style={{ fontWeight: 500, fontSize: "0.82rem" }}>
                  · {notEntered} još neuneseno
                </span>
              )}
            </div>
            {rows.length === 0 ? (
              <p className="muted" style={{ fontSize: "0.88rem" }}>Nema unesenih rezultata u ovom sektoru.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="center">Mjesto</th>
                      <th className="center">Startni br.</th>
                      <th>Ekipa</th>
                      <th className="center">Status</th>
                      <th className="num">Težina</th>
                      <th className="num">Bodovi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const wholeRank = r.rank !== null && Number.isInteger(r.rank) ? r.rank : null;
                      const rowCls =
                        r.status === "yellow"
                          ? "row-yellow"
                          : r.status === "red"
                          ? "row-red"
                          : r.status === "absent"
                          ? "row-absent"
                          : "";
                      return (
                        <tr key={r.teamNumber} className={rowCls} data-testid={`sector-row-${s}-${r.teamNumber}`}>
                          <td className="center">
                            {r.status === "absent" ? (
                              <span className="muted">—</span>
                            ) : (
                              <span className={rankBadgeClass(wholeRank)}>{fmtPoints(r.rank)}</span>
                            )}
                          </td>
                          <td className="center strong">{r.teamNumber}</td>
                          <td>{teamLabel(comp, r.teamNumber - 1)}</td>
                          <td className="center">
                            <StatusTag status={r.status} />
                          </td>
                          <td className="num">
                            {r.status === "absent" ? (
                              <span className="muted">bez člana</span>
                            ) : r.status === "red" ? (
                              <span className="muted">0 g</span>
                            ) : r.status === "yellow" ? (
                              <span title={`Umanjeno za 10%`}>
                                {fmtWeight(r.weight)} g{" "}
                                <span className="muted">({fmtWeight(r.effectiveWeight)} g)</span>
                              </span>
                            ) : (
                              <>{r.weight === 0 ? "0" : fmtWeight(r.weight)} g</>
                            )}
                          </td>
                          <td className="num strong" data-testid={`sector-points-${s}-${r.teamNumber}`}>
                            {fmtPoints(r.points)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ===================== TEAMS =====================
function TeamsPage({ comp, showToast }: { comp: CompetitionState; showToast: (m: string) => void }) {
  const teams = useMemo(
    () => computeTeamResults(comp.weights, comp.numTeams, comp.teamNames),
    [comp.weights, comp.numTeams, comp.teamNames]
  );
  const sectorResults = useMemo(
    () => computeSectorResults(comp.weights, comp.numTeams),
    [comp.weights, comp.numTeams]
  );
  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const complete = teams.filter((t) => t.complete);
  const incomplete = teams.filter((t) => !t.complete);

  const ranked = [...complete].sort((a, b) => (a.placement ?? 999) - (b.placement ?? 999));

  const exportText = useMemo(() => buildExport(comp, teams), [comp, teams]);

  const copyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportText);
      showToast("Rezultati kopirani u međuspremnik");
    } catch {
      showToast("Kopiranje nije uspjelo");
    }
  };

  // Snapshot skrivenog printable view-a u canvas (bijela pozadina, A4 proporcije)
  const renderCanvas = useCallback(async (): Promise<HTMLCanvasElement> => {
    const el = printRef.current;
    if (!el) throw new Error("printable view nije dostupan");
    return html2canvas(el, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: el.scrollWidth,
    });
  }, []);

  const downloadPDF = useCallback(async () => {
    setExporting(true);
    try {
      // Nativni (tekstualni) PDF: autoTable pravilno prelama stranice bez rezanja redova.
      const pdf = buildPdf(comp, teams, sectorResults);
      pdf.save(`rezultati-${fileSlug(comp.name)}.pdf`);
      showToast("PDF preuzet");
    } catch {
      showToast("Izrada PDF-a nije uspjela");
    } finally {
      setExporting(false);
    }
  }, [comp, teams, sectorResults, showToast]);

  const downloadPNG = useCallback(async () => {
    setExporting(true);
    try {
      // Pričekaj da se off-screen printable view zasigurno renderira u DOM.
      await new Promise((r) => setTimeout(r, 80));
      const canvas = await renderCanvas();
      const filename = `rezultati-${fileSlug(comp.name)}.png`;

      // Sigurnije preuzimanje preko Blob + object URL (radi i u izoliranim iframe okruženjima).
      const triggerDownload = (href: string, revoke?: () => void) => {
        const link = document.createElement("a");
        link.download = filename;
        link.href = href;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        if (revoke) setTimeout(revoke, 1000);
      };

      const usedBlob = await new Promise<boolean>((resolve) => {
        if (typeof canvas.toBlob !== "function") {
          resolve(false);
          return;
        }
        canvas.toBlob((blob) => {
          if (!blob) {
            resolve(false);
            return;
          }
          const url = URL.createObjectURL(blob);
          triggerDownload(url, () => URL.revokeObjectURL(url));
          resolve(true);
        }, "image/png");
      });

      // Fallback ako toBlob nije podržan ili je vratio null.
      if (!usedBlob) {
        const dataUrl = canvas.toDataURL("image/png");
        if (!dataUrl || dataUrl === "data:,") {
          throw new Error("Prazan canvas / toDataURL nije uspio");
        }
        triggerDownload(dataUrl);
      }

      showToast("Slika preuzeta");
    } catch (err) {
      console.error("PNG izvoz nije uspio:", err);
      showToast("Izrada slike nije uspjela");
    } finally {
      setExporting(false);
    }
  }, [renderCanvas, comp.name, showToast]);

  if (complete.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 9h12l-1 11H7L6 9zM9 9V6a3 3 0 0 1 6 0v3" />
          </svg>
          <p>
            Ekipni poredak prikazuje samo ekipe kojima su sva 3 člana (A, B, C) uknjižena. Dovrši
            unos barem jedne ekipe da vidiš poredak.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="row-actions no-print">
        <button className="btn btn-primary" onClick={downloadPDF} disabled={exporting} data-testid="btn-pdf">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6M12 18v-6M9 15l3 3 3-3" />
          </svg>
          {exporting ? "Izrada…" : "Preuzmi PDF"}
        </button>
        <button className="btn btn-ghost" onClick={downloadPNG} disabled={exporting} data-testid="btn-png">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          Preuzmi sliku
        </button>
        <button className="btn btn-ghost" onClick={copyExport}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Kopiraj rezultate
        </button>
        <button className="btn btn-ghost" onClick={() => setShowExport((v) => !v)}>
          {showExport ? "Sakrij tekst" : "Tekstualni prikaz"}
        </button>
      </div>

      <div className="card">
        <h2>Ekipni poredak</h2>
        <p className="desc">
          Manji ukupni broj bodova = bolji plasman. Kod izjednačenja bodova bolja je ekipa s
          većom ukupnom kilažom. Ikona <span className="status-badge status-absent">X</span> uz
          bodove člana označava poziciju „bez člana".
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="center">Mjesto</th>
                <th>Ekipa</th>
                <th className="num">Bod. A</th>
                <th className="num">Bod. B</th>
                <th className="num">Bod. C</th>
                <th className="num">Ukupno</th>
                <th className="num">Kilaža</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((t) => (
                <tr key={t.teamNumber} data-testid={`team-row-${t.teamNumber}`}>
                  <td className="center">
                    <span className={rankBadgeClass(t.placement)}>{t.placement}</span>
                  </td>
                  <td className="strong">
                    <span className="team-startno">#{t.teamNumber}</span> {t.teamName}
                    {t.hasAbsent && (
                      <span className="status-badge status-absent" title="Ekipa ima člana bez prijave (bez člana)" style={{ marginLeft: 6 }}>
                        X
                      </span>
                    )}
                  </td>
                  <td className="num">{fmtPoints(t.pointsA)}</td>
                  <td className="num">{fmtPoints(t.pointsB)}</td>
                  <td className="num">{fmtPoints(t.pointsC)}</td>
                  <td className="num team-total" data-testid={`team-total-${t.teamNumber}`}>
                    {fmtPoints(t.totalPoints)}
                  </td>
                  <td className="num">{fmtWeight(t.totalWeight)} g</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {incomplete.length > 0 && (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>
            Nepotpune ekipe
            <span className="muted" style={{ fontWeight: 500, fontSize: "0.82rem" }}>
              · čekaju unos svih članova
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ekipa</th>
                  <th className="center">Uneseno</th>
                  <th className="num">Trenutna kilaža</th>
                </tr>
              </thead>
              <tbody>
                {incomplete.map((t) => (
                  <tr key={t.teamNumber}>
                    <td className="strong">
                      <span className="team-startno">#{t.teamNumber}</span> {t.teamName}
                    </td>
                    <td className="center muted">{t.enteredCount}/3</td>
                    <td className="num">{fmtWeight(t.totalWeight)} g</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="results-credit" aria-label="Autor aplikacije">
        Created by Luka Jurak
      </div>

      {showExport && (
        <div className="card no-print">
          <div className="section-title" style={{ marginTop: 0 }}>Tekstualni prikaz za kopiranje</div>
          <div className="export-box">{exportText}</div>
        </div>
      )}

      {/* Skriveni printable view — Čista bijela verzija za PDF / PNG izvoz */}
      <div className="print-offscreen" aria-hidden>
        <PrintableView
          ref={printRef}
          comp={comp}
          teams={teams}
          sectorResults={sectorResults}
        />
      </div>
    </div>
  );
}

function buildExport(comp: CompetitionState, teams: ReturnType<typeof computeTeamResults>): string {
  const lines: string[] = [];
  const title = comp.name || "Ribolovno natjecanje";
  lines.push(title);
  lines.push("=".repeat(Math.max(20, title.length)));
  lines.push("");
  lines.push("EKIPNI POREDAK");
  lines.push("");
  const ranked = teams.filter((t) => t.complete).sort((a, b) => (a.placement ?? 999) - (b.placement ?? 999));
  lines.push("Mj.  Ekipa                    A     B     C   Ukupno   Kilaža");
  ranked.forEach((t) => {
    const label = `#${t.teamNumber} ${t.teamName}${t.hasAbsent ? " (X)" : ""}`;
    lines.push(
      `${String(t.placement).padEnd(4)} ${label.padEnd(24)} ${fmtPoints(t.pointsA).padStart(4)} ${fmtPoints(t.pointsB).padStart(4)} ${fmtPoints(t.pointsC).padStart(4)} ${fmtPoints(t.totalPoints).padStart(7)} ${(fmtWeight(t.totalWeight) + " g").padStart(9)}`
    );
  });
  const incomplete = teams.filter((t) => !t.complete);
  if (incomplete.length > 0) {
    lines.push("");
    lines.push("Nepotpune ekipe (čekaju unos):");
    incomplete.forEach((t) => {
      lines.push(`  #${t.teamNumber} ${t.teamName} — uneseno ${t.enteredCount}/3, kilaža ${fmtWeight(t.totalWeight)} g`);
    });
  }
  lines.push("");
  lines.push("Created by Luka Jurak");
  return lines.join("\n");
}

// ===================== PRINTABLE VIEW (PDF / PNG) =====================
// Čista verzija na bijeloj pozadini, neovisna o temi. Renderira se off-screen.
const PV = {
  page: {
    width: 780,
    background: "#ffffff",
    color: "#111111",
    padding: 40,
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    boxSizing: "border-box" as const,
  },
  h1: { fontSize: 24, fontWeight: 800, margin: "0 0 4px" },
  sub: { fontSize: 13, color: "#555", margin: 0 },
  meta: { fontSize: 12, color: "#666", margin: "6px 0 0" },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 800,
    margin: "26px 0 10px",
    paddingBottom: 6,
    borderBottom: "2px solid #222",
  },
  // Istaknuti naslov ekipnog poretka (najvažniji — na vrhu).
  teamTitle: {
    fontSize: 22,
    fontWeight: 800,
    color: "#0c5b52",
    letterSpacing: "0.02em",
    margin: "20px 0 10px",
    paddingBottom: 8,
    borderBottom: "3px solid #0c5b52",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 12.5,
    fontVariantNumeric: "tabular-nums" as const,
  },
  th: {
    border: "1px solid #999",
    background: "#eef2f1",
    padding: "6px 8px",
    textAlign: "left" as const,
    fontWeight: 700,
  },
  thNum: {
    border: "1px solid #999",
    background: "#eef2f1",
    padding: "6px 8px",
    textAlign: "right" as const,
    fontWeight: 700,
  },
  thC: {
    border: "1px solid #999",
    background: "#eef2f1",
    padding: "6px 8px",
    textAlign: "center" as const,
    fontWeight: 700,
  },
  td: { border: "1px solid #bbb", padding: "5px 8px", textAlign: "left" as const },
  tdNum: {
    border: "1px solid #bbb",
    padding: "5px 8px",
    textAlign: "right" as const,
    fontVariantNumeric: "tabular-nums" as const,
  },
  tdC: { border: "1px solid #bbb", padding: "5px 8px", textAlign: "center" as const },
};

function sectorWeightCell(r: SectorResultRow): string {
  if (r.status === "absent") return "bez člana";
  if (r.status === "red") return "0 g";
  if (r.status === "yellow") return `${fmtWeight(r.weight)} g (${fmtWeight(r.effectiveWeight)} g)`;
  return `${r.weight === 0 ? "0" : fmtWeight(r.weight)} g`;
}

const PrintableView = forwardRef<
  HTMLDivElement,
  {
    comp: CompetitionState;
    teams: TeamResultRow[];
    sectorResults: Record<Sector, SectorResultRow[]>;
  }
>(function PrintableView({ comp, teams, sectorResults }, ref) {
  const now = new Date();
  const stamp = now.toLocaleString("hr-HR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const ranked = teams
    .filter((t) => t.complete)
    .sort((a, b) => (a.placement ?? 999) - (b.placement ?? 999));

  const sectorRows = (s: Sector) =>
    [...sectorResults[s]]
      .filter((r) => r.entered)
      .sort((a, b) => (a.points ?? 9999) - (b.points ?? 9999));

  return (
    <div ref={ref} style={PV.page}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <svg width="34" height="34" viewBox="0 0 32 32" fill="none">
          <path d="M6 16c3.5-6 13-8 18 0-4.5 8-14.5 6-18 0z" stroke="#0c5b52" strokeWidth="2.2" strokeLinejoin="round" />
          <path d="M24 16l5-3.5v7L24 16z" fill="#0c5b52" />
          <circle cx="11" cy="14.5" r="1.6" fill="#0c5b52" />
        </svg>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#0c5b52", letterSpacing: "0.02em" }}>
            {APP_TITLE}
          </div>
        </div>
      </div>

      <h1 style={PV.h1}>{comp.name?.trim() ? comp.name : "Natjecanje"}</h1>
      <p style={PV.sub}>Rezultati ribolovnog natjecanja</p>
      <p style={PV.meta}>Generirano: {stamp}</p>

      {/* ---- 1) EKIPNI POREDAK — PRVI i najistaknutiji (na vrhu) ---- */}
      <div style={PV.teamTitle}>EKIPNI POREDAK</div>
      {ranked.length === 0 ? (
        <p style={{ fontSize: 12, color: "#777" }}>Nijedna ekipa nema sva 3 člana uknjižena.</p>
      ) : (
        <table style={{ ...PV.table, border: "2px solid #0c5b52" }}>
          <thead>
            <tr>
              <th style={PV.thC}>Mjesto</th>
              <th style={PV.thC}>Startni br.</th>
              <th style={PV.th}>Ekipa</th>
              <th style={PV.thNum}>Bod. A</th>
              <th style={PV.thNum}>Bod. B</th>
              <th style={PV.thNum}>Bod. C</th>
              <th style={PV.thNum}>Ukupno bod.</th>
              <th style={PV.thNum}>Ukupna kilaža</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((t) => (
              <tr key={t.teamNumber}>
                <td style={PV.tdC}>{t.placement}</td>
                <td style={PV.tdC}>{t.teamNumber}</td>
                <td style={PV.td}>
                  {t.teamName}
                  {t.hasAbsent ? " (bez člana)" : ""}
                </td>
                <td style={PV.tdNum}>{fmtPoints(t.pointsA)}</td>
                <td style={PV.tdNum}>{fmtPoints(t.pointsB)}</td>
                <td style={PV.tdNum}>{fmtPoints(t.pointsC)}</td>
                <td style={{ ...PV.tdNum, fontWeight: 800 }}>{fmtPoints(t.totalPoints)}</td>
                <td style={PV.tdNum}>{fmtWeight(t.totalWeight)} g</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ---- 2) Sektorske tablice (A, B, C) — nakon ekipnog poretka ---- */}
      {SECTORS.map((s) => {
        const rows = sectorRows(s);
        return (
          <div key={s}>
            <div style={PV.sectionTitle}>Sektor {s}</div>
            {rows.length === 0 ? (
              <p style={{ fontSize: 12, color: "#777", margin: "0 0 4px" }}>
                Nema unesenih rezultata u ovom sektoru.
              </p>
            ) : (
              <table style={PV.table}>
                <thead>
                  <tr>
                    <th style={PV.thC}>Mjesto</th>
                    <th style={PV.thC}>Startni br.</th>
                    <th style={PV.th}>Ekipa</th>
                    <th style={PV.thNum}>Težina</th>
                    <th style={PV.thC}>Status</th>
                    <th style={PV.thNum}>Bodovi</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.teamNumber}>
                      <td style={PV.tdC}>{r.status === "absent" ? "—" : fmtPoints(r.rank)}</td>
                      <td style={PV.tdC}>{r.teamNumber}</td>
                      <td style={PV.td}>{teamLabel(comp, r.teamNumber - 1)}</td>
                      <td style={PV.tdNum}>{sectorWeightCell(r)}</td>
                      <td style={PV.tdC}>{statusText(r.status)}</td>
                      <td style={{ ...PV.tdNum, fontWeight: 700 }}>{fmtPoints(r.points)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}

      <p style={{ fontSize: 10.5, color: "#888", marginTop: 22 }}>
        Manji ukupni broj bodova = bolji plasman. Kod izjednačenja odlučuje veća ukupna kilaža.
      </p>
      <div style={{ borderTop: "1px solid #ddd", paddingTop: 10, marginTop: 10, textAlign: "center", fontSize: 10.5, color: "#888" }}>
        Created by Luka Jurak
      </div>
    </div>
  );
});
