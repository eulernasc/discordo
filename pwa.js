/* Progressive Web App: install on desktop/Android or show iOS instructions. */
(() => {
  'use strict';
  const button = document.getElementById('installAppBtn');
  if (!button) return;
  let installationPrompt = null;
  const standalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  const refresh = () => {
    button.classList.toggle('installed', standalone());
    button.setAttribute('aria-hidden', String(standalone()));
  };
  refresh();
  window.addEventListener('appinstalled', () => {
    installationPrompt = null;
    button.classList.add('installed');
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installationPrompt = event;
    button.title = 'Instalar Discordo';
    refresh();
  });

  const message = () => {
    const ua = navigator.userAgent || '';
    const iOS = /iPhone|iPad|iPod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua);
    const safari = /^((?!chrome|android).)*safari/i.test(ua);
    if (iOS) {
      return {
        title: 'Instale no iPhone ou iPad',
        body: 'Abra este site no Safari, toque no botão Compartilhar (quadrado com seta para cima), escolha "Adicionar à Tela de Início" e confirme em "Adicionar". O Discordo aparecerá como um aplicativo na tela inicial.'
      };
    }
    if (android) {
      return {
        title: 'Instale no Android',
        body: 'Abra este site no Chrome, toque no menu de três pontos e escolha "Instalar aplicativo" ou "Adicionar à tela inicial". Confirme a instalação.'
      };
    }
    return {
      title: 'Instale no computador',
      body: safari
        ? 'No Safari, use o menu Arquivo e escolha "Adicionar ao Dock", quando disponível.'
        : 'Abra este site no Chrome ou Edge e clique no ícone de instalar, na barra de endereços. Também pode usar o menu de três pontos e escolher "Instalar Discordo".'
    };
  };
  function showHelp() {
    const dialog = document.getElementById('dialog');
    const overlay = document.getElementById('overlay');
    if (!dialog || !overlay) return window.alert(message().body);
    const help = message();
    dialog.textContent = '';
    const icon = document.createElement('div');
    icon.className = 'dialog-logo';
    icon.textContent = '↓';
    icon.style.fontSize = '24px';
    const title = document.createElement('h2');
    title.textContent = help.title;
    const detail = document.createElement('p');
    detail.textContent = help.body;
    const dismiss = document.createElement('button');
    dismiss.className = 'primary-action';
    dismiss.textContent = 'Entendi';
    dismiss.addEventListener('click', () => overlay.classList.add('hidden'));
    dialog.append(icon, title, detail, dismiss);
    overlay.classList.remove('hidden');
  }

  button.addEventListener('click', async () => {
    if (standalone()) return;
    if (!installationPrompt) return showHelp();
    const prompt = installationPrompt;
    installationPrompt = null;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch (_) {
      showHelp();
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js?v=20261010-boot2', { scope: './', updateViaCache: 'none' }).catch((error) => {
        console.warn('Discordo: service worker indisponível', error);
      });
    });
  }
})();
