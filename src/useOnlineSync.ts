// React hook koji upravlja online sinkronizacijom jednog natjecanja.
//
// Svaki unos prvo se sprema lokalno, zatim se šalje dok ga baza ne potvrdi.
// DB snapshoti se spajaju s lokalnim nepotvrđenim unosima kako refresh ne bi
// pregazio rezultat unesen pri slabom signalu.

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
  applyQueuedUpdates,
  buildOnlineCompetition,
  enqueue,
  loadCachedCompetition,
  loadQueue,
  pendingForCompetition,
  removeAcknowledged,
  removeCachedCompetition,
  saveCachedCompetition,
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
  setWeight: (sector: Sector, idx: number, weight: number | null) => void;
  setStatus: (sector: Sector, idx: number, status: PositionStatus) => void;
  renameTeams: (teamNames: string[]) => void;
  deletedExternally: boolean;
}

const DEBOUNCE_MS = 300;
const RETRY_MS = 5_000;
const REFRESH_MS = 15_000;

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

  const compRef = useRef<OnlineCompetition | null>(null);
  const queueRef = useRef<QueuedUpdate[]>([]);
  const flushRunningRef = useRef(false);
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const setLocalComp = useCallback((next: OnlineCompetition | null) => {
    compRef.current = next;
    setComp(next);
    if (next) saveCachedCompetition(next);
  }, []);

  const refreshPending = useCallback(() => {
    const count = competitionId
      ? pendingForCompetition(queueRef.current, competitionId).length
      : 0;
    setPendingCount(count);
    return count;
  }, [competitionId]);

  const fetchSnapshot = useCallback(async (): Promise<boolean> => {
    if (!competitionId) return false;
    try {
      const remoteCompetition = await getCompetition(competitionId);
      if (!remoteCompetition) {
        removeCachedCompetition(competitionId);
        setDeletedExternally(true);
        return false;
      }
      const positions = await getPositions(competitionId);
      const merged = applyQueuedUpdates(
        buildOnlineCompetition(remoteCompetition, positions),
        queueRef.current
      );
      setLocalComp(merged);
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      if (pendingForCompetition(queueRef.current, competitionId).length > 0) {
        setSyncStatus("offline");
      }
      return false;
    }
  }, [competitionId, setLocalComp]);

  const flushQueue = useCallback(async () => {
    if (!competitionId || flushRunningRef.current) return;
    const pending = pendingForCompetition(queueRef.current, competitionId);
    if (pending.length === 0) {
      setSyncStatus(navigator.onLine ? "synced" : "offline");
      return;
    }
    if (!navigator.onLine) {
      setSyncStatus("offline");
      return;
    }

    flushRunningRef.current = true;
    setSyncStatus("syncing");
    let failed = false;
    try {
      for (const update of [...pending].sort((a, b) => a.ts - b.ts)) {
        try {
          await updatePosition({
            competitionId: update.competitionId,
            sector: update.sector,
            teamNumber: update.teamNumber,
            weightGrams: update.weightGrams,
            status: update.status,
          });
          // Ako je za istu poziciju tijekom slanja nastala novija vrijednost,
          // potvrda starog upisa nju neće ukloniti.
          queueRef.current = removeAcknowledged(queueRef.current, update);
          saveQueue(queueRef.current);
          refreshPending();
        } catch {
          failed = true;
        }
      }
    } finally {
      flushRunningRef.current = false;
    }

    const remaining = refreshPending();
    if (remaining === 0) {
      const refreshed = await fetchSnapshot();
      setSyncStatus(refreshed ? "synced" : "offline");
    } else {
      setSyncStatus(failed ? "offline" : "syncing");
    }
  }, [competitionId, fetchSnapshot, refreshPending]);

  // Lokalni cache učitava se odmah, pa aplikacija radi i nakon refresha bez signala.
  /* Initial hydration intentionally restores externally persisted local state. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!competitionId) {
      setLocalComp(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setDeletedExternally(false);
    setError(null);
    queueRef.current = loadQueue();
    refreshPending();

    const cached = loadCachedCompetition(competitionId);
    if (cached) {
      setLocalComp(applyQueuedUpdates(cached, queueRef.current));
      setLoading(false);
      setSyncStatus(
        navigator.onLine
          ? pendingForCompetition(queueRef.current, competitionId).length > 0
            ? "syncing"
            : "synced"
          : "offline"
      );
    } else {
      setLoading(true);
      setSyncStatus(navigator.onLine ? "syncing" : "offline");
    }

    (async () => {
      const loaded = await fetchSnapshot();
      if (cancelled) return;
      setLoading(false);
      if (loaded) await flushQueue();
      else if (!cached) setSyncStatus("offline");
    })();

    return () => {
      cancelled = true;
    };
  }, [competitionId, fetchSnapshot, flushQueue, refreshPending, setLocalComp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!competitionId) return;
    const unsubscribe = subscribeToCompetition(
      competitionId,
      (change) => {
        if (change.kind === "competition_deleted") {
          removeCachedCompetition(competitionId);
          setDeletedExternally(true);
          return;
        }
        if (change.kind === "competition") {
          const row = change.row;
          const current = compRef.current;
          if (!current) return;
          const teamNames = Array.from({ length: row.num_teams }, (_, i) =>
            (row.team_names?.[String(i + 1)] ?? "").trim()
          );
          setLocalComp({ ...current, name: row.name ?? "", teamNames });
          return;
        }

        const row = change.row;
        const hasPending = pendingForCompetition(queueRef.current, competitionId).some(
          (q) => q.sector === row.sector && q.teamNumber === row.team_number
        );
        if (hasPending) return;

        const current = compRef.current;
        if (current) {
          setLocalComp({
            ...current,
            weights: applyPositionChange(current.weights, row),
          });
        }
      },
      (status) => {
        if (status === "SUBSCRIBED" && refreshPending() === 0) {
          setSyncStatus("synced");
        }
      }
    );
    return unsubscribe;
  }, [competitionId, refreshPending, setLocalComp]);

  // Retry radi stalno dok je stranica otvorena. Povratak mreže, fokusiranje
  // aplikacije i povratak iz pozadine pokreću sinkronizaciju odmah.
  useEffect(() => {
    if (!competitionId) return;

    const retryTimer = window.setInterval(() => {
      void flushQueue();
    }, RETRY_MS);
    const refreshTimer = window.setInterval(() => {
      if (navigator.onLine) void fetchSnapshot();
    }, REFRESH_MS);

    const syncNow = () => {
      void flushQueue();
      if (navigator.onLine) void fetchSnapshot();
    };
    const onOffline = () => setSyncStatus("offline");
    const onVisibility = () => {
      if (document.visibilityState === "visible") syncNow();
    };

    window.addEventListener("online", syncNow);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", syncNow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(retryTimer);
      window.clearInterval(refreshTimer);
      window.removeEventListener("online", syncNow);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", syncNow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [competitionId, fetchSnapshot, flushQueue]);

  const scheduleUpdate = useCallback(
    (
      sector: Sector,
      teamNumber: number,
      weightGrams: number | null,
      status: PositionStatus
    ) => {
      if (!competitionId) return;
      const now = Date.now();
      const update: QueuedUpdate = {
        competitionId,
        sector,
        teamNumber,
        weightGrams,
        status,
        ts: now,
        token: `${now}-${Math.random().toString(36).slice(2)}`,
      };
      queueRef.current = enqueue(queueRef.current, update);
      saveQueue(queueRef.current);
      refreshPending();
      setSyncStatus(navigator.onLine ? "syncing" : "offline");

      const key = `${competitionId}-${sector}-${teamNumber}`;
      if (debounceTimers.current[key]) clearTimeout(debounceTimers.current[key]);
      debounceTimers.current[key] = setTimeout(() => {
        delete debounceTimers.current[key];
        void flushQueue();
      }, DEBOUNCE_MS);
    },
    [competitionId, flushQueue, refreshPending]
  );

  const setWeight = useCallback(
    (sector: Sector, idx: number, weight: number | null) => {
      const current = compRef.current;
      if (!current) return;
      const positions = [...current.weights[sector]];
      const status = positions[idx]?.status ?? "normal";
      positions[idx] = { ...positions[idx], weight };
      // Queue ide na disk prije cachea: i prekid baš usred unosa ostavlja
      // vrijednost za kasnije slanje i vraćanje na ekran.
      scheduleUpdate(sector, idx + 1, weight, status);
      setLocalComp({
        ...current,
        weights: { ...current.weights, [sector]: positions },
      });
    },
    [scheduleUpdate, setLocalComp]
  );

  const setStatus = useCallback(
    (sector: Sector, idx: number, status: PositionStatus) => {
      const current = compRef.current;
      if (!current) return;
      const positions = [...current.weights[sector]];
      const next = { ...positions[idx], status };
      if (status === "absent" || status === "red") next.weight = null;
      positions[idx] = next;
      scheduleUpdate(sector, idx + 1, next.weight, status);
      setLocalComp({
        ...current,
        weights: { ...current.weights, [sector]: positions },
      });
    },
    [scheduleUpdate, setLocalComp]
  );

  const renameTeams = useCallback(
    (teamNames: string[]) => {
      const current = compRef.current;
      if (current) setLocalComp({ ...current, teamNames });
      if (!competitionId) return;
      setSyncStatus(navigator.onLine ? "syncing" : "offline");
      updateCompetitionMeta({ competitionId, teamNames })
        .then(() => {
          if (refreshPending() === 0) setSyncStatus("synced");
        })
        .catch(() => {
          onToast?.("Spremanje naziva nije uspjelo.");
          setSyncStatus("offline");
        });
    },
    [competitionId, onToast, refreshPending, setLocalComp]
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
