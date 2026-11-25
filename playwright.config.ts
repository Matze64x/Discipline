import { defineConfig, devices } from '@playwright/test';

// End-to-end tests against the dev server, and against the build exactly as it's published on
// GitHub Pages (below /Discipline/, in dist-pages; the publish workflow uploads that directory).
// Run with: npm run test:e2e (in Docker, as in CI: scripts/test-e2e.sh)
export default defineConfig({
	testDir: 'tests/e2e',
	outputDir: 'tests/e2e-results',
	fullyParallel: true,
	reporter: 'list',
	forbidOnly: Boolean(process.env['CI']),
	// CI machines are slower; one retry keeps timing hiccups from blocking a deployment
	retries: process.env['CI'] ? 1 : 0,
	// 127.0.0.1, not localhost: on pages from the IPv6 loopback ([::1], what "localhost" resolves to
	// for Vite) Firefox gathers no WebRTC candidates (needed for phone sync later)
	use: { baseURL: 'http://127.0.0.1:5198', trace: 'retain-on-failure' },
	webServer: [
		{ command: 'npx vite --port 5198 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:5198', reuseExistingServer: false },
		// the published build, for what only exists there (service worker, manifest, base path)
		{
			command: 'export DISCIPLINE_BASE=/Discipline/ && npx vite build --outDir dist-pages && npx vite preview --outDir dist-pages --port 5298 --strictPort',
			url: 'http://localhost:5298/Discipline/',
			reuseExistingServer: false,
		},
		// two published builds of different versions, for updates (tests/e2e/update-server.mjs): one
		// server per project (5398 Firefox, 5399 iPhone), since publishing switches a whole server
		{
			command:
				'export DISCIPLINE_BASE=/Discipline/ && npx vite build --outDir dist-update/first --emptyOutDir && DISCIPLINE_VERSION_SUFFIX=next npx vite build --outDir dist-update/next --emptyOutDir && (node tests/e2e/update-server.mjs 5399 & node tests/e2e/update-server.mjs 5398)',
			url: 'http://127.0.0.1:5398/Discipline/',
			reuseExistingServer: false,
		},
	],
	projects: [
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
		// WebKit is Safari's engine: the closest to the iPhone we can test here
		{ name: 'iphone', use: { ...devices['iPhone 15'] } },
	],
});
