/// <reference types="vite/client" />
import './style.css';
import { App } from './app';

const app = new App(document.getElementById('app')!);
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;

// Offline cache for the installed (Home Screen) app; skipped in dev so edits show immediately.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
