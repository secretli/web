import { KeySet, openBundle, plannedBundleSize } from "@secretli/format";
import { ApiError, type StartUploadSessionResponse, type UploadSessionPart } from "../api";
import { UploadCancelledError, uploadMultipartBundle } from "../multipartBundleUpload";

const api = vi.hoisted(() => ({
  startUploadSession: vi.fn(),
  uploadSessionPart: vi.fn(),
  completeUploadSession: vi.fn(),
  abortUploadSession: vi.fn(),
  // Reset to return undefined, so retries in tests do not actually wait.
  retryDelayMs: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return { ...original, ...api };
});

const MIB = 1024 * 1024;
// Small part size so a 13 MiB file yields more than one part in tests.
const TEST_PART_SIZE = 6 * MIB;

/** Reads an assembled object as a bundle. */
function openAssembled(blob: Uint8Array, keySet: KeySet) {
  const fetchRange = async (start: number, end: number) => blob.slice(start, end + 1);
  return openBundle(fetchRange, keySet, blob.length);
}

interface FakeServer {
  status: StartUploadSessionResponse;
  parts: Map<number, { part: UploadSessionPart; bytes: Uint8Array }>;
  sessionCounter: number;
}

function installFakeServer(): FakeServer {
  const server: FakeServer = {
    status: {
      session_id: "",
      upload_token: "",
      public_id: "",
      part_size: TEST_PART_SIZE,
      blob_size: 0,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      upload_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      state: "pending",
    },
    parts: new Map(),
    sessionCounter: 0,
  };

  api.startUploadSession.mockImplementation(async (params) => {
    server.sessionCounter++;
    server.parts.clear();
    server.status = {
      ...server.status,
      session_id: `session-${server.sessionCounter}`,
      public_id: params.public_id,
      blob_size: params.blob_size,
      state: "pending",
      upload_token: `token-${server.sessionCounter}`,
    };
    return server.status;
  });
  api.uploadSessionPart.mockImplementation(
    async (_session, _token, partNumber, offset, bytes: Blob, sha256) => {
      const part: UploadSessionPart = {
        part_number: partNumber,
        offset,
        size: bytes.size,
        sha256,
        etag: `etag-${partNumber}`,
      };
      server.parts.set(partNumber, { part, bytes: new Uint8Array(await bytes.arrayBuffer()) });
      return part;
    },
  );
  api.completeUploadSession.mockImplementation(async () => {
    server.status = { ...server.status, state: "completed" };
    return { expires_at: server.status.expires_at };
  });
  api.abortUploadSession.mockImplementation(async () => {
    server.status = { ...server.status, state: "aborted" };
  });
  return server;
}

function patternedFile(size: number, name = "payload.bin"): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 3) & 0xff;
  return new File([bytes], name, { type: "application/octet-stream" });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  // Deep equality on multi-megabyte typed arrays is far too slow in the
  // matcher; compare buffers directly.
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );
}

function assembledBlob(server: FakeServer): Uint8Array {
  const parts = Array.from(server.parts.values()).sort(
    (a, b) => a.part.part_number - b.part.part_number,
  );
  const total = parts.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const entry of parts) {
    expect(entry.part.offset).toBe(cursor);
    out.set(entry.bytes, cursor);
    cursor += entry.bytes.length;
  }
  return out;
}

async function baseParams(files: File[], password?: string) {
  const baseKeySet = await KeySet.generateRandom();
  const bundleKeySet = password
    ? await KeySet.fromShareSecret(baseKeySet.getEncoded().shareSecret, password)
    : baseKeySet;
  return {
    files,
    secretType: "bundle" as const,
    baseKeySet,
    bundleKeySet,
    passwordProtected: password !== undefined,
    expiration: "1d",
    burnAfterRead: false,
  };
}

