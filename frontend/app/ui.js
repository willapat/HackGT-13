// Small UI pieces shared by the app pages: toasts, a confirm dialog, and the theme setting.

const $ = (s) => document.querySelector(s);

// A short message at the bottom of the screen that goes away on its own
export function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

// A styled replacement for confirm(). Resolves true when confirmed. With `typeToConfirm`, the confirm
// button stays disabled until that exact text is typed (for things that can't be undone).
export function confirmDialog({ title, body = '', confirmLabel = 'OK', danger = false, typeToConfirm = '' }) {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').textContent = body;
  $('#dialog-body').hidden = !body;
  const ok = $('#dialog-ok');
  ok.textContent = confirmLabel;
  ok.className = danger ? 'danger-solid' : 'primary';
  const field = $('#dialog-confirm-field'), input = $('#dialog-confirm-input');
  field.hidden = !typeToConfirm;
  input.value = '';
  $('#dialog-confirm-label').textContent = typeToConfirm ? `Type ${typeToConfirm} to confirm` : '';
  ok.disabled = Boolean(typeToConfirm);
  input.oninput = () => { ok.disabled = input.value.trim() !== typeToConfirm; };
  dialog.returnValue = '';
  dialog.showModal();
  (typeToConfirm ? input : ok).focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

// Theme: 'system' | 'light' | 'dark', kept on this device. The page applies it before first paint too.
const THEME_KEY = 'tt-theme';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

export function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

export function setTheme(choice) {
  try { localStorage.setItem(THEME_KEY, choice); } catch { /* storage blocked: applies for this visit only */ }
  applyTheme(choice);
}

function applyTheme(choice = getTheme()) {
  document.documentElement.dataset.theme = choice === 'system' ? (darkQuery.matches ? 'dark' : 'light') : choice;
}

darkQuery.addEventListener('change', () => { if (getTheme() === 'system') applyTheme('system'); });
