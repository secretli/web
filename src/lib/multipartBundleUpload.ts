import type { EncodedKeySet, KeySet, StreamPlan } from "@secretli/format";
import { cutIntoParts, encryptStream, planStream, sha256Hex } from "@secretli/format";
import {
  ApiError,
  abortUploadSession,
  completeUploadSession,
  isTransientStatus,
  MAX_TRANSIENT_ATTEMPTS,
  retryDelayMs,
  type StartUploadSessionResponse,
  startUploadSession,
  type UploadSessionPart,
  uploadSessionPart,
} from "./api";

export const MULTIPART_UPLOAD_CONCURRENCY = 3;

export class UploadCancelledError extends Error {
  constructor() {
    super("upload cancelled");
    this.name = "UploadCancelledError";
  }
}

export interface MultipartBundleUploadParams {
  readonly files: File[];
  /** Recorded in the encrypted metadata so the reader knows how to present it. */
  readonly secretType: "text" | "bundle";
  readonly baseKeySet: KeySet;
  readonly bundleKeySet: KeySet;
  readonly passwordProtected: boolean;
  readonly expiration: string;
  readonly burnAfterRead: boolean;
  readonly onProgress?: (progress: MultipartUploadProgress) => void;
  /** Cancels the upload; the server session is aborted. */
  readonly signal?: AbortSignal;
}

export interface MultipartUploadProgress {
  readonly uploadedBytes: number;
  readonly totalBytes: number;
  readonly uploadedParts: number;
}

export interface MultipartBundleUploadResult {
  readonly expires_at: string;
  readonly encoded: EncodedKeySet;
  readonly deletionToken: string;
}

/**
 * Encrypts the files as one stream, chunk by chunk, and uploads it in parts
 * of exactly the size the server asks for, so neither side ever holds the
 * whole bundle in memory and the parts' sizes say nothing about the files.
 * A failed upload is simply started again with fresh keys; nothing about an
 * attempt is persisted.
 */
export async function uploadMultipartBundle(
  params: MultipartBundleUploadParams,
): Promise<MultipartBundleUploadResult> {
  if (params.files.length === 0) {
    throw new Error("bundle must contain at least one file");
  }
  throwIfCancelled(params.signal);

  // Planned from names and sizes alone: the exact size is known up front.
  const plan = planStream(params.files);
  const session = await createUploadSession(params, plan.totalSize);
  const encoded = params.baseKeySet.getEncoded();

  try {
    await encryptAndUploadParts(params, plan, session);
    throwIfCancelled(params.signal);
    // The server answers a repeated complete with the same result, so a
    // transient failure here must not throw the whole upload away.
    const response = await withTransientRetry(
      () => completeUploadSession(session.session_id, session.upload_token),
      params.signal,
    );
    return {
      expires_at: response.expires_at,
      encoded,
      deletionToken: encoded.deletionToken,
    };
  } catch (err) {
    // Whatever went wrong, the partial upload is useless: release it.
    await abortQuietly(session.session_id, session.upload_token);
    if (params.signal?.aborted || err instanceof UploadCancelledError) {
      throw new UploadCancelledError();
    }
    throw err;
  }
}

async function encryptAndUploadParts(
  params: MultipartBundleUploadParams,
  plan: StreamPlan,
  session: StartUploadSessionResponse,
) {
  const uploader = new UploadQueue(MULTIPART_UPLOAD_CONCURRENCY, params.signal);
  try {
    await encryptAndQueueParts(params, plan, session, uploader);
  } finally {
    // After a failure (including one while encrypting), parts still in flight
    // are pointless; after success nothing is left running.
    uploader.close();
  }
}

async function encryptAndQueueParts(
  params: MultipartBundleUploadParams,
  plan: StreamPlan,
  session: StartUploadSessionResponse,
  uploader: UploadQueue,
) {
  let uploadedBytes = 0;
  let uploadedPartCount = 0;

  const reportProgress = () => {
    params.onProgress?.({
      uploadedBytes,
      totalBytes: plan.totalSize,
      uploadedParts: uploadedPartCount,
    });
  };
  reportProgress();

  // Every part but the last is exactly part_size, cut wherever chunks begin
  // and end: part n starts at (n - 1) * part_size.
  const stream = encryptStream(plan, params.files, params.bundleKeySet);
  let partNumber = 1;
  let offset = 0;
  for await (const bytes of cutIntoParts(stream, session.part_size)) {
    throwIfCancelled(params.signal);
    // Stop encrypting as soon as any part has failed for good.
    uploader.throwIfFailed();

    const number = partNumber;
    const partOffset = offset;
    const sha256 = await sha256Hex(bytes);
    const part = new Blob([toArrayBuffer(bytes)], { type: "application/octet-stream" });
    partNumber++;
    offset += bytes.length;

    throwIfCancelled(params.signal);
    // Waits while the queue is full, so encryption never runs far ahead.
    await uploader.schedule(async (signal) => {
      const uploaded = await uploadPartWithRetry(
        session.session_id,
        session.upload_token,
        number,
        partOffset,
        part,
        sha256,
        signal,
      );
      uploadedBytes += uploaded.size;
      uploadedPartCount++;
      reportProgress();
    });
  }
  if (offset !== plan.totalSize) {
    throw new Error("bundle size mismatch");
  }

  await uploader.drain();
}

