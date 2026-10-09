import { createStreamBundle, KeySet, type SecretMeta } from "@secretli/format";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { ApiError, type RetrievalSessionResponse } from "../../lib/api";
import RetrievePage from "../RetrievePage";

const api = vi.hoisted(() => ({
  getSecretMetadata: vi.fn(),
  startRetrievalSession: vi.fn(),
  retrieveSecretRange: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return { ...original, ...api };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// jsdom can't hand a file to a download; what the page saves is recorded instead.
const download = vi.hoisted(() => ({
  saveBlob: vi.fn(),
  saveFilesSequentially: vi.fn(async (_files: Array<{ name: string; blob: Blob }>) => {}),
}));

vi.mock("../../lib/download", () => download);

const SECRET_TEXT = "the launch code is 0000";

// The page derives the password key with scrypt on the main thread, which is
// slow on CI runners; waits that follow a password submit get more time.
const AFTER_PASSWORD = { timeout: 15_000 };

interface ShareOptions {
  burnAfterRead?: boolean;
  password?: string;
  ownerLink?: boolean;
  /** Whether the metadata says someone other than the owner has opened the secret. */
  opened?: boolean;
  /** What the metadata says the secret is, for a kind this version doesn't know. */
  type?: string;
  /** When the retrieval session ends; in 15 minutes unless set. */
  sessionExpiresAt?: string;
}

/** Publishes a text share; see publishShare. */
function publishTextShare(options: ShareOptions = {}) {
  return publishShare([new File([SECRET_TEXT], "secret.txt", { type: "text/plain" })], {
    type: "text",
    ...options,
  });
}

/** Publishes files, each holding the text it is named after, as one share; see publishShare. */
function publishFiles(contents: Record<string, string>, options: ShareOptions = {}) {
  const files = Object.entries(contents).map(
    ([name, text]) => new File([text], name, { type: "text/plain" }),
  );
  return publishShare(files, { type: "bundle", ...options });
}

/**
 * Publishes a share on a fake server: metadata and blob are really
 * encrypted, so the page decrypts them exactly as it would in production.
 */
async function publishShare(files: File[], options: ShareOptions) {
  const baseKeySet = await KeySet.generateRandom();
  const shareSecret = baseKeySet.getEncoded().shareSecret;
  const blobKeySet = options.password
    ? await KeySet.fromShareSecret(shareSecret, options.password)
    : baseKeySet;
  const { blob } = await createStreamBundle(files, blobKeySet);
  const bytes = new Uint8Array(await blob.arrayBuffer());

  api.getSecretMetadata.mockResolvedValue({
    encrypted_meta: await baseKeySet.encryptMeta({
      type: options.type as SecretMeta["type"],
      password_protected: options.password !== undefined,
    }),
    blob_size: bytes.length,
    burn_after_read: options.burnAfterRead ?? false,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
    opened: options.opened ?? false,
  });
  api.startRetrievalSession.mockImplementation(
    async (_publicID: string, blobToken: string): Promise<RetrievalSessionResponse> => {
      if (blobToken !== blobKeySet.getEncoded().blobToken) {
        throw new ApiError(403, "invalid blob token");
      }
      return {
        session_token: "session-token",
        blob_size: bytes.length,
        expires_at: options.sessionExpiresAt ?? new Date(Date.now() + 900_000).toISOString(),
        burn_after_read: options.burnAfterRead ?? false,
      };
    },
  );
  api.retrieveSecretRange.mockImplementation(async (_id, _token, start: number, end: number) =>
    bytes.slice(start, end + 1),
  );

  // An owner link carries the 43-character deletion token after "!".
  window.location.hash = options.ownerLink
    ? `#${shareSecret}!${"D".repeat(43)}`
    : `#${shareSecret}`;
}

/** Makes the next range read fail the way a range read does after its retries. */
function failNextRangeRead(error: Error) {
  api.retrieveSecretRange.mockImplementationOnce(async () => {
    throw error;
  });
}

async function submitPassword(password: string) {
  const input = await screen.findByLabelText("Password");
  fireEvent.change(input, { target: { value: password } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
}

describe("RetrievePage", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    vi.mocked(toast.error).mockClear();
    download.saveFilesSequentially.mockClear();
  });

  it("reveals a text secret", async () => {
    await publishTextShare();
    render(<RetrievePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal secret" }));

    expect(await screen.findByText(SECRET_TEXT)).toBeTruthy();
    // A small bundle is fetched whole, once.
    expect(api.retrieveSecretRange).toHaveBeenCalledTimes(1);
  });

  it("retries a burn-after-read share with the session it already started", async () => {
    await publishTextShare({ burnAfterRead: true });
    failNextRangeRead(new ApiError(503, "storage unavailable"));
    render(<RetrievePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal secret" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    // The page stays put, and trying again reuses the session that burned the
    // share instead of starting one the server would refuse.
    fireEvent.click(await screen.findByRole("button", { name: "Reveal secret" }));
    expect(await screen.findByText(SECRET_TEXT)).toBeTruthy();
    expect(api.startRetrievalSession).toHaveBeenCalledTimes(1);
  });

  it("starts a new session once the kept one has expired", async () => {
    await publishTextShare();
    failNextRangeRead(new ApiError(403, "invalid retrieval session"));
    render(<RetrievePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal secret" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "The download window has expired. Please try again.",
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Reveal secret" }));
    expect(await screen.findByText(SECRET_TEXT)).toBeTruthy();
    expect(api.startRetrievalSession).toHaveBeenCalledTimes(2);
  });

  it("reports a wrong password only when the server rejects the blob token", async () => {
    await publishTextShare({ password: "correct horse" });
    render(<RetrievePage />);

    await submitPassword("wrong horse");
    expect(await screen.findByText("Wrong password. Try again.", {}, AFTER_PASSWORD)).toBeTruthy();
    expect(api.retrieveSecretRange).not.toHaveBeenCalled();

    // Selected, so typing again replaces the mistyped password.
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "wrong horse".length]);
  }, 30_000);

  it("does not blame the password when reading fails after it was accepted", async () => {
    await publishTextShare({ burnAfterRead: true, password: "correct horse" });
    failNextRangeRead(new ApiError(0, "Network error — please check your connection"));
    render(<RetrievePage />);

    await submitPassword("correct horse");
    await waitFor(
      () =>
        expect(toast.error).toHaveBeenCalledWith("Network error — please check your connection"),
      AFTER_PASSWORD,
    );
    expect(screen.queryByText("Wrong password. Try again.")).toBeNull();

    await submitPassword("correct horse");
    expect(await screen.findByText(SECRET_TEXT, {}, AFTER_PASSWORD)).toBeTruthy();
    expect(api.startRetrievalSession).toHaveBeenCalledTimes(1);
  }, 45_000);

  it("keeps the accepted session when a mistyped password follows it", async () => {
    await publishTextShare({ burnAfterRead: true, password: "correct horse" });
    failNextRangeRead(new ApiError(0, "Network error — please check your connection"));
    render(<RetrievePage />);

    await submitPassword("correct horse");
    await waitFor(() => expect(toast.error).toHaveBeenCalled(), AFTER_PASSWORD);

    // The burned share would answer a new session with 404; the typo must
    // neither reach the server nor throw the kept session away.
    await submitPassword("correct hose");
    expect(await screen.findByText("Wrong password. Try again.", {}, AFTER_PASSWORD)).toBeTruthy();
    expect(api.startRetrievalSession).toHaveBeenCalledTimes(1);

    await submitPassword("correct horse");
    expect(await screen.findByText(SECRET_TEXT, {}, AFTER_PASSWORD)).toBeTruthy();
    expect(api.startRetrievalSession).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("warns owners that revealing their one-time share takes it from the recipient", async () => {
    await publishTextShare({ burnAfterRead: true, ownerLink: true });
    render(<RetrievePage />);

    expect(await screen.findByText(/This is your owner link/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete it now" })).toBeTruthy();
  });

  it("gives recipients the usual one-time warning", async () => {
    await publishTextShare({ burnAfterRead: true });
    render(<RetrievePage />);

    expect(await screen.findByText(/It opens once, then it's gone/)).toBeTruthy();
    expect(screen.queryByText(/This is your owner link/)).toBeNull();
  });

  it("says a link is damaged instead of asking the server about it", async () => {
    // Cut off while copying: one character short.
    window.location.hash = `#${"A".repeat(42)}`;
    render(<RetrievePage />);

    expect(
      await screen.findByText(
        "This link is incomplete or damaged. Check that you copied all of it.",
      ),
    ).toBeTruthy();
    expect(api.getSecretMetadata).not.toHaveBeenCalled();
  });

  // The server keeps nothing about a secret once it is gone: one that was
  // opened, deleted or expired answers 404, as one that never existed does.
  it.each([
    [
      false,
      "It may have expired, been opened or been deleted. Nothing is left on the server, so ask the sender for a new link if you still need it.",
    ],
    [true, "It may have expired, been opened or been deleted. Nothing is left on the server."],
  ])(
    "says a secret is gone, without saying what became of it (owner link: %s)",
    async (ownerLink, lead) => {
      await publishTextShare({ ownerLink });
      api.getSecretMetadata.mockRejectedValue(new ApiError(404, "secret not found"));
      render(<RetrievePage />);

      expect(await screen.findByRole("heading", { name: "This secret is gone" })).toBeTruthy();
      expect(screen.getByText(lead)).toBeTruthy();
    },
  );

  async function reveal() {
    const button = await screen.findByRole("button", { name: "Reveal secret" });
    // Awaited in act: the page may finish within a few ticks of the click.
    await act(async () => {
      fireEvent.click(button);
    });
  }

  /** Opens a link that ends on an error page, as an owner's link or a recipient's. */
  type Visit = (ownerLink: boolean) => Promise<void>;

  const errorPages: [page: string, heading: string, visit: Visit][] = [
    [
      "a link the server has nothing for",
      "This secret is gone",
      async (ownerLink) => {
        await publishTextShare({ ownerLink });
        api.getSecretMetadata.mockRejectedValue(new ApiError(404, "secret not found"));
        render(<RetrievePage />);
      },
    ],
    [
      "a link cut off while copying",
      "This link is damaged",
      async (ownerLink) => {
        // One character short, in the deletion token of an owner link.
        window.location.hash = ownerLink
          ? `#${"A".repeat(43)}!${"D".repeat(42)}`
          : `#${"A".repeat(42)}`;
        render(<RetrievePage />);
      },
    ],
    [
      "a link the server refuses",
      "This link is damaged",
      async (ownerLink) => {
        await publishTextShare({ ownerLink });
        api.getSecretMetadata.mockRejectedValue(new ApiError(403, "invalid metadata token"));
        render(<RetrievePage />);
      },
    ],
    [
      "a server that fails on opening the link",
      "Something went wrong",
      async (ownerLink) => {
        await publishTextShare({ ownerLink });
        api.getSecretMetadata.mockRejectedValue(new ApiError(500, "internal error"));
        render(<RetrievePage />);
      },
    ],
    [
      "an unexpected failure on opening the link",
      "Something went wrong",
      async (ownerLink) => {
        await publishTextShare({ ownerLink });
        api.getSecretMetadata.mockRejectedValue(new Error("not an answer from the server"));
        render(<RetrievePage />);
      },
    ],
    [
      "a kind of secret this version doesn't know",
      "This link can't be opened here",
      async (ownerLink) => {
        await publishTextShare({ ownerLink, type: "note" });
        render(<RetrievePage />);
        await reveal();
      },
    ],
    [
      "a link the secret doesn't accept",
      "This link can't open the secret",
      async (ownerLink) => {
        await publishTextShare({ ownerLink });
        api.startRetrievalSession.mockRejectedValue(new ApiError(403, "invalid blob token"));
        render(<RetrievePage />);
        await reveal();
      },
    ],
    [
      "a secret that went away before it was opened",
      "This secret is gone",
      async (ownerLink) => {
        await publishTextShare({ ownerLink });
        api.startRetrievalSession.mockRejectedValue(new ApiError(404, "secret not found"));
        render(<RetrievePage />);
        await reveal();
      },
    ],
    [
      "a one-time session that ran out",
      "The download window closed",
      async (ownerLink) => {
        await publishTextShare({ ownerLink, burnAfterRead: true });
        failNextRangeRead(new ApiError(403, "invalid retrieval session"));
        render(<RetrievePage />);
        await reveal();
      },
    ],
    [
      "a server that fails on opening the secret",
      "Something went wrong",
      async (ownerLink) => {
        await publishTextShare({ ownerLink });
        failNextRangeRead(new ApiError(400, "bad request"));
        render(<RetrievePage />);
        await reveal();
      },
    ],
    [
      "an unexpected failure on opening the secret",
      "Something went wrong",
      async (ownerLink) => {
        await publishTextShare({ ownerLink });
        failNextRangeRead(new Error("not an answer from the server"));
        render(<RetrievePage />);
        await reveal();
      },
    ],
  ];

  describe.each(errorPages)("%s", (_page, heading, visit) => {
    it.each([
      [true, "Share another secret", "/"],
      [false, "Share a secret of your own", "/share"],
    ])("leads on as the gone page does (owner link: %s)", async (ownerLink, label, href) => {
      await visit(ownerLink);

      expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
      const back = screen.getByRole("link", { name: `← ${label}` });
      expect(back.getAttribute("href")).toBe(href);
    });
  });

  it("ends on an error page when a burn-after-read session expires", async () => {
    await publishTextShare({ burnAfterRead: true });
    failNextRangeRead(new ApiError(403, "invalid retrieval session"));
    render(<RetrievePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal secret" }));

    // Trying again could only get a 404, so do not invite it.
    expect(await screen.findByRole("heading", { name: "The download window closed" })).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says the secret is gone when it goes away between showing and opening it", async () => {
    await publishTextShare({ burnAfterRead: true });
    render(<RetrievePage />);
    await screen.findByRole("button", { name: "Reveal secret" });
    api.startRetrievalSession.mockRejectedValue(new ApiError(404, "secret not found"));

    fireEvent.click(screen.getByRole("button", { name: "Reveal secret" }));

    expect(await screen.findByRole("heading", { name: "This secret is gone" })).toBeTruthy();
    // The server could say no more than that, so it isn't asked again.
    expect(api.getSecretMetadata).toHaveBeenCalledTimes(1);
  });

  // The server says whether a recipient opened a reusable secret, never when.
  it.each([
    [true, /This is your owner link\. It has been opened\. You can open the secret/],
    [false, /This is your owner link\. Nobody has opened it yet\. You can open the secret/],
  ])(
    "tells the owner of a reusable secret whether it was opened (opened: %s)",
    async (opened, lead) => {
      await publishTextShare({ ownerLink: true, opened });
      render(<RetrievePage />);

      expect(await screen.findByText(lead)).toBeTruthy();
    },
  );

  it("sends the deletion token along when the owner opens their own secret", async () => {
    await publishTextShare({ ownerLink: true });
    render(<RetrievePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal secret" }));

    expect(await screen.findByText(SECRET_TEXT)).toBeTruthy();
    expect(api.startRetrievalSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "D".repeat(43),
    );
  });

  describe("files", () => {
    const FILES = { "alpha.txt": "first file", "bravo.txt": "second file", "charlie.txt": "third" };

    /** Whether leaving the page now would ask first. */
    function leavingAsks(): boolean {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }

    async function showFiles() {
      fireEvent.click(await screen.findByRole("button", { name: "Show the files" }));
      await screen.findByRole("heading", { name: /^Here( are your files|'s your file)$/ });
    }

    /** The names and contents of what the page handed to the browser in its last save. */
    async function lastSaved(): Promise<[string, string][]> {
      const [files] = download.saveFilesSequentially.mock.calls.at(-1) ?? [[]];
      return Promise.all(files.map(async (file) => [file.name, await file.blob.text()]));
    }

    async function clickAndWaitForSave(name: string) {
      const saves = download.saveFilesSequentially.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(download.saveFilesSequentially.mock.calls.length).toBe(saves + 1));
    }

    it("lists the files by name", async () => {
      await publishFiles(FILES);
      render(<RetrievePage />);
      await showFiles();

      expect(screen.getByText("3 files · 26 B")).toBeTruthy();
      for (const [index, name] of Object.keys(FILES).entries()) {
        expect(screen.getByTestId(`bundle-file-${index}`).textContent).toContain(name);
      }
    });

    it("downloads a single file out of several", async () => {
      await publishFiles(FILES);
      render(<RetrievePage />);
      await showFiles();

      await clickAndWaitForSave("Download bravo.txt");

      expect(await lastSaved()).toEqual([["bravo.txt", "second file"]]);
      // The others stay listed, and can still be downloaded.
      expect(await screen.findByRole("button", { name: "Save bravo.txt again" })).toBeTruthy();
      for (const name of ["Download alpha.txt", "Download charlie.txt"]) {
        expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(false);
      }
      expect(screen.getByRole("button", { name: "Download the rest" })).toBeTruthy();
    });

    it("fetches only the chunks of the file it downloads", async () => {
      const MIB = 1024 * 1024;
      const big = (fill: string) => fill.repeat(MIB);
      await publishFiles({ "a.bin": big("a"), "b.bin": big("b"), "c.bin": big("c") });
      render(<RetrievePage />);
      await showFiles();
      const opened = api.retrieveSecretRange.mock.calls.length;

      await clickAndWaitForSave("Download c.bin");

      expect(await lastSaved()).toEqual([["c.bin", big("c")]]);
      // c.bin begins after the 2 MiB of the other two: nothing before it is read.
      const reads = api.retrieveSecretRange.mock.calls.slice(opened);
      expect(reads.length).toBeGreaterThan(0);
      for (const [, , start] of reads) expect(start).toBeGreaterThan(2 * MIB);
    });

    it("downloads all files, then saves them again from memory", async () => {
      await publishFiles(FILES);
      render(<RetrievePage />);
      await showFiles();

      await clickAndWaitForSave("Download files");
      expect(await lastSaved()).toEqual([
        ["alpha.txt", "first file"],
        ["bravo.txt", "second file"],
        ["charlie.txt", "third"],
      ]);
      const reads = api.retrieveSecretRange.mock.calls.length;

      await clickAndWaitForSave("Save again");
      expect((await lastSaved()).map(([name]) => name)).toEqual([
        "alpha.txt",
        "bravo.txt",
        "charlie.txt",
      ]);
      await clickAndWaitForSave("Save alpha.txt again");
      expect(await lastSaved()).toEqual([["alpha.txt", "first file"]]);
      expect(api.retrieveSecretRange).toHaveBeenCalledTimes(reads);
    });

    it("downloads the rest without saving a file twice", async () => {
      await publishFiles(FILES);
      render(<RetrievePage />);
      await showFiles();

      await clickAndWaitForSave("Download alpha.txt");
      await clickAndWaitForSave("Download the rest");

      expect(await lastSaved()).toEqual([
        ["bravo.txt", "second file"],
        ["charlie.txt", "third"],
      ]);
      expect(await screen.findByRole("button", { name: "Save again" })).toBeTruthy();
      expect(
        screen.getByText(
          "Saved. If your browser blocked one of them, use the button next to that file.",
        ),
      ).toBeTruthy();
    });

    it("gives a bundle of one file a single download button", async () => {
      await publishFiles({ "only.txt": "the only file" });
      render(<RetrievePage />);
      await showFiles();

      expect(screen.queryByRole("button", { name: "Download only.txt" })).toBeNull();
      await clickAndWaitForSave("Download file");

      expect(await lastSaved()).toEqual([["only.txt", "the only file"]]);
      expect(await screen.findByRole("button", { name: "Save again" })).toBeTruthy();
    });

    it("asks before leaving a one-time share until every file is saved", async () => {
      await publishFiles(FILES, { burnAfterRead: true });
      render(<RetrievePage />);
      await showFiles();

      expect(
        screen.getByText(
          /^One-time: files you don't save in the next \d+:\d\d are gone for good\.$/,
        ),
      ).toBeTruthy();
      expect(leavingAsks()).toBe(true);

      await clickAndWaitForSave("Download charlie.txt");
      expect(leavingAsks()).toBe(true);
      await clickAndWaitForSave("Download alpha.txt");
      expect(leavingAsks()).toBe(true);

      await clickAndWaitForSave("Download bravo.txt");
      await waitFor(() => expect(leavingAsks()).toBe(false));
      expect(screen.getByRole("button", { name: "Save again" })).toBeTruthy();
    });

    it("asks before leaving a one-time share until Download files has saved them all", async () => {
      await publishFiles(FILES, { burnAfterRead: true });
      render(<RetrievePage />);
      await showFiles();
      expect(leavingAsks()).toBe(true);

      await clickAndWaitForSave("Download files");

      await waitFor(() => expect(leavingAsks()).toBe(false));
    });

    it("doesn't ask before leaving a reusable share", async () => {
      await publishFiles(FILES);
      render(<RetrievePage />);
      await showFiles();

      expect(screen.getByText(/^\d+:\d\d left to download\.$/)).toBeTruthy();
      expect(leavingAsks()).toBe(false);
    });

    it("stops asking once the window closed with nothing left to save", async () => {
      await publishFiles(FILES, {
        burnAfterRead: true,
        sessionExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      render(<RetrievePage />);
      await showFiles();

      expect(
        screen.getByText("The download window closed. This one-time secret can't be opened again."),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Download files" }).hasAttribute("disabled")).toBe(
        true,
      );
      expect(
        screen.getByRole("button", { name: "Download alpha.txt" }).hasAttribute("disabled"),
      ).toBe(true);
      expect(leavingAsks()).toBe(false);
    });
  });
});
