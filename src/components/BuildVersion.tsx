import { useEffect, useState } from "react";
import { getVersion } from "../lib/api";
import { FOCUS } from "./ui/styles";

const COMMIT = /^[0-9a-f]{40}$/;

interface BuildLabelProps {
  /** What runs this build: "web" for this app, "server" for the API. */
  name: "web" | "server";
  version: string;
}

/** One build: its short commit, linked to the source when it is a commit. */
function BuildLabel({ name, version }: BuildLabelProps) {
  if (!COMMIT.test(version)) return <span>{`${name} ${version}`}</span>;
  const short = version.slice(0, 7);
  return (
    <a
      href={`https://github.com/secretli/${name}/commit/${version}`}
      target="_blank"
      rel="noreferrer"
      title={`The ${name === "web" ? "web app" : "server"} runs commit ${short}`}
      className={`rounded-md transition-colors duration-150 hover:text-ink ${FOCUS}`}
    >
      {`${name} ${short}`}
    </a>
  );
}

/**
 * The builds behind the page: this app's commit, baked in when the image is
 * built, and the server's, as the API reports it. They deploy independently,
 * so each names exactly the code it runs. The server part is left out if the
 * API can't be reached.
 */
export default function BuildVersion() {
  const [server, setServer] = useState<string | null>(null);
  const web = import.meta.env.VITE_BUILD_VERSION || "dev";

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) setServer(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <span className="inline-flex min-h-11 items-center gap-1.5 font-mono text-xs text-faint">
      <BuildLabel name="web" version={web} />
      {server && (
        <>
          <span aria-hidden="true">·</span>
          <BuildLabel name="server" version={server} />
        </>
      )}
    </span>
  );
}
