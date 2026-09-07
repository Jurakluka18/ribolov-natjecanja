// React hook koji upravlja online sinkronizacijom jednog natjecanja.
//
// - Učitava natjecanje + pozicije iz baze
// - Pretplaćuje se na Realtime promjene
// - Optimistic update lokalno + debounced (300ms) slanje u bazu
// - Offline queue u localStorage + retry pri povratku mreže
// - Izlaže sync status: 'synced' | 'syncing' | 'offline'

import { useCallback, useEffect, useRef, useState } from "react";
import type { PositionStatus, Sector } from "./scoring";
import {
  getCompetition,
  getPositions,
  subscribeToCompetition,
  updateCompetitionMeta,
  updatePosition,
} from "./supabase";
import {
  applyPositionChange,
  buildOnlineCompetition,
  enqueue,
  loadQueue,
  type OnlineCompetition,
  type QueuedUpdate,
  saveQueue,
} from "./sync";

export type SyncStatus = "synced" | "syncing" | "offline";

export interface UseOnlineSyncResult {
  comp: OnlineCompetition | null;
  loading: boolean;
  error: string | null;
  syncStatus: SyncStatus;
  pendingCount: number;
  // Akcije
  setWeight: (sector: Sector, idx: number, weight: number | null) => void;
  setStatus: (sector: Sector, idx: number, status: PositionStatus) => void;
  renameTeams: (teamNames: string[]) => void;
  // signalizira da je natjecanje obrisano izvana (drugi uređaj resetirao)
  deletedExternally: boolean;
}

const DEBOUNCE_MS = 300;

