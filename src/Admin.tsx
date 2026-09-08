import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

const ADMIN_EMAIL = "mailzaigre15@gmail.com";

type AdminCompetition = {
  id: string;
  code: string;
  name: string;
  num_teams: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  position_count: number;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("hr-HR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function timeLeft(expiresAt: string) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "čeka automatsko brisanje";
  const hours = Math.ceil(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return days > 0 ? `${days} d ${restHours} h` : `${hours} h`;
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  padding: "32px 16px",
  background: "var(--bg, #f4f7f6)",
  color: "var(--text, #17211f)",
};

const boxStyle: React.CSSProperties = {
  maxWidth: 980,
  margin: "0 auto",
};

const cardStyle: React.CSSProperties = {
  background: "var(--card, #fff)",
  border: "1px solid rgba(127, 212, 193, .35)",
  borderRadius: 16,
  padding: 20,
  marginBottom: 16,
};

export default function Admin() {
  const [password, setPassword] = useState("");
  const [sessionReady, setSessionReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [rows, setRows] = useState<AdminCompetition[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("admin_list_competitions");
    if (error) setMessage(`Greška: ${error.message}`);
    else setRows((data ?? []) as AdminCompetition[]);
    setLoading(false);
  }, []);

  const verifySession = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    setSignedIn(Boolean(session));
    if (!session) {
      setIsAdmin(false);
      setSessionReady(true);
      return;
    }

    const { data: allowed, error } = await supabase.rpc("is_admin");
    const ok = !error && allowed === true;
    setIsAdmin(ok);
    setSessionReady(true);
    if (ok) await refresh();
  }, [refresh]);

  useEffect(() => {
    void verifySession();
    const { data } = supabase.auth.onAuthStateChange(() => {
      void verifySession();
    });
    return () => data.subscription.unsubscribe();
  }, [verifySession]);

  const login = async () => {
    if (password.length < 6) {
      setMessage("Lozinka mora imati barem 6 znakova.");
      return;
    }
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: ADMIN_EMAIL,
      password,
    });
    if (error) setMessage(`Prijava nije uspjela: ${error.message}`);
    setLoading(false);
  };

  const createAccount = async () => {
    if (password.length < 6) {
      setMessage("Odaberi lozinku od barem 6 znakova.");
      return;
    }
    setLoading(true);
    setMessage(null);
    const { data, error } = await supabase.auth.signUp({
      email: ADMIN_EMAIL,
      password,
    });
    if (error) {
      setMessage(`Kreiranje računa nije uspjelo: ${error.message}`);
    } else if (data.session) {
      setMessage("Admin račun je kreiran i prijavljen.");
    } else {
      setMessage("Račun je kreiran. Provjeri email i potvrdi prijavu, pa se vrati na /admin.");
    }
    setLoading(false);
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setRows([]);
    setPassword("");
  };

  const removeCompetition = async (row: AdminCompetition) => {
    const label = row.name?.trim() || row.code;
    if (!window.confirm(`Obrisati natjecanje “${label}”? Ovo se ne može vratiti.`)) return;
    setLoading(true);
    const { error } = await supabase.rpc("admin_delete_competition", { target_id: row.id });
    if (error) setMessage(`Brisanje nije uspjelo: ${error.message}`);
    else {
      setMessage("Natjecanje je obrisano.");
      await refresh();
    }
    setLoading(false);
  };

  if (!sessionReady) {
    return <main style={pageStyle}><div style={boxStyle}>Učitavanje…</div></main>;
  }

  if (!signedIn) {
    return (
      <main style={pageStyle}>
        <div style={{ ...boxStyle, maxWidth: 520 }}>
          <div style={cardStyle}>
            <h1 style={{ marginTop: 0 }}>Admin pristup</h1>
            <p>Pristup je dopušten samo admin računu.</p>
            <label style={{ display: "block", marginBottom: 6 }}>Email</label>
            <input value={ADMIN_EMAIL} disabled style={{ width: "100%", boxSizing: "border-box", padding: 12, marginBottom: 12 }} />
            <label style={{ display: "block", marginBottom: 6 }}>Lozinka</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void login()}
              style={{ width: "100%", boxSizing: "border-box", padding: 12, marginBottom: 12 }}
              autoComplete="current-password"
            />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => void login()} disabled={loading} style={{ padding: "10px 16px" }}>
                {loading ? "Pričekaj…" : "Prijavi se"}
              </button>
              <button onClick={() => void createAccount()} disabled={loading} style={{ padding: "10px 16px" }}>
                Prvi put? Kreiraj admin račun
              </button>
              <button onClick={() => (window.location.href = "/")} style={{ padding: "10px 16px" }}>
                Natrag na aplikaciju
              </button>
            </div>
            {message && <p style={{ marginBottom: 0 }}>{message}</p>}
          </div>
        </div>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main style={pageStyle}>
        <div style={{ ...boxStyle, maxWidth: 520 }}>
          <div style={cardStyle}>
            <h1>Pristup odbijen</h1>
            <p>Ovaj prijavljeni račun nema administratorske ovlasti.</p>
            <button onClick={() => void logout()}>Odjavi se</button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <div style={boxStyle}>
        <div style={{ ...cardStyle, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0 }}>Admin — natjecanja</h1>
            <div style={{ opacity: .7, marginTop: 6 }}>{ADMIN_EMAIL}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => void refresh()} disabled={loading}>Osvježi</button>
            <button onClick={() => (window.location.href = "/")}>Aplikacija</button>
            <button onClick={() => void logout()}>Odjava</button>
          </div>
        </div>

        {message && <div style={cardStyle}>{message}</div>}
        <div style={cardStyle}>
          <strong>Aktivna natjecanja: {rows.length}</strong>
        </div>

        {rows.length === 0 && !loading ? (
          <div style={cardStyle}>Trenutno nema natjecanja.</div>
        ) : (
          rows.map((row) => (
            <div key={row.id} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div>
                  <h2 style={{ margin: "0 0 8px" }}>{row.name || "Bez naziva"}</h2>
                  <div><strong>Šifra:</strong> {row.code}</div>
                  <div><strong>Ekipa:</strong> {row.num_teams}</div>
                  <div><strong>Pozicija:</strong> {row.position_count}</div>
                  <div><strong>Kreirano:</strong> {formatDate(row.created_at)}</div>
                  <div><strong>Automatsko brisanje:</strong> {formatDate(row.expires_at)} ({timeLeft(row.expires_at)})</div>
                </div>
                <div style={{ display: "flex", alignItems: "flex-start" }}>
                  <button onClick={() => void removeCompetition(row)} disabled={loading}>
                    Obriši
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
