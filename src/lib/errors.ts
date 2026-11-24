/** A readable message for anything thrown; Tauri commands reject with plain strings. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	return String(error);
}
