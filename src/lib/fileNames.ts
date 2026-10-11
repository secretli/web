/**
 * A received file's name was chosen by the sender. Control and format
 * characters in it would change how it reads: a direction override turns
 * "invoice", U+202E, "txt.exe" into what looks like invoiceexe.txt, and
 * zero-width characters hide. The joiners U+200C and U+200D stay, since
 * emoji sequences and Persian and Indic words need them.
 */
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const JOINERS = new Set([0x200c, 0x200d]);

function replaceUnshown(name: string, by: string): string {
  return name.replace(UNSHOWN, (ch) => (JOINERS.has(ch.codePointAt(0) ?? 0) ? ch : by));
}

/** A received file's name as the page shows it. */
export function displayName(name: string): string {
  return replaceUnshown(name, "?");
}

/** A received file's name as it is saved; the browser makes it a valid file name. */
export function downloadName(name: string): string {
  return replaceUnshown(name, "_");
}
