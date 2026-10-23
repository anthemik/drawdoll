/// <reference types="vite/client" />
import './style.css';
import { App } from './app';

const app = new App(document.getElementById('app')!);
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;
