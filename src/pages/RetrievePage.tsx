import {
  type DecryptedEntry,
  DOWNLOAD_ALL_BUNDLE_COALESCED_PLAINTEXT_BYTES,
  isShareFragment,
  KeySet,
  type OpenedBundle,
  openBundle,
  type SecretMeta,
} from "@secretli/format";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DownloadProgress } from "../components/retrieve/BundleDownload";
import BundleDownload from "../components/retrieve/BundleDownload";
import LinkPrompt from "../components/retrieve/LinkPrompt";
import {
  RetrieveError,
  RetrieveLoading,
  ShareDeleted,
} from "../components/retrieve/RetrieveStatus";
import ShareDetails from "../components/retrieve/ShareDetails";
import ShareGone from "../components/retrieve/ShareGone";
import TextResult from "../components/retrieve/TextResult";
import { usePageTitle } from "../hooks/usePageTitle";
import {
  ApiError,
  deleteSecret,
  getSecretMetadata,
  isTransientStatus,
  type RetrievalSessionResponse,
  retrieveSecretRange,
  type SecretGone,
  type SecretMetadataResponse,
  secretGoneFromError,
  startRetrievalSession,
} from "../lib/api";
import { saveFilesSequentially } from "../lib/download";
import { formatSize } from "../lib/format";

/**
 * The server has no secret for this link and cannot tell why: one that
 * expired answers like one that never existed. The owner is the sender, so
 * there is nobody to ask for a new link.
 */
function notFound(owner: boolean): { title: string; message: string; owner: boolean } {
  const why = "It may have expired, been opened or been deleted. Nothing is left on the server";
  return {
    title: "This secret is gone",
    message: owner ? `${why}.` : `${why}, so ask the sender for a new link if you still need it.`,
    owner,
  };
}

/** The fragment is not a share link, typically because it was cut off when copied. */
const DAMAGED = {
  title: "This link is damaged",
  message: "This link is incomplete or damaged. Check that you copied all of it.",
};

/** An error page for everything the other titles don't cover. */
function failed(message: string, owner: boolean): State {
  return { stage: "error", title: "Something went wrong", message, owner };
}

/**
 * Everything derived from the URL fragment. The base key set is derived once
 * and reused; only the blob key depends on a password.
 */
interface ShareIdentity {
  readonly baseKeySet: KeySet;
  readonly deletionToken: string;
  /** Needed to re-derive the blob key from a password. */
  readonly shareSecret: string;
}

interface DecryptedMeta {
  serverMeta: SecretMetadataResponse;
  clientMeta: SecretMeta;
}

type State =
  | { stage: "prompt" }
  | { stage: "loading" }
  | { stage: "confirm"; identity: ShareIdentity; meta: DecryptedMeta }
  | { stage: "decrypted"; identity: ShareIdentity; text: string; burnAfterRead: boolean }
  | {
      stage: "bundle-ready";
      identity: ShareIdentity;
      /** Reads the files through the retrieval session it was opened with. */
      bundle: OpenedBundle;
      sessionExpiresAt: string;
      burnAfterRead: boolean;
    }
  | { stage: "deleted" }
  | { stage: "gone"; gone: SecretGone; owner: boolean }
  | { stage: "error"; title: string; message: string; owner: boolean };

/** The server did not accept the blob token: the link or password is wrong. */
class BlobTokenRejectedError extends Error {}

/** The retrieval session ran out before the share could be read. */
class RetrievalSessionExpiredError extends Error {
  readonly burnAfterRead: boolean;

  constructor(burnAfterRead: boolean) {
    super("retrieval session expired");
    this.burnAfterRead = burnAfterRead;
  }
}

