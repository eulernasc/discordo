/* Load optional libraries without blocking the Discordo application shell. */
(function () {
  'use strict';

  function notify(name) {
    window.dispatchEvent(new Event(name));
  }
  function loadWithFallback(urls, predicate, ok, failed) {
    let index = 0;
    let settled = false;
    function attempt() {
      if (predicate()) {
        settled = true;
        ok();
        return;
      }
      if (index >= urls.length) {
        if (!settled) failed();
        return;
      }
      const address = urls[index++];
      const script = document.createElement('script');
      let finished = false;
      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        script.remove();
        attempt();
      }, 8500);
      const finish = (success) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (!success) {
          script.remove();
          attempt();
        } else if (!settled) {
          settled = true;
          ok();
        }
      };
      script.src = address;
      script.async = true;
      script.onload = () => finish(predicate());
      script.onerror = () => finish(false);
      document.head.appendChild(script);
    }
    attempt();
  }

  loadWithFallback([
    'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js',
    'https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js'
  ], () => typeof window.Peer === 'function',
  () => notify('discordo-peer-ready'),
  () => notify('discordo-peer-error'));

  loadWithFallback([
    'https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js',
    'https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js'
  ], () => !!(window.lucide && window.lucide.createIcons),
  () => notify('discordo-icons-ready'),
  () => console.warn('Discordo: biblioteca de ícones indisponível; interface continua utilizável.'));
})();
