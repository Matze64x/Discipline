import { describe, expect, it } from 'vitest';
import { mayInstall, STALE_POLICY_MS } from '../../src/lib/update-policy';

const NOW = 1_800_000_000_000;

describe('update policy', () => {
	it('lets a new version install automatically, or once the user asked for it', () => {
		expect(mayInstall({ auto: true, approved: false, stored: NOW }, false, NOW)).toBe(true);
		expect(mayInstall({ auto: false, approved: true, stored: NOW }, false, NOW)).toBe(true);
		expect(mayInstall({ auto: false, approved: false, stored: NOW }, false, NOW)).toBe(false);
	});

	it('always allows the first install, and when nothing was set yet', () => {
		expect(mayInstall({ auto: false, approved: false, stored: NOW }, true, NOW)).toBe(true);
		expect(mayInstall(undefined, false, NOW)).toBe(true);
	});

	it('allows it when the app hasn’t stored its policy for days (it may not start at all)', () => {
		expect(mayInstall({ auto: false, approved: false, stored: NOW - STALE_POLICY_MS + 1000 }, false, NOW)).toBe(false);
		expect(mayInstall({ auto: false, approved: false, stored: NOW - STALE_POLICY_MS - 1000 }, false, NOW)).toBe(true);
	});
});
