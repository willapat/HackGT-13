// Where the Luma backend runs: the local server during development, otherwise the Fly.io backend
// (https://luma-hackgt-api.fly.dev) through this site's /api proxy (vercel.json rewrites). Going through the
// site's own domain means networks that can't resolve fly.dev (Georgia Tech's DNS cached it as missing) still work.
const LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);
window.LUMA_BACKEND = window.LUMA_BACKEND || (LOCAL ? 'http://127.0.0.1:8000' : `${location.origin}/api`);
