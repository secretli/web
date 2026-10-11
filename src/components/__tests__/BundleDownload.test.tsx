import type { BundleEntry } from "@secretli/format";
import { fireEvent, render, screen } from "@testing-library/react";
import BundleDownload, { FILES_SHOWN_AT_ONCE } from "../retrieve/BundleDownload";

function renderFiles(count: number) {
  const files: BundleEntry[] = Array.from({ length: count }, (_, index) => ({
    index,
    name: `file-${index}.txt`,
    type: "text/plain",
    size: 1,
  }));
  render(
    <BundleDownload
      files={files}
      totalSize={count}
      sessionExpiresAt={new Date(Date.now() + 15 * 60_000).toISOString()}
      burnAfterRead={false}
      downloading={null}
      progress={null}
      decryptedFiles={new Map()}
      savedFiles={new Set()}
      canDelete={false}
      deleting={false}
      onDownloadAll={vi.fn()}
      onDownloadFile={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

const rows = () => screen.queryAllByTestId(/^bundle-file-/).length;

describe("BundleDownload", () => {
  it("lists a long bundle in pages, so that the tab doesn't freeze", () => {
    renderFiles(2 * FILES_SHOWN_AT_ONCE + 50);
    expect(rows()).toBe(FILES_SHOWN_AT_ONCE);
    expect(screen.getByText(/and 250 more/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `Show ${FILES_SHOWN_AT_ONCE} more` }));
    expect(rows()).toBe(2 * FILES_SHOWN_AT_ONCE);

    fireEvent.click(screen.getByRole("button", { name: "Show 50 more" }));
    expect(rows()).toBe(2 * FILES_SHOWN_AT_ONCE + 50);
    expect(screen.queryByText(/more\. Downloading the files/)).toBeNull();
    // The title counts them all.
    expect(screen.getByText(`${2 * FILES_SHOWN_AT_ONCE + 50} files · 450 B`)).toBeTruthy();
  });

  it("lists a short bundle whole", () => {
    renderFiles(3);
    expect(rows()).toBe(3);
    expect(screen.queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
  });
});