/** Strips the share secret from the address bar so it does not linger in history. */
function stripFragmentFromLocation() {
  if (!window.location.hash) return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

export default function RetrievePage() {
  // Read the fragment exactly once: it is removed from the address bar as soon
  // as it has been parsed, and effects may run more than once in development.
  const initialHashRef = useRef(window.location.hash.slice(1));
  const [state, setState] = useState<State>(
    initialHashRef.current ? { stage: "loading" } : { stage: "prompt" },
  );
  usePageTitle("Open a secret");
  const [revealing, setRevealing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloadingBundle, setDownloadingBundle] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloadedFiles, setDownloadedFiles] = useState<DecryptedEntry[] | null>(null);
  // Starting a retrieval session is what burns a burn-after-read share, so a
  // started session is kept and reused until the server stops accepting it. A
  // failure while reading must not throw away the only chance to read.
  const retrievalRef = useRef<{ blobToken: string; session: RetrievalSessionResponse } | null>(
    null,
  );

  const fetchMetadata = useCallback(async () => {
    const hash = initialHashRef.current;
    if (!hash) {
      setState({ stage: "prompt" });
      return;
    }
    stripFragmentFromLocation();

    // Split before checking: an owner link cut off inside its deletion token is
    // still an owner link.
    const delimiterIndex = hash.indexOf("!");
    const shareSecret = delimiterIndex >= 0 ? hash.slice(0, delimiterIndex) : hash;
    const deletionToken = delimiterIndex >= 0 ? hash.slice(delimiterIndex + 1) : "";
    const owner = Boolean(deletionToken);
    if (!isShareFragment(hash)) {
      setState({ stage: "error", ...DAMAGED, owner });
      return;
    }

    try {
      const baseKeySet = await KeySet.fromShareSecret(shareSecret);
      const encoded = baseKeySet.getEncoded();
      const serverMeta = await getSecretMetadata(encoded.publicID, encoded.metadataToken);
      const clientMeta = await baseKeySet.decryptMeta(serverMeta.encrypted_meta);

      setState({
        stage: "confirm",
        identity: { baseKeySet, deletionToken, shareSecret },
        meta: { serverMeta, clientMeta },
      });
    } catch (err) {
      const gone = secretGoneFromError(err);
      if (gone) {
        setState({ stage: "gone", gone, owner });
      } else if (err instanceof ApiError) {
        if (err.status === 404) {
          setState({ stage: "error", ...notFound(owner) });
        } else if (err.status === 403) {
          setState({ stage: "error", ...DAMAGED, owner });
        } else {
          setState(failed(err.message, owner));
        }
      } else {
        setState(failed("An unexpected error occurred.", owner));
      }
    }
  }, []);

  useEffect(() => {
    fetchMetadata();
  }, [fetchMetadata]);

  // A share link opened while this page is showing, from the address bar or
  // by the prompt, only changes the fragment, which doesn't reload the page.
  // Reload so the new share starts from scratch, with nothing of the
  // previous one left on screen or in memory.
  useEffect(() => {
    function handleHashChange() {
      if (window.location.hash.length > 1) window.location.reload();
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  /** Returns a message for the password field, or null once the share has been revealed. */
  async function handleReveal(password?: string): Promise<string | null> {
    if (state.stage !== "confirm") return null;
    const { identity, meta } = state;

    setRevealing(true);
    try {
      const blobKeySet = meta.clientMeta.password_protected
        ? await KeySet.fromShareSecret(identity.shareSecret, password ?? "")
        : identity.baseKeySet;
      await reveal(identity, blobKeySet, meta.clientMeta);
      return null;
    } catch (err) {
      // Only a rejected blob token means a wrong password. Once the server
      // accepted it the password was right, whatever fails afterwards.
      if (meta.clientMeta.password_protected && err instanceof BlobTokenRejectedError) {
        return "Wrong password. Try again.";
      }
      handleRevealError(err, identity);
      return null;
    } finally {
      setRevealing(false);
    }
  }

  async function reveal(identity: ShareIdentity, blobKeySet: KeySet, clientMeta: SecretMeta) {
    if (clientMeta.type !== "text" && clientMeta.type !== "bundle") {
      setState({
        stage: "error",
        title: "This link can't be opened here",
        message: "It uses a format this version of Secretli doesn't understand.",
        owner: Boolean(identity.deletionToken),
      });
      return;
    }

    // The public ID always comes from the share secret; blob access may be
    // password-derived.
    const publicID = identity.baseKeySet.getEncoded().publicID;
    const session = await retrievalSession(
      publicID,
      blobKeySet.getEncoded().blobToken,
      identity.deletionToken,
    );

    let bundle: OpenedBundle;
    let text: string | undefined;
    try {
      // Text and files share one storage format, so both start the same way.
      // Opening fetches a small bundle whole, and the opened bundle keeps
      // what it fetched, so nothing is fetched twice.
      bundle = await openBundle(
        (start: number, end: number) =>
          retrieveSecretRange(publicID, session.session_token, start, end),
        blobKeySet,
        session.blob_size,
      );
      if (clientMeta.type === "text") {
        text = await (await bundle.decryptFile(0)).text();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        retrievalRef.current = null;
        throw new RetrievalSessionExpiredError(session.burn_after_read);
      }
      throw err;
    }

    if (text !== undefined) {
      setState({ stage: "decrypted", identity, text, burnAfterRead: session.burn_after_read });
      return;
    }

    setDownloadedFiles(null);
    setState({
      stage: "bundle-ready",
      identity,
      bundle,
      sessionExpiresAt: session.expires_at,
      burnAfterRead: session.burn_after_read,
    });
  }

  /** Reuses the session already started with this blob token, if any. */
  async function retrievalSession(
    publicID: string,
    blobToken: string,
    deletionToken: string,
  ): Promise<RetrievalSessionResponse> {
    const kept = retrievalRef.current;
    if (kept && kept.blobToken === blobToken) {
      return kept.session;
    }
    // The server already accepted a token for this share, and a share has
    // exactly one: any other token comes from a mistyped password. Asking the
    // server would only get a 404 once a burn-after-read share is consumed.
    if (kept) {
      throw new BlobTokenRejectedError();
    }
    try {
      const session = await startRetrievalSession(publicID, blobToken, deletionToken || undefined);
      retrievalRef.current = { blobToken, session };
      return session;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        throw new BlobTokenRejectedError();
      }
      throw err;
    }
  }

  /**
   * Transient failures leave the page as it is so the reader can retry with
   * the session already started; only definite answers end on an error page.
   */
  function handleRevealError(err: unknown, identity: ShareIdentity) {
    const owner = Boolean(identity.deletionToken);
    if (err instanceof BlobTokenRejectedError) {
      setState({
        stage: "error",
        title: "This link can't open the secret",
        message: "It doesn't fit the secret it points to. Ask the sender to send it again.",
        owner,
      });
      return;
    }
    if (err instanceof RetrievalSessionExpiredError) {
      if (err.burnAfterRead) {
        // A new session would only get 404: the share was consumed.
        setState({
          stage: "error",
          title: "The download window closed",
          message:
            "This one-time secret was opened, and the time to download it has passed. It can't be opened again.",
          owner,
        });
      } else {
        toast.error("The download window has expired. Please try again.");
      }
      return;
    }
    if (!(err instanceof ApiError)) {
      setState(failed("An unexpected error occurred.", owner));
      return;
    }
    if (err.status === 404) {
      // It went away between showing it and opening it; the server can say why.
      void explainGone(identity);
    } else if (err.status === 429) {
      toast.error("Too many attempts. Please wait a minute and try again.");
    } else if (err.status === 0) {
      toast.error(err.message);
    } else if (isTransientStatus(err.status)) {
      toast.error("The server could not complete the request. Please try again.");
    } else {
      setState(failed(err.message, owner));
    }
  }

  /** Asks what became of a secret that the server just refused to open. */
  async function explainGone(identity: ShareIdentity) {
    const encoded = identity.baseKeySet.getEncoded();
    const owner = Boolean(identity.deletionToken);
    try {
      await getSecretMetadata(encoded.publicID, encoded.metadataToken);
      setState({ stage: "error", ...notFound(owner) });
    } catch (err) {
      const gone = secretGoneFromError(err);
      setState(gone ? { stage: "gone", gone, owner } : { stage: "error", ...notFound(owner) });
    }
  }

  async function handleDelete(identity: ShareIdentity) {
    if (!identity.deletionToken) return;

    setDeleting(true);
    try {
      const encoded = identity.baseKeySet.getEncoded();
      await deleteSecret(encoded.publicID, encoded.metadataToken, identity.deletionToken);
      setState({ stage: "deleted" });
      toast.success("Secret deleted");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete the secret.");
    } finally {
      setDeleting(false);
    }
  }

  async function downloadAll() {
    if (state.stage !== "bundle-ready") return;
    const { bundle } = state;
    const { totalSize } = bundle;

    // Already decrypted once (for example a browser blocked some of the
    // saves): just hand the blobs to the browser again.
    if (downloadedFiles) {
      await saveDecrypted(downloadedFiles);
      return;
    }

    setDownloadingBundle(true);
    setDownloadProgress({ fraction: 0, label: `0 B / ${formatSize(totalSize)}` });
    try {
      const files = await bundle.decryptFiles(undefined, {
        maxCoalescedPlaintextBytes: DOWNLOAD_ALL_BUNDLE_COALESCED_PLAINTEXT_BYTES,
        onProgress: ({ decryptedBytes }) => {
          const done = Math.min(decryptedBytes, totalSize);
          setDownloadProgress({
            fraction: totalSize > 0 ? done / totalSize : 1,
            label: `${formatSize(done)} / ${formatSize(totalSize)}`,
          });
        },
      });
      setDownloadedFiles(files);
      await saveDecrypted(files);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        toast.error("The download window has expired. Open the link again to restart.");
      } else {
        toast.error(err instanceof ApiError ? err.message : "Failed to download files.");
      }
    } finally {
      setDownloadingBundle(false);
      setDownloadProgress(null);
    }
  }

  function saveDecrypted(files: DecryptedEntry[]) {
    return saveFilesSequentially(files.map(({ entry, blob }) => ({ name: entry.name, blob })));
  }

  switch (state.stage) {
    case "prompt":
      // /c is the short address the sender's code panel names.
      return <LinkPrompt initialMode={window.location.pathname === "/c" ? "code" : "choose"} />;
    case "loading":
      return <RetrieveLoading />;
    case "error":
      return <RetrieveError title={state.title} message={state.message} owner={state.owner} />;
    case "deleted":
      return <ShareDeleted />;
    case "gone":
      return <ShareGone gone={state.gone} owner={state.owner} />;
    case "confirm":
      return (
        <ShareDetails
          serverMeta={state.meta.serverMeta}
          clientMeta={state.meta.clientMeta}
          revealing={revealing}
          deleting={deleting}
          canDelete={Boolean(state.identity.deletionToken)}
          onReveal={handleReveal}
          onDelete={() => handleDelete(state.identity)}
        />
      );
    case "decrypted":
      return (
        <TextResult
          text={state.text}
          burnAfterRead={state.burnAfterRead}
          // Revealing a one-time secret already deleted it from the server.
          canDelete={Boolean(state.identity.deletionToken) && !state.burnAfterRead}
          deleting={deleting}
          onDelete={() => handleDelete(state.identity)}
        />
      );
    case "bundle-ready":
      return (
        <BundleDownload
          files={state.bundle.files}
          totalSize={state.bundle.totalSize}
          sessionExpiresAt={state.sessionExpiresAt}
          burnAfterRead={state.burnAfterRead}
          downloading={downloadingBundle}
          progress={downloadProgress}
          downloadedFiles={downloadedFiles}
          canDelete={Boolean(state.identity.deletionToken) && !state.burnAfterRead}
          deleting={deleting}
          onDownloadAll={downloadAll}
          onDelete={() => handleDelete(state.identity)}
        />
      );
  }
}
