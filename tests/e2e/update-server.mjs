// A test server for updates (updates.spec.ts): serves the published build below /Discipline/,
// from dist-update/first, or from dist-update/next (a build with another version) after a GET of
// /publish/next (/publish/first switches back), as GitHub Pages would after a new version was
// published. A toggle, not a cookie: WebKit sends no cookies with a service worker's own fetches.
// One server per browser project (see playwright.config.ts), so tests don't see each other's.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.argv[2] ?? 5398);
const BASE = '/Discipline/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let version = 'first';

createServer((request, response) => {
	const url = new URL(request.url ?? '/', 'http://localhost');
	const publish = /^\/publish\/(first|next)$/.exec(url.pathname);
	if (publish) {
		version = publish[1];
		return void response.writeHead(204).end();
	}
	if (!url.pathname.startsWith(BASE)) return void response.writeHead(404).end();
	const root = join('dist-update', version);
	let path = normalize(join(root, url.pathname.slice(BASE.length) || 'index.html'));
	if (!path.startsWith(root) || !existsSync(path) || statSync(path).isDirectory()) path = join(root, 'index.html');
	response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
	createReadStream(path).pipe(response);
}).listen(PORT, '127.0.0.1');
