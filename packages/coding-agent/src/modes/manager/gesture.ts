/**
 * Trackpad swipe detection from terminal wheel events, tuned against real
 * macOS trackpad captures (`pi manager mouse-debug`).
 *
 * What the captures show:
 * - Vertical scrolling emits horizontal jitter, but always as *isolated*
 *   single events among dozens of vertical ones.
 * - A deliberate swipe is an unbroken stream of 20-60 horizontal events at
 *   8-17ms spacing (with at most a rare stray vertical event).
 * - Momentum keeps events flowing after the fingers stop, so a
 *   scroll-then-swipe sequence often has no quiet gap between the two.
 *
 * Detection therefore uses two complementary rules:
 * 1. Axis locking: events group into gestures separated by quiet gaps; each
 *    gesture locks to the axis dominating its first events, and a
 *    horizontally-locked gesture fires fast.
 * 2. Streak escape: a run of consecutive horizontal events fires even inside
 *    a vertically-locked gesture — this is what catches a swipe thrown
 *    during the momentum tail of a scroll. Jitter can't reach the streak
 *    threshold because it never arrives consecutively.
 */

/** A quiet gap longer than this starts a new gesture. */
const GESTURE_GAP_MS = 300;
/** Lock the gesture's axis after this many events (majority wins). */
const LOCK_AFTER_EVENTS = 3;
/** Fire once a horizontally-locked gesture has this many horizontal events. */
const FIRE_AFTER_HORIZONTAL = 3;
/** Consecutive horizontal events that fire regardless of the gesture's lock. */
const FIRE_AFTER_STREAK = 6;

export class WheelSwipeDetector {
	private lastEventAt = 0;
	private horizontal = 0;
	private vertical = 0;
	private streak = 0;
	private locked: "h" | "v" | undefined;
	private fired = false;

	/** Feed one wheel event; returns true when a swipe fires (once per gesture). */
	feed(axis: "h" | "v", now = Date.now()): boolean {
		if (now - this.lastEventAt > GESTURE_GAP_MS) {
			this.horizontal = 0;
			this.vertical = 0;
			this.streak = 0;
			this.locked = undefined;
			this.fired = false;
		}
		this.lastEventAt = now;

		if (axis === "h") {
			this.horizontal++;
			this.streak++;
		} else {
			this.vertical++;
			this.streak = 0;
		}
		if (this.locked === undefined && this.horizontal + this.vertical >= LOCK_AFTER_EVENTS) {
			// Ties lock vertical: scrolling must never be mistaken for a swipe.
			this.locked = this.horizontal > this.vertical ? "h" : "v";
		}
		if (this.fired) {
			return false;
		}
		if ((this.locked === "h" && this.horizontal >= FIRE_AFTER_HORIZONTAL) || this.streak >= FIRE_AFTER_STREAK) {
			this.fired = true;
			return true;
		}
		return false;
	}
}
