import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// GitHub Pages serves the app below the repository name; everything else (dev server, desktop
// app) serves it at the root. The deploy workflow sets DISCIPLINE_BASE.
const base = process.env['DISCIPLINE_BASE'] ?? '/';

// https://vite.dev/config/
export default defineConfig({
	base,
	plugins: [svelte()],
	test: {
		include: ['tests/**/*.test.ts'],
	},
});
