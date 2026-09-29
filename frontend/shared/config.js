// Where the Luma backend runs: the local server during development, otherwise the Vultr server
// (https://45-32-211-68.sslip.io) through this site's /api proxy (vercel.json rewrites). Going through the
// site's own domain means networks that can't resolve the backend's name still work, and there's no CORS to set up.
const LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);
window.LUMA_BACKEND = window.LUMA_BACKEND || (LOCAL ? 'http://127.0.0.1:8000' : `${location.origin}/api`);
