import {
  bundleLimitError,
  isFileListTooLarge,
  MAX_ENCRYPTED_UPLOAD_BYTES,
  TOO_LARGE_MESSAGE,
  TOO_MANY_FILES_MESSAGE,
} from "../uploadLimits";

const MIB = 1024 * 1024;

describe("upload limits", () => {
  it("accepts files that fit once bundled and encrypted", () => {
    expect(bundleLimitError([])).toBeNull();
    expect(bundleLimitError([{ name: "notes.txt", size: 1024 }])).toBeNull();
  });

  it("counts the padding and the chunks' tags against the limit", () => {
    // Near 1 GiB the stream is padded in steps of 16 MiB, so 1,007 MiB of
    // content is the most that fits, though 1,008 MiB is still under 1 GiB.
    expect(bundleLimitError([{ name: "big.bin", size: 1007 * MIB }])).toBeNull();
    expect(bundleLimitError([{ name: "big.bin", size: 1008 * MIB }])).toBe(TOO_LARGE_MESSAGE);
    expect(bundleLimitError([{ name: "big.bin", size: MAX_ENCRYPTED_UPLOAD_BYTES }])).toBe(
      TOO_LARGE_MESSAGE,
    );
  });

  it("finds files whose names overflow the file list", () => {
    const few = Array.from({ length: 3 }, (_, i) => ({ name: `f-${i}.bin`, size: 1 }));
    // 2,000 names of 2 KiB come to more than the list's 4 MiB.
    const many = Array.from({ length: 2000 }, (_, i) => ({
      name: `${i}-${"x".repeat(2048)}.bin`,
      size: 1,
    }));
    expect(bundleLimitError(few)).toBeNull();
    expect(bundleLimitError(many)).toBe(TOO_MANY_FILES_MESSAGE);
  });

  it("knows the error a list that is too large is thrown as", () => {
    expect(isFileListTooLarge(new Error("bundle file list is too large"))).toBe(true);
    expect(isFileListTooLarge(new Error("invalid bundle file size"))).toBe(false);
    expect(isFileListTooLarge("bundle file list is too large")).toBe(false);
  });
});
