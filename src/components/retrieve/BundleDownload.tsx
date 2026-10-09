import type { BundleEntry } from "@secretli/format";
import { useEffect, useState } from "react";
import { useLeaveWarning } from "../../hooks/useLeaveWarning";
import { formatSize } from "../../lib/format";
import Spinner from "../Spinner";
import Button from "../ui/Button";
import IconButton from "../ui/IconButton";
import { ArrowRightIcon, CheckIcon, DownloadIcon, FileIcon } from "../ui/icons";
import Note from "../ui/Note";
import PageTitle from "../ui/PageTitle";
import ProgressRow from "../ui/ProgressRow";
import { textButtonClass } from "../ui/styles";
import DeleteShareButton from "./DeleteShareButton";

/** 0..1 of the files decrypted so far, with a label like "4.0 MB / 10.0 MB". */
export interface DownloadProgress {
  fraction: number;
  label: string;
}

/** What is being downloaded: every file not saved yet, or the one at index. */
export type Downloading = { kind: "all" } | { kind: "file"; index: number };

function secondsUntil(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}

function useSecondsUntil(iso: string): number {
  const [seconds, setSeconds] = useState(() => secondsUntil(iso));
  useEffect(() => {
    setSeconds(secondsUntil(iso));
    const timer = window.setInterval(() => setSeconds(secondsUntil(iso)), 1000);
    return () => window.clearInterval(timer);
  }, [iso]);
  return seconds;
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

interface BundleDownloadProps {
  files: readonly BundleEntry[];
  totalSize: number;
  sessionExpiresAt: string;
  burnAfterRead: boolean;
  downloading: Downloading | null;
  progress: DownloadProgress | null;
  /** The files decrypted so far, by index: saving them again fetches nothing. */
  decryptedFiles: ReadonlyMap<number, Blob>;
  /** The files handed to the browser at least once, by index. */
  savedFiles: ReadonlySet<number>;
  canDelete: boolean;
  deleting: boolean;
  onDownloadAll: () => void;
  onDownloadFile: (index: number) => void;
  onDelete: () => void;
}

/** The file list and download controls once the bundle has been opened. */
export default function BundleDownload({
  files,
  totalSize,
  sessionExpiresAt,
  burnAfterRead,
  downloading,
  progress,
  decryptedFiles,
  savedFiles,
  canDelete,
  deleting,
  onDownloadAll,
  onDownloadFile,
  onDelete,
}: BundleDownloadProps) {
  const isMulti = files.length > 1;
  const secondsLeft = useSecondsUntil(sessionExpiresAt);
  const windowClosed = secondsLeft === 0;
  const someSaved = files.some((file) => savedFiles.has(file.index));
  const allSaved = files.every((file) => savedFiles.has(file.index));
  // Once a file is in memory the server session no longer matters for it.
  const allDecrypted = files.every((file) => decryptedFiles.has(file.index));
  const expired = windowClosed && !allDecrypted;
  const canGet = (file: BundleEntry) =>
    downloading === null && (decryptedFiles.has(file.index) || !windowClosed);
  // A one-time share is gone from the server: until every file is saved,
  // this page holds the only way to get the rest.
  const onlyCopyHere =
    burnAfterRead &&
    files.some(
      (file) => !savedFiles.has(file.index) && (decryptedFiles.has(file.index) || !windowClosed),
    );
  useLeaveWarning(onlyCopyHere);

  const countdown = formatCountdown(secondsLeft);
  const note = allSaved
    ? isMulti
      ? "Saved. If your browser blocked one of them, use the button next to that file."
      : "Saved. Use Save to save it again."
    : expired
      ? burnAfterRead
        ? "The download window closed. This one-time secret can't be opened again."
        : "The download window closed. Open the link again to start a new one."
      : burnAfterRead
        ? isMulti
          ? `One-time: files you don't save in the next ${countdown} are gone for good.`
          : `One-time: if you don't save it in the next ${countdown}, it's gone for good.`
        : `${countdown} left to download.`;

  return (
    <div className="space-y-7">
      <PageTitle lead={`${files.length} ${isMulti ? "files" : "file"} · ${formatSize(totalSize)}`}>
        {isMulti ? "Here are your files" : "Here's your file"}
      </PageTitle>

      <div className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-card">
        <ul className="m-0 list-none px-2.5 pt-2.5 pb-1.5">
          {files.map((file) => {
            const saved = savedFiles.has(file.index);
            return (
              <li
                key={file.index}
                data-testid={`bundle-file-${file.index}`}
                className={`flex min-h-13 items-center gap-3 pl-3.5 ${isMulti ? "pr-0.5" : "pr-2"}`}
              >
                <span className={`flex ${saved ? "text-ink" : "text-faint"}`}>
                  {saved ? <CheckIcon /> : <FileIcon />}
                </span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-sm text-ink"
                  title={file.name}
                >
                  {file.name}
                </span>
                <span className="text-[13px] tabular-nums text-faint">{formatSize(file.size)}</span>
                {isMulti && (
                  <IconButton
                    label={saved ? `Save ${file.name} again` : `Download ${file.name}`}
                    disabled={!canGet(file)}
                    onClick={() => onDownloadFile(file.index)}
                  >
                    {downloading?.kind === "file" && downloading.index === file.index ? (
                      <Spinner size="sm" />
                    ) : (
                      <DownloadIcon />
                    )}
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-0.5 border-t border-line p-2">
          <Button
            onClick={onDownloadAll}
            disabled={downloading !== null || expired}
            className="pl-4"
          >
            <DownloadIcon />
            {downloading?.kind === "all"
              ? "Preparing…"
              : allSaved
                ? "Save again"
                : !isMulti
                  ? "Download file"
                  : someSaved
                    ? "Download the rest"
                    : "Download files"}
          </Button>
        </div>
        {downloading && (
          <ProgressRow
            label={progress ? `Decrypting · ${progress.label}` : "Reading the encrypted data…"}
            fraction={progress?.fraction}
          />
        )}
      </div>

      <Note>{note}</Note>

      {canDelete && <DeleteShareButton deleting={deleting} onDelete={onDelete} />}

      <a href="/share" className={textButtonClass("muted")}>
        Share a secret of your own
        <ArrowRightIcon />
      </a>
    </div>
  );
}
