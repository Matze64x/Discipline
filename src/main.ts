import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

// no zooming, like an app (user 2026-11-25): iOS Safari ignores the viewport's user-scalable=no and
// starts a pinch with this event (double-tap zoom is off via `touch-action` in app.css)
document.addEventListener('gesturestart', (e) => e.preventDefault());

// (the installed web app's service worker is registered by `updates.svelte.ts`, started in App)
mount(App, { target: document.getElementById('app')! });
