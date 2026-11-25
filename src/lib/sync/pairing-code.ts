/**
 * The pairing QR code a PC shows: `DS1|ip|port|ice ufrag|ice password|certificate fingerprint
 * (SHA-256, hex)|one-time secret|PC device id` (made by `sync_pairing_start` in the desktop app).
 */

export interface PcAddress {
	/** IPv4 address on the local network */
	readonly ip: string;
	readonly port: number;
	readonly ufrag: string;
	readonly pass: string;
	/** SHA-256 of the PC's certificate, 64 lowercase hex digits */
	readonly fingerprint: string;
}

export interface PairingCode extends PcAddress {
	readonly secret: string;
	readonly pcId: string;
}

const ICE_TEXT = /^[A-Za-z0-9+/]{4,256}$/;

function isLocalIpv4(ip: string): boolean {
	const parts = ip.split('.');
	if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
	const [a, b] = parts.map(Number) as [number, number];
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** The code's content, or null if it isn't a Discipline pairing code (or points outside the local network). */
export function parsePairingCode(text: string): PairingCode | null {
	const parts = text.trim().split('|');
	if (parts.length !== 8 || parts[0] !== 'DS1') return null;
	const [, ip, port, ufrag, pass, fingerprint, secret, pcId] = parts as [string, string, string, string, string, string, string, string];
	if (!isLocalIpv4(ip)) return null;
	if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
	if (!ICE_TEXT.test(ufrag) || !ICE_TEXT.test(pass) || !ICE_TEXT.test(secret)) return null;
	if (!/^[0-9a-f]{64}$/i.test(fingerprint) || !/^[0-9a-f]{16}$/.test(pcId)) return null;
	return { ip, port: Number(port), ufrag, pass, fingerprint: fingerprint.toLowerCase(), secret, pcId };
}
