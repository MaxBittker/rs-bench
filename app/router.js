import { useState, useEffect } from './html.js';

function parseHash(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'trajectory' && parts[1] && parts[2]) {
    return { page: 'trajectory', model: parts[1], skill: parts[2] };
  }
  if (parts[0] === 'model' && parts[1]) {
    return { page: 'model', model: parts[1] };
  }
  return { page: 'home' };
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const handler = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  return route;
}

export function navigate(path) {
  window.location.hash = '#/' + path;
}

export function closeModal() {
  window.location.hash = '#/';
}
