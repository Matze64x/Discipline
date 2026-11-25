import { describe, expect, it } from 'vitest';
import { parsePairingCode } from '../../src/lib/sync/pairing-code';

const FP = 'AB'.repeat(32);
const code = (fields: Partial<Record<'ip' | 'port' | 'fp' | 'id', string>> = {}) =>
	`DS1|${fields.ip ?? '192.168.1.20'}|${fields.port ?? '47680'}|pcufrag1|pcpassword0123456789abcd|${fields.fp ?? FP}|SecretSecret12345678|${fields.id ?? '00000000000000aa'}`;

describe('pairing codes', () => {
	it('reads a valid code', () => {
		expect(parsePairingCode(code())).toEqual({
			ip: '192.168.1.20',
			port: 47680,
			ufrag: 'pcufrag1',
			pass: 'pcpassword0123456789abcd',
			fingerprint: 'ab'.repeat(32),
			secret: 'SecretSecret12345678',
			pcId: '00000000000000aa',
		});
		expect(parsePairingCode(` ${code({ ip: '10.0.0.5' })}\n`)?.ip).toBe('10.0.0.5');
	});

	it('refuses anything else, including addresses outside the local network', () => {
		for (const text of ['', 'hello', 'CG2|x', code({ ip: '8.8.8.8' }), code({ ip: '172.32.0.1' }), code({ ip: '192.168.1.300' }), code({ port: '0' }), code({ port: '70000' }), code({ fp: 'ab' }), code({ id: 'XYZ' }), code() + '|extra'])
			expect(parsePairingCode(text), text).toBeNull();
	});
});
