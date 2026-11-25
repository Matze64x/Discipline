import { svelte } from '@sveltejs/vite-plugin-svelte';
import { execSync } from 'node:child_process';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

// GitHub Pages serves the app below the repository name; everything else (dev server, desktop
// app) serves it at the root. The deploy workflow sets DISCIPLINE_BASE.
const base = process.env['DISCIPLINE_BASE'] ?? '/';

/** The app's version: the day and commit it was built from, e.g. "2026-11-25 92e6f68" */
function appVersion(): string {
	// (given by scripts/test-e2e.sh, which builds in a container that may have no usable git)
	if (process.env['DISCIPLINE_VERSION']) return process.env['DISCIPLINE_VERSION'];
	try {
		return execSync('git log -1 --format="%cd %h" --date=format:%Y-%m-%d', { encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
}
// (a suffix marks a second build for the update tests, see playwright.config.ts)
const version = [appVersion(), process.env['DISCIPLINE_VERSION_SUFFIX']].filter(Boolean).join(' ');

/** Writes version.json, which the installed app fetches to see whether a newer version is out */
function versionFile(): Plugin {
	return {
		name: 'discipline-version-file',
		apply: 'build',
		generateBundle() {
			this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ version })}\n` });
		},
	};
}

// https://vite.dev/config/
export default defineConfig({
	base,
	define: { __APP_VERSION__: JSON.stringify(version) },
	plugins: [
		svelte(),
		versionFile(),
		// installable web app that works offline; the service worker is registered in main.ts
		// (only in browsers, not in the desktop app)
		VitePWA({
			// the desktop app ships its files itself, so it gets no service worker
			disable: Boolean(process.env['TAURI_ENV_PLATFORM']),
			// our own service worker (src/sw/sw.ts): it installs a new version only as the update
			// setting allows (automatic, or after "Update"); `updates.svelte.ts` registers it and
			// switches versions, never while the app is in use unless the user asks
			strategies: 'injectManifest',
			srcDir: 'src/sw',
			filename: 'sw.ts',
			registerType: 'prompt',
			injectRegister: false,
			// icons made from icons/*.svg (see icons/README.md)
			manifest: {
				id: '.',
				name: 'Discipline',
				short_name: 'Discipline',
				description: 'Habit tracker',
				start_url: '.',
				scope: '.',
				display: 'standalone',
				background_color: '#f4f7f9',
				theme_color: '#ffffff',
				icons: [
					{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
					// (on a full square: Android cuts its own shape out of it)
					{ src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
				],
			},
			// the app's data lives in IndexedDB, not in this cache; version.json is never cached
			injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png}'] },
		}),
	],
	test: {
		include: ['tests/**/*.test.ts'],
	},
});
