// Shared presence tracking — used by every game.
//
// THE BUG THIS FIXES
//
// Games used to mark themselves present once, at join time:
//
//   await update(meRef, { connected: true, ... });
//   onDisconnect(child(meRef, "connected")).set(false);
//
// `onDisconnect` is a ONE-SHOT, server-side trigger. Any brief wobble in the
// socket — a phone locking, wifi roaming between APs, a laptop lid, a tab
// backgrounded on mobile Safari, or Firebase itself recycling a long-lived
// connection — fires it, and the server writes `connected: false`.
//
// The SDK then reconnects automatically and your onValue listeners resume, so
// the game still *looks* fine on your screen. But nothing ever rewrites
// `connected: true`, and the onDisconnect handler has been consumed, so a later
// real disconnect doesn't even register. From every other client's point of
// view you are now permanently gone, mid-game:
//
//   • the host's low-player watchdog sees the count drop and resets the room
//     to the lobby — you get "kicked out" halfway through;
//   • "has everyone submitted / voted yet?" checks skip absent players, so a
//     reveal or vote ends early, without you;
//   • claimHostIfAbandoned() hands the host role to somebody else, and two
//     clients can briefly both believe they're driving the state machine.
//
// THE FIX
//
// Watch `.info/connected` and, every time the socket comes back, re-arm the
// onDisconnect handler and re-assert `connected: true`. This is the pattern
// Firebase's own presence docs prescribe, and it makes a reconnect invisible
// to the rest of the room instead of permanent.

import {
  ref, child, onValue, onDisconnect, set,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

/**
 * Keep `<playerRef>/connected` true for as long as this tab is alive and
 * online, surviving any number of reconnects.
 *
 * @param {import("firebase/database").Database} db
 * @param {import("firebase/database").DatabaseReference} playerRef
 *        The player's own node, e.g. child(playersRef(), pid).
 * @returns {() => Promise<void>} leave() — stop tracking, cancel the pending
 *        onDisconnect and mark yourself gone. Call it on a deliberate exit.
 */
export function trackPresence(db, playerRef) {
  const flag = child(playerRef, "connected");
  let stopped = false;

  const unsubscribe = onValue(ref(db, ".info/connected"), async (snap) => {
    if (stopped || snap.val() !== true) return;
    try {
      // Arm the handler BEFORE claiming presence: if we drop in between, the
      // worst case is a brief false "away", never a permanent false "here".
      await onDisconnect(flag).set(false);
      if (!stopped) await set(flag, true);
    } catch {
      // Offline again already — the next reconnect runs this whole block.
    }
  });

  // Coming back from a backgrounded tab is the most common way to arrive here
  // after the server has already timed the old socket out. The listener above
  // normally handles it; this is belt-and-braces for the case where the SDK
  // believes it is still connected and so never fires a change.
  const onVisible = () => {
    if (!stopped && document.visibilityState === "visible") set(flag, true).catch(() => {});
  };
  document.addEventListener("visibilitychange", onVisible);

  return function leave() {
    stopped = true;
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisible);
    onDisconnect(flag).cancel().catch(() => {});
    return set(flag, false).catch(() => {});
  };
}