export function useOnlineSync(
  competitionId: string | null,
  onToast?: (m: string) => void
): UseOnlineSyncResult {
  const [comp, setComp] = useState<OnlineCompetition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("syncing");
  const [pendingCount, setPendingCount] = useState(0);
  const [deletedExternally, setDeletedExternally] = useState(false);

  // queue u ref-u (za sinkroni pristup unutar timera/eventova)
  const queueRef = useRef<QueuedUpdate[]>([]);
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const onlineRef = useRef<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );

  const refreshPending = useCallback(() => {
    setPendingCount(queueRef.current.length);
  }, []);

  // Ažuriraj sync status na temelju queue i mreže.
  const recomputeStatus = useCallback(() => {
    if (!onlineRef.current) {
      setSyncStatus("offline");
      return;
    }
    setSyncStatus(queueRef.current.length > 0 ? "syncing" : "synced");
  }, []);

  // Pošalji jedan update u bazu; pri grešci ostavi u queue.
  const flushOne = useCallback(
    async (u: QueuedUpdate): Promise<boolean> => {
      try {
        await updatePosition({
          competitionId: u.competitionId,
          sector: u.sector,
          teamNumber: u.teamNumber,
          weightGrams: u.weightGrams,
          status: u.status,
        });
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  // Pokušaj poslati cijeli queue.
  const flushQueue = useCallback(async () => {
    if (!onlineRef.current) {
      recomputeStatus();
      return;
    }
    if (queueRef.current.length === 0) {
      recomputeStatus();
      return;
    }
    setSyncStatus("syncing");
    const items = [...queueRef.current];
    const remaining: QueuedUpdate[] = [];
    let anyFail = false;
    for (const u of items) {
      const ok = await flushOne(u);
      if (!ok) {
        anyFail = true;
        remaining.push(u);
      }
    }
    queueRef.current = remaining;
    saveQueue(remaining);
    refreshPending();
    if (anyFail) {
      onlineRef.current = navigator.onLine;
      setSyncStatus(onlineRef.current ? "syncing" : "offline");
    } else {
      recomputeStatus();
    }
  }, [flushOne, recomputeStatus, refreshPending]);

  // Inicijalno učitavanje + queue iz localStorage.
  useEffect(() => {
    if (!competitionId) {
      setComp(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDeletedExternally(false);
    queueRef.current = loadQueue();
    refreshPending();

    (async () => {
      try {
        const c = await getCompetition(competitionId);
        if (!c) {
          if (!cancelled) {
            setDeletedExternally(true);
            setLoading(false);
          }
          return;
        }
        const positions = await getPositions(competitionId);
        if (cancelled) return;
        setComp(buildOnlineCompetition(c, positions));
        setLoading(false);
        recomputeStatus();
        // Pokušaj poslati eventualni zaostali queue.
        flushQueue();
      } catch (e) {
        if (cancelled) return;
        // Mreža nedostupna pri učitavanju -> offline, ali app radi.
        setError((e as Error).message);
        setSyncStatus("offline");
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId]);

  // Realtime subscription.
  useEffect(() => {
    if (!competitionId) return;
    const unsub = subscribeToCompetition(
      competitionId,
      (change) => {
        if (change.kind === "competition_deleted") {
          setDeletedExternally(true);
          return;
        }
        if (change.kind === "competition") {
          const row = change.row;
          setComp((prev) => {
            if (!prev) return prev;
            const teamNames = Array.from({ length: row.num_teams }, (_, i) =>
              (row.team_names?.[String(i + 1)] ?? "").trim()
            );
            return { ...prev, name: row.name ?? "", teamNames };
          });
          return;
        }
        // position change — primijeni ako nije lokalno u queue-u (zadnji updated_at).
        const row = change.row;
        const key = `${row.sector}-${row.team_number}`;
        const pending = queueRef.current.find(
          (q) => `${q.sector}-${q.teamNumber}` === key
        );
        if (pending) {
          // Imamo vlastiti pending upis — ne pregazi ga tuđom (starijom) verzijom.
          return;
        }
        setComp((prev) =>
          prev ? { ...prev, weights: applyPositionChange(prev.weights, row) } : prev
        );
      },
      (status) => {
        // Realtime status -> grubo mapiraj na sync status kad nema queue.
        if (status === "SUBSCRIBED") {
          onlineRef.current = navigator.onLine;
          recomputeStatus();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          if (queueRef.current.length === 0) {
            // ne forsiraj offline ako su podaci ok; samo signaliziraj sinkronizaciju
          }
        }
      }
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId]);

  // Online/offline eventi.
  useEffect(() => {
    const goOnline = () => {
      onlineRef.current = true;
      onToast?.("Mreža je vraćena — sinkroniziram…");
      flushQueue();
    };
    const goOffline = () => {
      onlineRef.current = false;
      setSyncStatus("offline");
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushQueue]);

  // Zajednička logika za zakazivanje update-a (debounce po poziciji).
  const scheduleUpdate = useCallback(
    (sector: Sector, teamNumber: number, weightGrams: number | null, status: PositionStatus) => {
      if (!competitionId) return;
      const u: QueuedUpdate = {
        competitionId,
        sector,
        teamNumber,
        weightGrams,
        status,
        ts: Date.now(),
      };
      // Ubaci u queue odmah (zadnja vrijednost pobjeđuje) i perzistiraj.
      queueRef.current = enqueue(queueRef.current, u);
      saveQueue(queueRef.current);
      refreshPending();
      setSyncStatus(onlineRef.current ? "syncing" : "offline");

      const key = `${sector}-${teamNumber}`;
      if (debounceTimers.current[key]) clearTimeout(debounceTimers.current[key]);
      debounceTimers.current[key] = setTimeout(async () => {
        delete debounceTimers.current[key];
        if (!onlineRef.current) {
          setSyncStatus("offline");
          return;
        }
        // Pošalji samo najnoviju verziju ove pozicije.
        const latest = queueRef.current.find(
          (q) => `${q.sector}-${q.teamNumber}` === key
        );
        if (!latest) {
          recomputeStatus();
          return;
        }
        const ok = await flushOne(latest);
        if (ok) {
          queueRef.current = queueRef.current.filter(
            (q) => `${q.sector}-${q.teamNumber}` !== key
          );
          saveQueue(queueRef.current);
          refreshPending();
          recomputeStatus();
        } else {
          onlineRef.current = navigator.onLine;
          setSyncStatus(onlineRef.current ? "syncing" : "offline");
          onToast?.("Sinkronizacija nije uspjela — spremljeno lokalno.");
        }
      }, DEBOUNCE_MS);
    },
    [competitionId, flushOne, recomputeStatus, refreshPending, onToast]
  );

  const setWeight = useCallback(
    (sector: Sector, idx: number, weight: number | null) => {
      let nextStatus: PositionStatus = "normal";
      setComp((prev) => {
        if (!prev) return prev;
        const arr = [...prev.weights[sector]];
        nextStatus = arr[idx]?.status ?? "normal";
        arr[idx] = { ...arr[idx], weight };
        return { ...prev, weights: { ...prev.weights, [sector]: arr } };
      });
      scheduleUpdate(sector, idx + 1, weight, nextStatus);
    },
    [scheduleUpdate]
  );

  const setStatus = useCallback(
    (sector: Sector, idx: number, status: PositionStatus) => {
      let nextWeight: number | null = null;
      setComp((prev) => {
        if (!prev) return prev;
        const arr = [...prev.weights[sector]];
        const next = { ...arr[idx], status };
        if (status === "absent" || status === "red") next.weight = null;
        nextWeight = next.weight;
        arr[idx] = next;
        return { ...prev, weights: { ...prev.weights, [sector]: arr } };
      });
      scheduleUpdate(sector, idx + 1, nextWeight, status);
    },
    [scheduleUpdate]
  );

  const renameTeams = useCallback(
    (teamNames: string[]) => {
      setComp((prev) => (prev ? { ...prev, teamNames } : prev));
      if (!competitionId) return;
      setSyncStatus(onlineRef.current ? "syncing" : "offline");
      updateCompetitionMeta({ competitionId, teamNames })
        .then(() => recomputeStatus())
        .catch(() => {
          if (onlineRef.current) onToast?.("Spremanje naziva nije uspjelo.");
          setSyncStatus(onlineRef.current ? "syncing" : "offline");
        });
    },
    [competitionId, recomputeStatus, onToast]
  );

  return {
    comp,
    loading,
    error,
    syncStatus,
    pendingCount,
    setWeight,
    setStatus,
    renameTeams,
    deletedExternally,
  };
}
