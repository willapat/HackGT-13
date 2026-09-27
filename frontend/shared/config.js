// Where the Luma backend runs: the local server during development, Fly.io everywhere else.
// Change PRODUCTION_BACKEND if the Fly app has a different name (see fly.toml).
const PRODUCTION_BACKEND = 'https://luma-hackgt.fly.dev';
const LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);
window.LUMA_BACKEND = window.LUMA_BACKEND || (LOCAL ? 'http://127.0.0.1:8000' : PRODUCTION_BACKEND);
