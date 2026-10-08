import type { SecretGone } from "../../lib/api";
import PageTitle from "../ui/PageTitle";
import { textButtonClass } from "../ui/styles";

interface ShareGoneProps {
  gone: SecretGone;
  /** Whether the link that was opened is the owner link. */
  owner: boolean;
}

const ASK_AGAIN = "Ask the sender for a new link if you still need it.";

/** The heading and the sentence under it, for the owner or for a recipient. */
export function goneCopy(gone: SecretGone, owner: boolean): { title: string; lead: string } {
  // No time, and no telling the owner opening a one-time secret from a
  // recipient doing so: the server keeps neither.
  switch (gone.outcome) {
    case "opened":
      return owner
        ? {
            title: "Your secret was opened",
            lead: "It was a one-time secret, so nothing is left on the server.",
          }
        : {
            title: "This secret was already opened",
            lead: "Someone opened it, and a one-time secret opens only once. If that wasn't you, tell the sender: the link may have reached someone else.",
          };
    case "deleted":
      return owner
        ? {
            title: "Secret deleted",
            lead: "You deleted it. The link doesn't open anything any more.",
          }
        : {
            title: "This secret was deleted",
            lead: `The sender deleted it. ${ASK_AGAIN}`,
          };
  }
}

/** What became of a secret that is gone, told to whoever holds a link to it. */
export default function ShareGone({ gone, owner }: ShareGoneProps) {
  const { title, lead } = goneCopy(gone, owner);
  return (
    <div className="space-y-8">
      <PageTitle lead={lead}>{title}</PageTitle>
      <a href={owner ? "/" : "/share"} className={textButtonClass("muted")}>
        ← {owner ? "Share another secret" : "Share a secret of your own"}
      </a>
    </div>
  );
}
