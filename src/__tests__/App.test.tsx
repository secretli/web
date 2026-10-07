import { fireEvent, render, screen } from "@testing-library/react";
import App from "../App";
import { uploadMultipartBundle } from "../lib/multipartBundleUpload";

vi.mock("sonner", () => ({
  Toaster: () => null,
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("../lib/multipartBundleUpload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/multipartBundleUpload")>()),
  uploadMultipartBundle: vi.fn(),
}));

const secretBox = () => screen.getByLabelText("Secret") as HTMLTextAreaElement;
const logo = () => screen.getByRole("link", { name: "secretli" });

/** Types a secret and changes every setting away from its default. */
function fillInTheComposer() {
  fireEvent.change(secretBox(), { target: { value: "hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: "Expires in 1 day" }));
  fireEvent.click(screen.getByRole("button", { name: "4 hours" }));
  fireEvent.click(screen.getByRole("button", { name: "Opens once" }));
  fireEvent.click(screen.getByRole("button", { name: /Until it expires/ }));
  fireEvent.click(screen.getByRole("button", { name: "Password" }));
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
}

function expectAnEmptyComposer() {
  expect(screen.getByRole("heading", { name: "Share a secret" })).toBeTruthy();
  expect(secretBox().value).toBe("");
  expect(screen.getByRole("button", { name: "Expires in 1 day" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Opens once" })).toBeTruthy();
  expect(screen.queryByLabelText("Password")).toBeNull();
}

describe("starting over", () => {
  beforeEach(() => {
    // The theme switch in the header asks for the system's colour scheme.
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it.each(["/", "/share"])("the logo clears the composer on %s", (path) => {
    window.history.replaceState(null, "", path);
    render(<App />);
    fillInTheComposer();

    fireEvent.click(logo());

    expect(window.location.pathname).toBe("/");
    expectAnEmptyComposer();
  });

  it("the logo and the Share link lead from a new link back to an empty composer", async () => {
    vi.mocked(uploadMultipartBundle).mockImplementation(async ({ baseKeySet }) => {
      const encoded = baseKeySet.getEncoded();
      return {
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        encoded,
        deletionToken: encoded.deletionToken,
      } as Awaited<ReturnType<typeof uploadMultipartBundle>>;
    });
    render(<App />);

    for (const leave of [logo, () => screen.getByRole("link", { name: "Share" })]) {
      fillInTheComposer();
      fireEvent.click(screen.getByRole("button", { name: /Create link/ }));
      expect(await screen.findByRole("heading", { name: /link is ready/i })).toBeTruthy();

      fireEvent.click(leave());

      expectAnEmptyComposer();
    }
  });
});
