import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TextResult from "../retrieve/TextResult";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const download = vi.hoisted(() => ({ saveBlob: vi.fn() }));
vi.mock("../../lib/download", () => download);

/** Whether leaving the page now would ask first. */
function leavingAsks(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function renderText(burnAfterRead: boolean) {
  render(
    <TextResult
      text="the launch code is 0000"
      burnAfterRead={burnAfterRead}
      canDelete={false}
      deleting={false}
      onDelete={vi.fn()}
    />,
  );
}

describe("TextResult", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("asks page translators to leave the secret alone", () => {
    renderText(false);
    expect(
      screen.getByText("the launch code is 0000").closest("pre")?.getAttribute("translate"),
    ).toBe("no");
  });

  it("says a one-time text is the only copy and asks before leaving until it was copied", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
    renderText(true);

    expect(screen.getByText(/When you leave this page, it's gone for good/)).toBeTruthy();
    expect(leavingAsks()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Copy secret" }));

    await waitFor(() => expect(leavingAsks()).toBe(false));
  });

  it("counts copying by hand", () => {
    renderText(true);

    fireEvent(document, new Event("copy"));

    expect(leavingAsks()).toBe(false);
  });

  it("lets a reusable text go without asking", () => {
    renderText(false);

    expect(screen.queryByText(/When you leave this page, it's gone for good/)).toBeNull();
    expect(leavingAsks()).toBe(false);
  });

  it("offers a text too long to show as a download, and asks before leaving until it was saved", () => {
    const whole = new Blob(["the beginning", "x".repeat(3 * 1024 * 1024)]);
    render(
      <TextResult
        text="the beginning"
        whole={whole}
        burnAfterRead
        canDelete={false}
        deleting={false}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText(/This text is 3\.0 MB, too long to show here/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy secret" })).toBeNull();
    expect(leavingAsks()).toBe(true);
    // What shows is only part of it: copying that doesn't count as keeping it.
    document.dispatchEvent(new Event("copy"));
    expect(leavingAsks()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Download text" }));
    expect(download.saveBlob).toHaveBeenCalledWith(whole, "secret.txt");
    expect(leavingAsks()).toBe(false);
    expect(screen.getByRole("button", { name: "Save again" })).toBeTruthy();
  });
});
