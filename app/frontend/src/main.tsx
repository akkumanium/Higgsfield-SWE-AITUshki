import { App } from './App.js';
import 'tldraw/tldraw.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found.');
}

document.body.style.margin = '0';
document.body.style.minHeight = '100vh';
document.documentElement.style.height = '100%';
document.body.style.height = '100%';
root.style.height = '100%';
root.style.width = '100%';
document.body.style.background = 'radial-gradient(circle at 20% 10%, #dbeafe 0%, #bfdbfe 28%, #e2e8f0 56%, #f8fafc 100%)';
document.body.style.color = '#0f172a';
document.body.style.fontFamily = 'Segoe UI, system-ui, sans-serif';
document.body.style.overflow = 'hidden';

App(root);