import { useEffect } from "react";

/**
 * While active, asks the browser to keep the screen on. A phone that locks
 * its screen sends the page to the background, where the browser slows or
 * stops it, and a long upload stalls. The browser drops the lock whenever
 * the page is hidden, so it is taken again each time the page comes back.
 * Where there is no Wake Lock API, or the browser refuses, nothing happens.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (released) {
          await next.release();
        } else {
          lock = next;
        }
      } catch {
        // Refused, as in low-power mode: the upload simply runs without it.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
