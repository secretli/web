import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatSize } from "../../lib/format";
import type { MultipartUploadProgress } from "../../lib/multipartBundleUpload";
import { formatRate, formatTimeLeft, RateMeter } from "../../lib/transferRate";

/** After this long without a byte going out, the line says the upload waits. */
const STALL_MS = 8_000;

interface UploadProgressRowProps {
  progress: MultipartUploadProgress;
  /** A way out, like a cancel button. */
  action?: ReactNode;
}

/**
 * The bottom row of the composer during a file upload: one bar in three
 * parts that always add up to the bundle. Sent grows from the left, what is
 * encrypted and waiting for the network follows it, and what is still to
 * read shrinks on the right. Below it, what each part holds, and a line that
 * says what is happening right now: the rate and time left, or why it waits.
 */
export default function UploadProgressRow({ progress, action }: UploadProgressRowProps) {
  const { totalBytes, encryptedBytes, sentBytes, retrying } = progress;
  const meter = useRef(new RateMeter());
  meter.current.add(sentBytes);

  // Ticks while nothing arrives, so a stall shows up without new progress.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const at = Math.max(now, Date.now());

  const share = (bytes: number) => (totalBytes > 0 ? (bytes / totalBytes) * 100 : 0);
  const sent = Math.min(sentBytes, totalBytes);
  const waiting = Math.max(Math.min(encryptedBytes, totalBytes) - sent, 0);
  const toRead = Math.max(totalBytes - sent - waiting, 0);
  const percent = Math.round(share(sent));

  // The line holds the numbers while all is well, and says what is wrong
  // when it isn't. Only that is announced: the numbers change many times a
  // second, and the progress bar carries the value.
  const rate = meter.current.rate(at);
  let notice = "";
  if (retrying) {
    notice = "A part didn't go through. Trying it again…";
  } else if (sent >= totalBytes && totalBytes > 0) {
    notice = "Sent. Waiting for the server to confirm…";
  } else if (sent === 0) {
    notice = encryptedBytes > 0 ? "Encrypting, connecting…" : "Reading your files…";
  } else if (meter.current.stillFor(at) >= STALL_MS) {
    notice = "Waiting for the network…";
  }
  const amounts = `${formatSize(sent)} of ${formatSize(totalBytes)}`;
  const pace =
    rate !== null && rate > 0
      ? `${formatRate(rate)} · ${formatTimeLeft((totalBytes - sent) / rate)}`
      : "";

  return (
    <div className="space-y-3 border-t border-line px-6 py-4 motion-safe:animate-fade">
      <div
        role="progressbar"
        aria-label="Upload"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% sent, ${formatSize(waiting)} ready to send, ${formatSize(toRead)} still to read`}
        className="flex h-1.5 overflow-hidden rounded-full bg-line-strong"
      >
        <div
          className="h-full bg-accent transition-[width] duration-200 ease-linear"
          style={{ width: `${share(sent)}%` }}
        />
        <div
          className={`h-full transition-[width] duration-200 ease-linear ${STRIPES}`}
          style={{ width: `${share(waiting)}%` }}
        />
      </div>

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted">
        {/* On a phone the pace or notice gets a line of its own, not a ragged break. */}
        <p className="min-w-0 flex-1 tabular-nums">
          <span className="whitespace-nowrap">
            <span className="text-ink">{percent}%</span> · {amounts}
          </span>
          {!notice && pace && <Then>{pace}</Then>}
          <span role="status">{notice && <Then>{notice}</Then>}</span>
        </p>
        {action}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
        <Legend swatch="bg-accent">Sent</Legend>
        <Legend swatch={STRIPES}>Ready to send</Legend>
        <Legend swatch="bg-line-strong">To read</Legend>
        <span className="sm:ml-auto">Keep this tab open until the link appears.</span>
      </div>
    </div>
  );
}

/** The encrypted bytes not sent yet: the accent, faded and striped. */
const STRIPES =
  "bg-accent/35 bg-[repeating-linear-gradient(135deg,transparent_0_3px,color-mix(in_srgb,var(--accent)_45%,transparent)_3px_6px)]";

/** What follows the amounts: after a dot where there is room, on its own line on a phone. */
function Then({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="max-sm:hidden"> · </span>
      <span className="max-sm:block">{children}</span>
    </>
  );
}

function Legend({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className={`size-2 rounded-full ${swatch}`} />
      {children}
    </span>
  );
}
