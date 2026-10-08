import Spinner from "../Spinner";
import PageTitle from "../ui/PageTitle";
import { textButtonClass } from "../ui/styles";

export function RetrieveLoading() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20">
      <Spinner size="lg" className="text-accent" />
      <p className="text-sm text-muted">Opening the link…</p>
    </div>
  );
}

export function RetrieveError({
  title,
  message,
  owner = false,
}: {
  title: string;
  message: string;
  /** Whether the link that was opened is the owner link, for the errors that know. */
  owner?: boolean;
}) {
  return (
    <div className="space-y-8">
      <PageTitle lead={message}>{title}</PageTitle>
      <a href={owner ? "/" : "/share"} className={textButtonClass("muted")}>
        ← {owner ? "Share another secret" : "Share a secret of your own"}
      </a>
    </div>
  );
}

export function ShareDeleted() {
  return (
    <div className="space-y-8">
      <PageTitle lead="The link doesn't open anything any more.">Secret deleted</PageTitle>
      <a href="/" className={textButtonClass("muted")}>
        ← Share another secret
      </a>
    </div>
  );
}
