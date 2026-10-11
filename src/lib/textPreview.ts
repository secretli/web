/**
 * How much of a text secret the page shows. A text is as long as its sender
 * made it, up to the upload limit; as one string in one element, a text of
 * hundreds of megabytes freezes the tab, and a one-time secret would be lost
 * with it. A longer text shows its beginning and is downloaded whole.
 */
export const TEXT_SHOWN_BYTES = 1024 * 1024;

/**
 * The text to show for a decrypted text secret: all of it, or its first
 * TEXT_SHOWN_BYTES, and whether that is all of it.
 */
export async function textToShow(blob: Blob): Promise<{ text: string; complete: boolean }> {
  if (blob.size <= TEXT_SHOWN_BYTES) {
    return { text: await blob.text(), complete: true };
  }
  const head = new Uint8Array(await blob.slice(0, TEXT_SHOWN_BYTES).arrayBuffer());
  // stream: a character the cut splits is left out, rather than shown broken.
  return { text: new TextDecoder().decode(head, { stream: true }), complete: false };
}
