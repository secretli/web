import {
  createEncryptedBundle,
  createStreamBundle,
  KeySet,
  type SecretMeta,
} from "@secretli/format";
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
  /** The bundle version to write; 3 unless set. */
  version?: 2 | 3;
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
  const { blob } =
    options.version === 2
      ? await createEncryptedBundle(files, blobKeySet)
      : await createStreamBundle(files, blobKeySet);
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
  });

  it.each([3, 2] as const)("reveals a text secret (bundle version %i)", async (version) => {
    await publishTextShare({ version });
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

  it("answers a link the server has nothing for as it would one that expired", async () => {
    await publishTextShare();
    api.getSecretMetadata.mockImplementation(async () => {
      throw new ApiError(404, "secret not found");
    });
    render(<RetrievePage />);

    expect(await screen.findByRole("heading", { name: "This secret is gone" })).toBeTruthy();
    expect(screen.getByText(/It may have expired, been opened or been deleted\./)).toBeTruthy();
    expect(screen.getByText(/ask the sender for a new link/)).toBeTruthy();
  });

  it("does not send an owner to the sender when the server has nothing for their link", async () => {
    await publishTextShare({ ownerLink: true });
    api.getSecretMetadata.mockImplementation(async () => {
      throw new ApiError(404, "secret not found");
    });
    render(<RetrievePage />);

    expect(await screen.findByRole("heading", { name: "This secret is gone" })).toBeTruthy();
    expect(screen.getByText(/It may have expired, been opened or been deleted\./)).toBeTruthy();
    expect(screen.queryByText(/ask the sender/)).toBeNull();
  });

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

  /** The 410 the metadata endpoint answers with until the secret would have expired. */
  function gone(details: Record<string, unknown>) {
    return new ApiError(410, "secret is gone", undefined, undefined, details);
  }

  async function openLink(ownerLink: boolean) {
    const shareSecret = (await KeySet.generateRandom()).getEncoded().shareSecret;
    window.location.hash = ownerLink ? `#${shareSecret}!${"D".repeat(43)}` : `#${shareSecret}`;
  }

  it("tells the owner when their one-time secret was opened", async () => {
    api.getSecretMetadata.mockRejectedValue(gone({ outcome: "opened", burn_after_read: true }));
    await openLink(true);
    render(<RetrievePage />);

    expect(await screen.findByRole("heading", { name: "Your secret was opened" })).toBeTruthy();
    expect(
      screen.getByText("It was a one-time secret, so nothing is left on the server."),
    ).toBeTruthy();
  });

  it("warns a recipient when someone already opened the one-time secret", async () => {
    api.getSecretMetadata.mockRejectedValue(gone({ outcome: "opened", burn_after_read: true }));
    await openLink(false);
    render(<RetrievePage />);

    expect(
      await screen.findByRole("heading", { name: "This secret was already opened" }),
    ).toBeTruthy();
    expect(screen.getByText(/tell the sender/)).toBeTruthy();
  });

  it("tells the owner that they deleted the secret", async () => {
    api.getSecretMetadata.mockRejectedValue(gone({ outcome: "deleted", burn_after_read: true }));
    await openLink(true);
    render(<RetrievePage />);

    expect(await screen.findByRole("heading", { name: "Secret deleted" })).toBeTruthy();
    expect(
      screen.getByText("You deleted it. The link doesn't open anything any more."),
    ).toBeTruthy();
  });

  it("tells a recipient that the sender deleted the secret", async () => {
    api.getSecretMetadata.mockRejectedValue(gone({ outcome: "deleted", burn_after_read: false }));
    await openLink(false);
    render(<RetrievePage />);

    expect(await screen.findByRole("heading", { name: "This secret was deleted" })).toBeTruthy();
    expect(
      screen.getByText(
        "The sender deleted it. Ask the sender for a new link if you still need it.",
      ),
    ).toBeTruthy();
  });

  it("finds out what happened when the secret goes away between showing and opening it", async () => {
    await publishTextShare({ burnAfterRead: true });
    render(<RetrievePage />);
    await screen.findByRole("button", { name: "Reveal secret" });
    api.startRetrievalSession.mockRejectedValue(new ApiError(404, "secret not found"));
    api.getSecretMetadata.mockRejectedValueOnce(gone({ outcome: "opened", burn_after_read: true }));

    fireEvent.click(screen.getByRole("button", { name: "Reveal secret" }));

    expect(
      await screen.findByRole("heading", { name: "This secret was already opened" }),
    ).toBeTruthy();
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

    async function showFiles() {
      fireEvent.click(await screen.findByRole("button", { name: "Show the files" }));
      await screen.findByRole("heading", { name: /^Here( are your files|'s your file)$/ });
    }

    it.each([3, 2] as const)("lists the files by name (bundle version %i)", async (version) => {
      await publishFiles(FILES, { version });
      render(<RetrievePage />);
      await showFiles();

      expect(screen.getByText("3 files · 26 B")).toBeTruthy();
      for (const [index, name] of Object.keys(FILES).entries()) {
        expect(screen.getByTestId(`bundle-file-${index}`).textContent).toContain(name);
      }
    });
  });
});
