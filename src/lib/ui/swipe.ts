/**
 * Horizontal swipes on an element (touch and pen; a mouse drags nothing): `go(1)` for a swipe to
 * the left (forward: what comes after), `go(-1)` to the right, if `can` allows that direction.
 * While the finger moves, the element follows it a little (not with reduced motion); a click right
 * after a swipe (some browsers send one) isn't a tap. Vertical moves stay the browser's
 * (`touch-action`; the app has no zoom).
 * Use: `<div use:swipe={{ go: page, can: (by) => … }}>`. Every swipe needs a button that does the same.
 */
const DISTANCE = 50;
/** Follows the finger by this share, at most `MAX_SHIFT` px (a hint that something moves) */
const FOLLOW = 0.3;
const MAX_SHIFT = 40;
/** A click this soon after a swipe belongs to it */
const CLICK_WINDOW = 400;

export interface Swipe {
	go: (by: -1 | 1) => void;
	/** Whether a direction can page (default: both) */
	can?: (by: -1 | 1) => boolean;
	/** What follows the finger, a selector inside the element (default: the element itself) */
	moves?: string;
}

export function swipe(node: HTMLElement, options: Swipe) {
	let current = options;
	let start: { x: number; y: number; id: number } | null = null;
	/** When the last swipe ended (the click that may follow isn't a tap) */
	let swipedAt = -Infinity;
	const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
	const can = (by: -1 | 1) => current.can?.(by) ?? true;
	node.style.touchAction = 'pan-y';

	const moving = () => (current.moves ? node.querySelector<HTMLElement>(current.moves) : null) ?? node;
	function move(x: number) {
		const target = moving();
		target.style.transition = '';
		target.style.transform = x === 0 || still() ? '' : `translateX(${x}px)`;
	}
	function settle() {
		const target = moving();
		target.style.transition = 'transform 0.15s ease-out';
		target.style.transform = '';
	}
	/** Whether a move is a horizontal swipe so far (mostly sideways) */
	const sideways = (dx: number, dy: number) => Math.abs(dx) > 1.5 * Math.abs(dy);

	function down(e: PointerEvent) {
		// (any new press, also a mouse's: a click after it is its own)
		swipedAt = -Infinity;
		if (e.pointerType === 'mouse' || !e.isPrimary) return;
		start = { x: e.clientX, y: e.clientY, id: e.pointerId };
	}
	function moved(e: PointerEvent) {
		if (start?.id !== e.pointerId) return;
		const [dx, dy] = [e.clientX - start.x, e.clientY - start.y];
		const follows = Math.abs(dx) > 10 && sideways(dx, dy) && can(dx < 0 ? 1 : -1);
		move(follows ? Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, dx * FOLLOW)) : 0);
	}
	function up(e: PointerEvent) {
		if (start?.id !== e.pointerId) return;
		const [dx, dy] = [e.clientX - start.x, e.clientY - start.y];
		start = null;
		settle();
		const by = dx < 0 ? 1 : -1;
		if (Math.abs(dx) >= DISTANCE && sideways(dx, dy) && can(by)) {
			swipedAt = e.timeStamp;
			current.go(by);
		}
	}
	function cancel() {
		start = null;
		settle();
	}
	function click(e: MouseEvent) {
		if (e.timeStamp - swipedAt > CLICK_WINDOW) return;
		swipedAt = -Infinity;
		e.preventDefault();
		e.stopPropagation();
	}

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', moved);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', cancel);
	// (capture: before a button inside handles it)
	node.addEventListener('click', click, true);
	return {
		update(next: Swipe) {
			current = next;
		},
		destroy() {
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', moved);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', cancel);
			node.removeEventListener('click', click, true);
		},
	};
}
