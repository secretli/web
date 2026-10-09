/**
 * What a link to a secret that is gone gets told. The server keeps nothing
 * about a secret once it is gone, so one that was opened, deleted or expired
 * answers like one that never existed, and nobody can say which it was. The
 * owner is the sender, so there is nobody to ask for a new link.
 */
export const GONE_TITLE = "This secret is gone";

export function goneMessage(owner: boolean): string {
  const why = "It may have expired, been opened or been deleted. Nothing is left on the server";
  return owner ? `${why}.` : `${why}, so ask the sender for a new link if you still need it.`;
}