describe("uploadMultipartBundle", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
  });

  it("cuts the encrypted bundle into parts of exactly the part size, the last one shorter", async () => {
    const server = installFakeServer();
    const file = patternedFile(13 * MIB);
    const params = await baseParams([file]);
    const progress: number[] = [];

    const result = await uploadMultipartBundle({
      ...params,
      onProgress: (p) => progress.push(p.uploadedBytes),
    });

    expect(api.startUploadSession).toHaveBeenCalledTimes(1);
    expect(api.completeUploadSession).toHaveBeenCalledTimes(1);
    expect(api.abortUploadSession).not.toHaveBeenCalled();
    // Fixed offsets: part n starts at (n - 1) * part_size, wherever chunks end.
    const parts = Array.from(server.parts.values())
      .map((entry) => entry.part)
      .sort((a, b) => a.part_number - b.part_number);
    expect(parts.map((part) => part.part_number)).toEqual([1, 2, 3]);
    for (const [i, part] of parts.entries()) {
      expect(part.offset).toBe(i * TEST_PART_SIZE);
    }
    for (const part of parts.slice(0, -1)) {
      expect(part.size).toBe(TEST_PART_SIZE);
    }
    expect(parts.at(-1)?.size).toBeGreaterThan(0);
    expect(parts.at(-1)?.size).toBeLessThan(TEST_PART_SIZE);

    // The declared size is the planned one, padding included.
    const blob = assembledBlob(server);
    expect(server.status.blob_size).toBe(plannedBundleSize([file]));
    expect(blob.length).toBe(server.status.blob_size);
    expect(progress.at(-1)).toBe(blob.length);

    // The assembled object is a version 3 bundle that decrypts with the bundle key.
    const bundle = await openAssembled(blob, params.bundleKeySet);
    expect(bundle.version).toBe(3);
    expect(bundle.files).toEqual([
      { index: 0, name: "payload.bin", type: "application/octet-stream", size: 13 * MIB },
    ]);
    const decrypted = new Uint8Array(await (await bundle.decryptFile(0)).arrayBuffer());
    expect(sameBytes(decrypted, new Uint8Array(await file.arrayBuffer()))).toBe(true);
    expect(result.encoded.shareSecret).toBe(params.baseKeySet.getEncoded().shareSecret);
    expect(result.deletionToken).toBe(params.baseKeySet.getEncoded().deletionToken);
  }, 30_000);

  it("uploads a small bundle as a single part", async () => {
    const server = installFakeServer();
    const params = await baseParams([patternedFile(64, "tiny.bin")], "hunter2");

    await uploadMultipartBundle(params);

    expect(server.parts.size).toBe(1);
    const blob = assembledBlob(server);
    expect(blob.length).toBe(server.status.blob_size);
    const bundle = await openAssembled(blob, params.bundleKeySet);
    expect(bundle.version).toBe(3);
    expect(bundle.files.map((file) => file.name)).toEqual(["tiny.bin"]);
    // The password-derived key is what protects the blob, not the base key.
    await expect(openAssembled(blob, params.baseKeySet)).rejects.toThrow();
  });

  it("keeps the files' names out of the envelope", async () => {
    installFakeServer();
    const params = await baseParams([patternedFile(64, "names-stay-inside.bin")]);

    await uploadMultipartBundle(params);

    const [{ encrypted_meta }] = api.startUploadSession.mock.calls[0];
    expect(await params.baseKeySet.decryptMeta(encrypted_meta)).toEqual({
      type: "bundle",
      password_protected: false,
    });
  });

  it("retries transient part failures but not client errors", async () => {
    installFakeServer();
    const file = patternedFile(64);

    const original = api.uploadSessionPart.getMockImplementation();
    let calls = 0;
    api.uploadSessionPart.mockImplementation(async (...args) => {
      calls++;
      if (calls === 1) throw new ApiError(503, "storage unavailable");
      return original?.(...args);
    });
    await expect(uploadMultipartBundle(await baseParams([file]))).resolves.toBeTruthy();
    expect(calls).toBe(2);

    installFakeServer();
    api.uploadSessionPart.mockClear();
    api.uploadSessionPart.mockImplementation(async () => {
      throw new ApiError(400, "part rejected");
    });
    await expect(uploadMultipartBundle(await baseParams([file]))).rejects.toMatchObject({
      status: 400,
    });
    expect(api.uploadSessionPart).toHaveBeenCalledTimes(1);
  });

  it("reports a failed part instead of completing without it", async () => {
    installFakeServer();
    const original = api.uploadSessionPart.getMockImplementation();
    api.uploadSessionPart.mockImplementation(async (...args) => {
      if (args[2] === 1) throw new ApiError(409, "upload session has expired");
      return original?.(...args);
    });

    // Part 1 fails while part 2 is still being encrypted, with nothing
    // awaiting the queue at that moment.
    await expect(
      uploadMultipartBundle(await baseParams([patternedFile(13 * MIB)])),
    ).rejects.toMatchObject({ status: 409 });
    expect(api.completeUploadSession).not.toHaveBeenCalled();
    expect(api.abortUploadSession).toHaveBeenCalledWith("session-1", "token-1");
    // Encryption stops at the failure instead of uploading the rest.
    expect(api.uploadSessionPart).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("aborts the parts still in flight when another part fails", async () => {
    installFakeServer();
    let inFlightSignal: AbortSignal | undefined;
    api.uploadSessionPart.mockImplementation(
      (_session, _token, partNumber: number, _offset, _bytes, _sha256, signal: AbortSignal) => {
        if (partNumber === 1) {
          // Part 1 hangs until the queue aborts it.
          inFlightSignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
        return Promise.reject(new ApiError(400, "part rejected"));
      },
    );

    await expect(
      uploadMultipartBundle(await baseParams([patternedFile(13 * MIB)])),
    ).rejects.toMatchObject({ status: 400 });
    expect(inFlightSignal?.aborted).toBe(true);
    expect(api.completeUploadSession).not.toHaveBeenCalled();
  }, 30_000);

  it("retries completing the upload after a transient failure", async () => {
    installFakeServer();
    api.completeUploadSession.mockRejectedValueOnce(new ApiError(503, "try later", undefined, "4"));

    await expect(
      uploadMultipartBundle(await baseParams([patternedFile(64)])),
    ).resolves.toBeTruthy();
    expect(api.completeUploadSession).toHaveBeenCalledTimes(2);
    expect(api.retryDelayMs).toHaveBeenCalledWith(1, "4");
    expect(api.abortUploadSession).not.toHaveBeenCalled();
  });

  it("waits as long as the server asks before retrying a rate-limited part", async () => {
    installFakeServer();
    api.uploadSessionPart.mockImplementationOnce(async () => {
      throw new ApiError(429, "rate limit exceeded", undefined, "60");
    });

    await expect(
      uploadMultipartBundle(await baseParams([patternedFile(64)])),
    ).resolves.toBeTruthy();
    expect(api.retryDelayMs).toHaveBeenCalledWith(1, "60");
  });

  it("stops waiting to retry a part once another part has failed", async () => {
    installFakeServer();
    // A retry wait far longer than the test timeout: only an abort ends it.
    api.retryDelayMs.mockReturnValue(10 * 60_000);
    api.uploadSessionPart.mockImplementation(async (_session, _token, partNumber: number) => {
      throw partNumber === 1
        ? new ApiError(503, "storage unavailable")
        : new ApiError(400, "part rejected");
    });

    await expect(
      uploadMultipartBundle(await baseParams([patternedFile(13 * MIB)])),
    ).rejects.toMatchObject({ status: 400 });
  }, 10_000);

  it("aborts the parts still in flight when encryption fails", async () => {
    installFakeServer();
    const file = patternedFile(13 * MIB);
    // The file changes on disk after the first part was queued.
    const slice = file.slice.bind(file);
    file.slice = (start?: number, end?: number) =>
      (start ?? 0) >= 8 * MIB ? new Blob([]) : slice(start, end);
    let inFlightSignal: AbortSignal | undefined;
    api.uploadSessionPart.mockImplementation(
      (_session, _token, _partNumber, _offset, _bytes, _sha256, signal: AbortSignal) => {
        inFlightSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
    );

    await expect(uploadMultipartBundle(await baseParams([file]))).rejects.toThrow(
      "bundle file changed during encryption",
    );
    expect(inFlightSignal?.aborted).toBe(true);
  }, 30_000);

  it("aborts the server session on any failure", async () => {
    installFakeServer();
    api.completeUploadSession.mockRejectedValueOnce(
      new ApiError(409, "upload session is not pending"),
    );

    await expect(
      uploadMultipartBundle(await baseParams([patternedFile(64)])),
    ).rejects.toMatchObject({ status: 409 });
    expect(api.abortUploadSession).toHaveBeenCalledWith("session-1", "token-1");

    // A second attempt is a completely new session.
    await uploadMultipartBundle(await baseParams([patternedFile(64)]));
    expect(api.startUploadSession).toHaveBeenCalledTimes(2);
  });

  it("aborts the server session and reports cancellation when cancelled", async () => {
    installFakeServer();
    const controller = new AbortController();
    const original = api.uploadSessionPart.getMockImplementation();
    api.uploadSessionPart.mockImplementation(async (...args) => {
      controller.abort();
      return original?.(...args);
    });

    await expect(
      uploadMultipartBundle({
        ...(await baseParams([patternedFile(64)])),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(UploadCancelledError);
    expect(api.abortUploadSession).toHaveBeenCalledWith("session-1", "token-1");
    expect(api.completeUploadSession).not.toHaveBeenCalled();
  });

  it("never repeats a nonce for the same content under the same key", async () => {
    const server = installFakeServer();
    const file = patternedFile(64);
    const keys = await baseParams([file]);

    await uploadMultipartBundle(keys);
    const first = assembledBlob(server);
    await uploadMultipartBundle(keys);
    const second = assembledBlob(server);

    expect(first.length).toBe(second.length);
    expect(sameBytes(first, second)).toBe(false);
    for (const blob of [first, second]) {
      const bundle = await openAssembled(blob, keys.bundleKeySet);
      expect(bundle.files[0].size).toBe(64);
    }
  });
});
