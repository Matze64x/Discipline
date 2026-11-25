import { describe, expect, it } from 'vitest';
import { FRAME_PAYLOAD, Reassembler, splitFrames } from '../../src/lib/sync/framing';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('frames', () => {
	it('round-trip any size and keep characters whole', () => {
		const long = 'x'.repeat(FRAME_PAYLOAD - 1) + '€' + 'ü'.repeat(FRAME_PAYLOAD) + '😀'.repeat(5000);
		for (const message of ['', 'short', long, 'a'.repeat(FRAME_PAYLOAD), 'a'.repeat(FRAME_PAYLOAD + 1)]) {
			const frames = splitFrames(message);
			for (const f of frames) expect(bytes(f.slice(1))).toBeLessThanOrEqual(FRAME_PAYLOAD);
			// no frame starts or ends inside a surrogate pair
			const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
			for (const f of frames) expect(lone.test(f.slice(1))).toBe(false);
			const r = new Reassembler(Infinity);
			const out = frames.map((f) => r.push(f));
			expect(out.slice(0, -1).every((m) => m === null)).toBe(true);
			expect(out.at(-1)).toBe(message);
		}
	});

	it('match the desktop side: a message of exactly the frame size is one frame', () => {
		expect(splitFrames('a'.repeat(FRAME_PAYLOAD))).toHaveLength(1);
		expect(splitFrames('a'.repeat(FRAME_PAYLOAD + 1))).toHaveLength(2);
	});

	it('refuse too large and malformed input', () => {
		const r = new Reassembler(10);
		expect(r.push('+123456')).toBeNull();
		expect(() => r.push('.123456')).toThrow('too large');
		expect(() => new Reassembler(10).push('x')).toThrow('Malformed');
		expect(() => new Reassembler(10).push('')).toThrow('Malformed');
	});
});
