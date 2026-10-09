import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { ApiError } from "../../lib/api";
import SharePage from "../SharePage";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const api = vi.hoisted(() => ({ deleteSecret: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return { ...original, ...api };
});

// The upload itself is tested elsewhere; here it just succeeds.
vi.mock("../../lib/multipartBundleUpload", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/multipartBundleUpload")>();
  return {
    ...original,
    uploadMultipartBundle: vi.fn(async (params: { baseKeySet: { getEncoded(): unknown } }) => {
      const encoded = params.baseKeySet.getEncoded() as { deletionToken: string };
      return {
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        encoded,
        deletionToken: encoded.deletionToken,
      };
    }),
  };
});

describe("SharePage", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/share");
  });

  it("starts with the text shared into the app, and clears the address", () => {
    window.history.replaceState(null, "", "/share?text=hunter2");

    render(<SharePage />);

    expect((screen.getByLabelText("Secret") as HTMLTextAreaElement).value).toBe("hunter2");
    expect(window.location.search).toBe("");
    expect(
      (screen.getByRole("button", { name: /Create link/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("starts empty otherwise", () => {
    render(<SharePage />);

    expect((screen.getByLabelText("Secret") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "typed" } });
    expect((screen.getByLabelText("Secret") as HTMLTextAreaElement).value).toBe("typed");
  });

  it("says the secret is gone when it is deleted after it already went", async () => {
    api.deleteSecret.mockRejectedValue(new ApiError(404, "secret not found"));
    render(<SharePage />);

    fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /Create link/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Owner link/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete it now" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByRole("heading", { name: "This secret is gone" })).toBeTruthy();
    expect(
      screen.getByText(
        "It may have expired, been opened or been deleted. Nothing is left on the server.",
      ),
    ).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
