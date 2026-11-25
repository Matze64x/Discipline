/**
 * Messages over the data channel are split into frames, since browsers limit a data channel
 * message's size: each frame is text starting with `+` (more frames follow) or `.` (the last one).
 * Same as the desktop side (`src-tauri/src/sync/framing.rs`). Frames are cut at character
 * boundaries, so each is valid text.
 */

/** The largest frame's payload in UTF-8 bytes (the desktop side uses the same) */
export const FRAME_PAYLOAD = 16 * 1024;

const encoder = new TextEncoder();

export function splitFrames(message: string): string[] {
	const frames: string[] = [];
	let start = 0;
	let bytes = 0;
	let i = 0;
	while (i < message.length) {
		const code = message.codePointAt(i)!;
		const units = code > 0xffff ? 2 : 1;
		const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		if (bytes + size > FRAME_PAYLOAD) {
			frames.push(`+${message.slice(start, i)}`);
			start = i;
			bytes = 0;
		}
		bytes += size;
		i += units;
	}
	frames.push(`.${message.slice(start)}`);
	return frames;
}

export class FrameError extends Error {}

/** Puts frames back together, refusing messages larger than `limit` UTF-8 bytes. */
export class Reassembler {
	#text = '';
	#bytes = 0;

	constructor(private readonly limit: number) {}

	/** Adds a frame; returns the message when it's complete. */
	push(frame: string): string | null {
		const flag = frame[0];
		if (flag !== '+' && flag !== '.') throw new FrameError('Malformed frame.');
		const payload = frame.slice(1);
		this.#bytes += encoder.encode(payload).length;
		if (this.#bytes > this.limit) throw new FrameError('Message too large.');
		this.#text += payload;
		if (flag === '+') return null;
		const message = this.#text;
		this.#text = '';
		this.#bytes = 0;
		return message;
	}
}
