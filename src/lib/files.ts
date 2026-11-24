/** Handing a file to the user to save; picking files is done with a file input in `App.svelte`. */

function shareable(text: string, fileName: string): File | null {
	if (!navigator.canShare) return null;
	// some iOS versions only share JSON as text/plain
	for (const type of ['application/json', 'text/plain']) {
		const file = new File([text], fileName, { type });
		if (navigator.canShare({ files: [file] })) return file;
	}
	return null;
}

/**
 * Gives the file to the user: on touch devices via the share sheet ("Save to Files" on iOS),
 * elsewhere as a download. Returns false if the user cancelled the share sheet.
 * Must be called directly from a click handler (browsers require a user action for both).
 */
export async function saveFile(text: string, fileName: string): Promise<boolean> {
	// on desktops the share sheet is unusual for saving files, so prefer the download there
	const file = window.matchMedia('(pointer: coarse)').matches ? shareable(text, fileName) : null;
	if (file) {
		try {
			await navigator.share({ files: [file] });
			return true;
		} catch (e) {
			if ((e as Error).name === 'AbortError') return false;
			throw e;
		}
	}
	const url = URL.createObjectURL(new File([text], fileName, { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
	return true;
}
