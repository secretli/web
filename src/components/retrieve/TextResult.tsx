import { useEffect, useRef, useState } from "react";
import { useCopied } from "../../hooks/useCopied";
import { useLeaveWarning } from "../../hooks/useLeaveWarning";
import { copyToClipboard } from "../../lib/clipboard";
import { saveBlob } from "../../lib/download";
import { formatSize } from "../../lib/format";
import { TEXT_SHOWN_BYTES } from "../../lib/textPreview";
import Button from "../ui/Button";
import { ArrowRightIcon, CheckIcon, CopyIcon, DownloadIcon } from "../ui/icons";
import Note from "../ui/Note";
import PageTitle from "../ui/PageTitle";
import { textButtonClass } from "../ui/styles";
import DeleteShareButton from "./DeleteShareButton";

interface TextResultProps {
  text: string;
  /** The whole text, when text is only its beginning: it is downloaded, not copied. */
  whole?: Blob;
  burnAfterRead: boolean;
  canDelete: boolean;
  deleting: boolean;
  onDelete: () => void;
}

export default function TextResult({
  text,
  whole,
  burnAfterRead,
  canDelete,
  deleting,
  onDelete,
}: TextResultProps) {
  const [copied, markCopied] = useCopied();
  const [everCopied, setEverCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  // A one-time text is gone from the server: until it was copied, or saved
  // when it is too long to show, this page has the only copy.
  useLeaveWarning(burnAfterRead && !everCopied);

  // Copying by hand counts too, when what shows is the whole text.
  useEffect(() => {
    if (!burnAfterRead || whole) return;
    const markCopied = () => setEverCopied(true);
    document.addEventListener("copy", markCopied);
    return () => document.removeEventListener("copy", markCopied);
  }, [burnAfterRead, whole]);

  async function copy() {
    if (await copyToClipboard(text, preRef.current)) {
      markCopied();
      setEverCopied(true);
    }
  }

  function download() {
    if (!whole) return;
    saveBlob(whole, "secret.txt");
    setEverCopied(true);
  }

  return (
    <div className="space-y-7">
      <PageTitle
        lead={
          burnAfterRead
            ? "This was its only opening. It's been deleted from the server."
            : "It stays available until the link expires."
        }
      >
        Here's your secret
      </PageTitle>

      {whole && (
        <Note>
          This text is {formatSize(whole.size)}, too long to show here: below is its first{" "}
          {formatSize(TEXT_SHOWN_BYTES)}. Download it to have all of it.
        </Note>
      )}

      <div className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-card">
        {/* translate="no": a page translator sends the text to its service. */}
        <pre
          ref={preRef}
          translate="no"
          className="m-0 min-h-24 overflow-x-auto whitespace-pre-wrap break-words px-6 py-5.5 font-mono text-body leading-[1.7] text-ink"
        >
          {text}
        </pre>
        <div className="flex flex-wrap items-center gap-0.5 border-t border-line p-2">
          {whole ? (
            <Button onClick={download} className="pl-4">
              {everCopied ? <CheckIcon /> : <DownloadIcon />}
              {everCopied ? "Save again" : "Download text"}
            </Button>
          ) : (
            <Button onClick={copy} className="pl-4">
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Copied" : "Copy secret"}
            </Button>
          )}
        </div>
      </div>

      {burnAfterRead && (
        <Note>
          {whole ? "Download it now." : "Copy it now."} When you leave this page, it's gone for
          good.
        </Note>
      )}

      {canDelete && <DeleteShareButton deleting={deleting} onDelete={onDelete} />}

      <a href="/share" className={textButtonClass("muted")}>
        Share a secret of your own
        <ArrowRightIcon />
      </a>
    </div>
  );
}
