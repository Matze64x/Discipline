import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

// (the installed web app's service worker is registered by `updates.svelte.ts`, started in App)
mount(App, { target: document.getElementById('app')! });
