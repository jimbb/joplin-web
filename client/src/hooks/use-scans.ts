import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { getScans } from "@/lib/api";
import type { ScanJob, ScanStatus } from "@/lib/types";
import { useAuth } from "@/hooks/use-auth";
import { useRefresh } from "@/hooks/use-connection";

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function jobsById(data: ScanStatus): Map<string, ScanJob> {
  const jobs = [...(data.jobs ?? []), ...(data.recent ?? [])];
  return new Map(jobs.map((job) => [job.id, job]));
}

/** Poll interval selected from the latest answer. */
export function scanRefetchInterval(data: ScanStatus | undefined): number | false {
  if (!data || data.enabled === false) return false;
  return (data.active ?? 0) > 0 || data.cycle?.running ? 3_000 : 30_000;
}

/** Polls scan status lightly while work is active and reports completed scans once per transition. */
export function useScans() {
  const { isAuthenticated } = useAuth();
  const visible = useDocumentVisible();
  const navigate = useNavigate();
  const { refresh } = useRefresh();
  const seen = useRef<Map<string, ScanJob>>(new Map());
  const initialized = useRef(false);
  const query = useQuery<ScanStatus>({
    queryKey: ["scans"],
    queryFn: getScans,
    enabled: Boolean(isAuthenticated) && visible,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchIntervalInBackground: false,
    refetchInterval: (current) => scanRefetchInterval(current.state.data as ScanStatus | undefined),
  });

  useEffect(() => {
    const data = query.data;
    if (!data || !data.enabled) return;
    const current = jobsById(data);
    if (!initialized.current) {
      initialized.current = true;
      current.forEach((job) => seen.current.set(job.id, job));
      return;
    }
    const completed = [...current.values()].filter((job) => {
      const previous = seen.current.get(job.id);
      return job.stage === "done" && previous && previous.stage !== "done";
    });
    current.forEach((job) => seen.current.set(job.id, job));
    if (completed.length === 0) return;
    void refresh();
    for (const job of completed) {
      toast.success("Scan added to Pending to sort", {
        action: {
          label: "Open",
          onClick: () => navigate(job.noteId ? `/notes/${job.noteId}` : "/notes"),
        },
      });
    }
  }, [navigate, query.data, refresh]);

  return query;
}
