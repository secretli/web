import { render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { useLeaveWarning, useLeaveWarningActive } from "../useLeaveWarning";

function Guard({ active }: { active: boolean }) {
  useLeaveWarning(active);
  return null;
}

function Links() {
  return <p>{useLeaveWarningActive() ? "full page loads" : "client-side"}</p>;
}

/** Runs in the commit that puts the page on screen, before any passive effect does. */
function OnCommit({ run }: { run: () => void }) {
  useLayoutEffect(run);
  return null;
}

/** Whether leaving the page now would ask first. */
function leavingAsks(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("useLeaveWarning", () => {
  it("asks before leaving only while active", () => {
    const { rerender, unmount } = render(<Guard active={false} />);
    expect(leavingAsks()).toBe(false);

    rerender(<Guard active />);
    expect(leavingAsks()).toBe(true);

    unmount();
    expect(leavingAsks()).toBe(false);
  });

  // While a warning is active the page's links reload it. One that outlives
  // the commit showing a finished upload leaves them doing so for a moment,
  // and a click on one then never reaches the router.
  it("starts and stops asking in the commit that calls for it, not after", () => {
    let askedAtCommit: boolean | undefined;
    const noteIfLeavingAsks = () => {
      askedAtCommit = leavingAsks();
    };
    const page = (active: boolean) => (
      <>
        <Guard active={active} />
        <OnCommit run={noteIfLeavingAsks} />
      </>
    );

    const { rerender } = render(page(true));
    expect(askedAtCommit).toBe(true);

    rerender(page(false));
    expect(askedAtCommit).toBe(false);
  });

  it("keeps asking while any of several warnings is active", () => {
    const first = render(<Guard active />);
    const second = render(<Guard active />);

    first.unmount();
    expect(leavingAsks()).toBe(true);

    second.unmount();
    expect(leavingAsks()).toBe(false);
  });

  it("switches in-app links to full page loads meanwhile", () => {
    const { rerender } = render(
      <>
        <Guard active={false} />
        <Links />
      </>,
    );
    expect(screen.getByText("client-side")).toBeTruthy();

    rerender(
      <>
        <Guard active />
        <Links />
      </>,
    );
    expect(screen.getByText("full page loads")).toBeTruthy();
  });
});
