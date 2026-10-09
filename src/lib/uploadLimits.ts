import { type BundleFileInput, plannedBundleSize } from "@secretli/format";

export const MAX_ENCRYPTED_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = "1 GiB";

export const TOO_LARGE_MESSAGE = `Together these files exceed the ${MAX_UPLOAD_LABEL} limit.`;
export const TOO_MANY_FILES_MESSAGE =
  "Too many files for one link. Zip them first, or split them up.";

/** What planStream throws when the names don't fit the bundle's file list. */
const FILE_LIST_TOO_LARGE = "bundle file list is too large";

/** Whether this error says the files' names don't fit one bundle's file list. */
export function isFileListTooLarge(err: unknown): boolean {
  return err instanceof Error && err.message === FILE_LIST_TOO_LARGE;
}

/**
 * Why these files can't go into one link, as a message for the sender, or
 * null if they can. The bundle is planned from names and sizes alone, so the
 * exact encrypted size, padding included, is known before anything is read.
 */
export function bundleLimitError(files: readonly BundleFileInput[]): string | null {
  if (files.length === 0) return null;
  let size: number;
  try {
    size = plannedBundleSize(files);
  } catch (err) {
    if (isFileListTooLarge(err)) return TOO_MANY_FILES_MESSAGE;
    throw err;
  }
  return size > MAX_ENCRYPTED_UPLOAD_BYTES ? TOO_LARGE_MESSAGE : null;
}