async function createUploadSession(
  params: MultipartBundleUploadParams,
  blobSize: number,
): Promise<StartUploadSessionResponse> {
  const encoded = params.baseKeySet.getEncoded();
  // The files' names are only in the bundle; the envelope pads itself.
  const encryptedMeta = await params.baseKeySet.encryptMeta({
    type: params.secretType,
    password_protected: params.passwordProtected,
  });
  return startUploadSession({
    public_id: encoded.publicID,
    metadata_token: encoded.metadataToken,
    blob_token: params.bundleKeySet.getEncoded().blobToken,
    deletion_token: encoded.deletionToken,
    encrypted_meta: encryptedMeta,
    expiration: params.expiration,
    burn_after_read: params.burnAfterRead,
    blob_size: blobSize,
  });
}

/** Best-effort abort; the server reaps expired sessions on its own anyway. */
async function abortQuietly(sessionID: string, uploadToken: string) {
  try {
    await abortUploadSession(sessionID, uploadToken);
  } catch {
    // ignore
  }
}

function uploadPartWithRetry(
  sessionID: string,
  uploadToken: string,
  partNumber: number,
  offset: number,
  part: Blob,
  sha256: string,
  signal: AbortSignal,
): Promise<UploadSessionPart> {
  return withTransientRetry(
    () => uploadSessionPart(sessionID, uploadToken, partNumber, offset, part, sha256, signal),
    signal,
  );
}

/**
 * Retries network failures, rate limiting and server errors, waiting as long
 * as the server asks (capped by retryDelayMs). Client errors are final.
 */
async function withTransientRetry<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    throwIfCancelled(signal);
    try {
      return await request();
    } catch (err) {
      if (
        !(err instanceof ApiError) ||
        !isTransientStatus(err.status) ||
        attempt === MAX_TRANSIENT_ATTEMPTS
      ) {
        throw err;
      }
      await delay(retryDelayMs(attempt, err.retryAfter), signal);
    }
  }
}

/**
 * Runs part uploads with bounded concurrency. The first failure is kept and
 * aborts the uploads still running; the caller sees it on its next schedule(),
 * throwIfFailed() or drain(), so a failed part can never go unnoticed.
 */
class UploadQueue {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly concurrency: number;
  private readonly controller = new AbortController();
  private failure: { error: unknown } | undefined;

  /** Cancelling the upload aborts every part still in flight. */
  constructor(concurrency: number, cancel?: AbortSignal) {
    this.concurrency = concurrency;
    if (cancel?.aborted) {
      this.controller.abort();
    }
    // Tied to the queue's own signal, so the listener goes away with it.
    cancel?.addEventListener("abort", () => this.controller.abort(), {
      once: true,
      signal: this.controller.signal,
    });
  }

  /** Aborts whatever is still running and detaches from the cancel signal. */
  close() {
    this.controller.abort();
  }

  async schedule(task: (signal: AbortSignal) => Promise<void>) {
    this.throwIfFailed();
    while (this.inFlight.size >= this.concurrency) {
      await Promise.race(this.inFlight);
      this.throwIfFailed();
    }
    // Queued promises never reject: a failure is recorded instead, so it is
    // reported exactly once and never becomes an unhandled rejection.
    const promise = task(this.controller.signal)
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.inFlight.delete(promise);
      });
    this.inFlight.add(promise);
  }

  throwIfFailed() {
    if (this.failure) {
      throw this.failure.error;
    }
  }

  async drain() {
    await Promise.all(this.inFlight);
    this.throwIfFailed();
  }

  private fail(error: unknown) {
    // Only the first failure matters; the rest are the aborts it caused.
    if (this.failure) return;
    this.failure = { error };
    this.controller.abort();
  }
}

function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new UploadCancelledError();
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Waits, unless the signal fires first: a cancelled upload stops waiting. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadCancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
