import { forwardRef, useState } from "react";
import { Link } from "react-router-dom";
import { ScanLine } from "lucide-react";
import type { ScanCycle, ScanJob, ScanStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1_000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ago`;
}

function until(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(value) - Date.now()) / 1_000));
  if (seconds < 60) return "less than a minute";
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} min`;
}

function fileSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_024 * 1_024) return `${Math.round(size / 1_024)} KB`;
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`;
}

function cycleSummary(cycle: ScanCycle | undefined): string {
  if (!cycle?.running) {
    if (cycle?.result === "failed") return "Last run failed";
    return cycle?.nextRunAt ? `Idle, next run in ${until(cycle.nextRunAt)}` : "Idle";
  }
  if (cycle.phase === "sync") return "Syncing with Joplin Server";
  if (cycle.phase === "import") return "Importing";
  if (cycle.phase === "ocr") return `OCR: ${cycle.ocrDone} of ${cycle.ocrTotal} attachments`;
  if (cycle.phase === "upload") return "Uploading";
  return "Importing";
}

function currentStep(stage: ScanJob["stage"]): number {
  if (stage === "syncing") return 2;
  if (stage === "done") return 3;
  if (stage === "ocr" || stage === "queued") return 1;
  return 0;
}

function stageText(job: ScanJob, cycle: ScanCycle | undefined): string {
  if (job.stalled) return "Interrupted, continues on the next run";
  if (job.error && (job.stage === "received" || job.stage === "importing")) return "Import failed, retrying on the next run";
  if (job.stage === "received") {
    return cycle?.running && !["sync", "import"].includes(cycle.phase)
      ? "Waiting for the current run to finish"
      : "Waiting for import";
  }
  if (job.stage === "importing") return "Importing into Pending to sort";
  if (job.stage === "queued") return `Waiting for OCR, #${job.queuePosition ?? 1} in queue`;
  if (job.stage === "ocr") return job.pages ? `OCR page ${job.page ?? 1} of ${job.pages}` : "OCR in progress";
  if (job.stage === "syncing") return "Uploading to Joplin Server";
  return job.error ?? "Ready";
}

function JobSteps({ job }: { job: ScanJob }) {
  const active = currentStep(job.stage);
  return (
    <div className="mt-2 flex items-center gap-1 text-[10px] font-medium text-muted-foreground" aria-label="Import, OCR, Sync, Done">
      {["Import", "OCR", "Sync", "Done"].map((step, index) => (
        <span key={step} className="flex items-center gap-1">
          <span className={cn("rounded-full border px-1.5 py-0.5", index === active && "border-primary bg-primary/10 text-primary", index < active && "border-primary/40 text-primary/80")}>
            {step}
          </span>
          {index < 3 && <span className="text-border">→</span>}
        </span>
      ))}
    </div>
  );
}

function JobRow({ job, cycle }: { job: ScanJob; cycle: ScanCycle | undefined }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground" title={job.name}>{job.name || "Unnamed file"}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{fileSize(job.size)} · {relativeTime(job.receivedAt)}</p>
        </div>
        {job.noteId && <Link className="shrink-0 text-primary hover:underline" to={`/notes/${job.noteId}`}>Open</Link>}
      </div>
      <JobSteps job={job} />
      <p className={cn("mt-2 text-muted-foreground", job.error && "text-amber-600 dark:text-amber-400")}>{stageText(job, cycle)}</p>
      {job.stage === "ocr" && job.pages && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={job.pages} aria-valuenow={job.page ?? 0}>
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, ((job.page ?? 0) / job.pages) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

function RecentRow({ job }: { job: ScanJob }) {
  const text = job.stage === "done"
    ? job.error ? "Ready, OCR failed" : `Ready, ${relativeTime(job.doneAt ?? job.updatedAt)}`
    : job.stage === "skipped" ? "Not a document, kept on the server" : job.error ?? "Failed";
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <div className="min-w-0">
        <p className={cn("truncate text-foreground", job.error && "text-amber-600 dark:text-amber-400")} title={job.name}>{text}</p>
        <p className="truncate text-[11px] text-muted-foreground">{job.name}</p>
      </div>
      {job.noteId && <Link className="shrink-0 text-primary hover:underline" to={`/notes/${job.noteId}`}>Open</Link>}
    </div>
  );
}

export function ScanQueueContent({ status }: { status: ScanStatus }) {
  const active = status.active ?? 0;
  const jobs = status.jobs ?? [];
  const recent = status.recent ?? [];
  return (
    <div className="flex flex-col gap-4 p-1 text-foreground">
      <div>
        <h2 className="text-sm font-semibold">Scans</h2>
        <p className="mt-1 text-xs text-muted-foreground">{active > 0 ? `${active} in the pipeline` : "Nothing in progress"}</p>
      </div>
      {status.available === false ? (
        <p className="text-xs text-muted-foreground">Scan status unavailable</p>
      ) : (
        <>
          <div className="rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">OCR run</span>
            <span className="ml-2">{cycleSummary(status.cycle)}</span>
          </div>
          {jobs.length > 0 ? (
            <section className="space-y-2" aria-label="Active scans">
              {jobs.map((job) => <JobRow key={job.id} job={job} cycle={status.cycle} />)}
            </section>
          ) : (
            <p className="text-xs text-muted-foreground">Files sent to the server with Taildrop show up here while they are imported and OCR&apos;d.</p>
          )}
          {recent.length > 0 && (
            <section className="space-y-2 border-t border-border/60 pt-3" aria-label="Recent scans">
              <h3 className="text-xs font-medium text-muted-foreground">Recent · 24 h</h3>
              {recent.map((job) => <RecentRow key={job.id} job={job} />)}
            </section>
          )}
        </>
      )}
    </div>
  );
}

const QueueButton = forwardRef<HTMLButtonElement, { active: number; onClick?: () => void }>(function QueueButton(
  { active, onClick },
  ref
) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      className={cn("relative h-8 w-8 text-muted-foreground hover:text-foreground", active > 0 && "motion-safe:animate-pulse")}
      aria-label={`Scan queue, ${active} in progress`}
      title="Scan queue"
    >
      <ScanLine className="h-4 w-4" />
      {active > 0 && <span className="absolute -right-0.5 -top-1 min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">{active}</span>}
    </Button>
  );
});

/** Responsive scan queue control. Desktop uses a popover and phones use a bottom sheet. */
export function ScanQueue({ status }: { status: ScanStatus }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useIsMobile();
  const active = status.active ?? 0;
  return (
    <>
      {!isMobile && (
        <Popover>
          <PopoverTrigger asChild><QueueButton active={active} /></PopoverTrigger>
          <PopoverContent side="bottom" align="end" className="h-[min(620px,calc(100vh-5rem))] w-[min(420px,calc(100vw-2rem))] overflow-y-auto p-3"><ScanQueueContent status={status} /></PopoverContent>
        </Popover>
      )}
      {isMobile && (
        <>
        <QueueButton active={active} onClick={() => setSheetOpen(true)} />
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="max-h-[85vh] w-full overflow-y-auto rounded-t-xl px-4 pb-8 pt-5 data-[state=closed]:hidden">
            <SheetTitle className="sr-only">Scan queue</SheetTitle>
            <ScanQueueContent status={status} />
          </SheetContent>
        </Sheet>
        </>
      )}
    </>
  );
}
