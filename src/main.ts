import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { isDesktop } from './lib/desktop';

mount(App, { target: document.getElementById('app')! });

// offline support for the installed web app; the desktop app ships its files itself
if (!isDesktop && import.meta.env.PROD) {
	// a new version is used from the next start (see vite.config.ts), so no update handling here
	void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}
