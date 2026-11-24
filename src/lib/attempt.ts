import { errorMessage } from './errors';

/**
 * Runs a change and shows a failure as a notice (e.g. the record changed meanwhile by a sync, or
 * storage failed) instead of losing it in the console. Returns whether it worked.
 */
export async function attempt(notify: (text: string) => void, action: () => Promise<void>): Promise<boolean> {
	try {
		await action();
		return true;
	} catch (e) {
		notify(`Couldn't save: ${errorMessage(e)}`);
		return false;
	}
}
