/* Discordo — MVP independente de backend (PeerJS/WebRTC)
   Uso: navegador HTTPS, convites por codigo e um canal de voz por vez.
   A primeira pessoa conectada coordena a sala e seu historico temporario. */
(function () {
  'use strict';

  const STORAGE = 'discordo-v1';
  const PEER_PREFIX = 'discordo-room-';
  const $ = (id) => document.getElementById(id);
  const DEFAULT_CHANNELS = [
    { id: 'geral', name: 'geral', type: 'text' },
    { id: 'avisos', name: 'avisos', type: 'text' },
    { id: 'voz-geral', name: 'Geral', type: 'voice' },
    { id: 'jogos', name: 'Jogos e resenha', type: 'voice' }
  ];

  const saved = load(STORAGE, {});
  let nickname = typeof saved.nickname === 'string' ? saved.nickname : '';
  let servers = Array.isArray(saved.servers) ? saved.servers : [];
  let selectedServerId = saved.selectedServerId || '';
  const inviteId = new URLSearchParams(location.search).get('room');
  const validInviteId = inviteId && /^[a-z0-9-]{4,28}$/i.test(inviteId) ? inviteId.toLowerCase() : '';
  if (!servers.length) servers.push(makeServer('Meu espaço', 'geral'));
  if (validInviteId && !servers.some((s) => s.id === validInviteId)) {
    servers.push(makeServer('Sala de um amigo', validInviteId));
  }
  if (validInviteId) selectedServerId = validInviteId;
  if (!servers.some((s) => s.id === selectedServerId)) selectedServerId = servers[0].id;

  const state = {
    peer: null,
    hostConnection: null,
    guestConnections: new Map(),
    members: new Map(),
    isHost: false,
    connected: false,
    connecting: false,
    myPeerId: '',
    selectedType: 'text',
    selectedChannelId: 'geral',
    voiceChannelId: '',
    screenStream: null,
    micStream: null,
    outgoing: new Map(),
    incoming: new Map(),
    remoteScreens: new Map(),
    remoteAudio: new Map(),
    mediaRequests: new Map(),
    mediaRetryTimer: null,
    playbackBlocked: false,
    selectedScreen: '',
    messages: [],
    stageKey: '',
    generation: 0,
    reconnectTimer: null,
    toastTimer: null,
    showMembers: window.innerWidth > 1150
  };

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (_) { return fallback; }
  }
  function save() {
    try { localStorage.setItem(STORAGE, JSON.stringify({ nickname, servers, selectedServerId })); } catch (_) {}
  }
  function saveChat() {
    try { localStorage.setItem('discordo-chat-' + selectedServerId, JSON.stringify(state.messages.slice(-150))); } catch (_) {}
  }
  function code() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(8);
    if (crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  }
  function makeServer(name, id) {
    return { id: id === 'geral' ? code() : (id || code()), name: name, channels: DEFAULT_CHANNELS.map((c) => ({ ...c })) };
  }
  function server() { return servers.find((s) => s.id === selectedServerId) || servers[0]; }
  function currentChannel() { return server().channels.find((c) => c.type === state.selectedType && c.id === state.selectedChannelId) || server().channels.find((c) => c.type === state.selectedType); }
  function escapeHTML(v) {
    return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function hashColor(name) {
    let sum = 0;
    for (let i = 0; i < name.length; i++) sum = (sum * 31 + name.charCodeAt(i)) | 0;
    const hues = [260, 211, 336, 175, 28, 283, 143];
    return 'hsl(' + hues[Math.abs(sum) % hues.length] + ' 53% 53%)';
  }
  function avatar(name, klass) {
    const letter = (name || '?').trim().charAt(0).toUpperCase();
    return '<span class="' + (klass || 'avatar') + '" style="background:' + hashColor(name || '?') + '">' + escapeHTML(letter) + '</span>';
  }
  function icons() { try { if (window.lucide) window.lucide.createIcons(); } catch (_) {} }
  function toast(message) {
    const n = $('toast');
    n.textContent = message;
    n.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => n.classList.add('hidden'), 3900);
  }
  function persistURL() {
    const u = new URL(location.href);
    u.searchParams.set('room', selectedServerId);
    history.replaceState({}, '', u.pathname + u.search + u.hash);
  }
  function inviteURL() {
    const u = new URL(location.href);
    u.searchParams.set('room', selectedServerId);
    return u.toString();
  }
  function myParticipant() {
    return { id: state.myPeerId, name: nickname, voiceChannelId: state.voiceChannelId, sharing: !!state.screenStream, mic: !!state.micStream };
  }
  function activeMembers() {
    return Array.from(state.members.values());
  }
  function voiceMembers(id) {
    return activeMembers().filter((u) => u.voiceChannelId === id);
  }
  function selfMember() {
    return state.members.get(state.myPeerId) || myParticipant();
  }
  function updateSelf() {
    if (!state.myPeerId) return;
    state.members.set(state.myPeerId, myParticipant());
    if (state.isHost) broadcast({ type: 'roster', members: activeMembers() });
    else if (state.hostConnection && state.hostConnection.open) {
      state.hostConnection.send({ type: 'status', voiceChannelId: state.voiceChannelId, sharing: !!state.screenStream, mic: !!state.micStream, name: nickname });
    }
    renderPresence();
    reconcileOutgoing();
  }

  function renderServers() {
    $('serverList').innerHTML = servers.map((s) => '<button class="server-icon ' + (s.id === selectedServerId ? 'active' : '') + '" data-server="' + escapeHTML(s.id) + '" title="' + escapeHTML(s.name) + '">' + escapeHTML(s.name.trim().substring(0, 2).toUpperCase()) + '</button>').join('');
    document.querySelectorAll('[data-server]').forEach((b) => b.addEventListener('click', () => switchServer(b.dataset.server)));
    $('serverTitle').textContent = server().name;
    $('profileName').textContent = nickname || 'Visitante';
    $('profileAvatar').textContent = (nickname || 'D').charAt(0).toUpperCase();
    $('profileAvatar').style.background = hashColor(nickname || 'D');
    $('profileStatus').textContent = state.connected ? 'Online' : (state.connecting ? 'Conectando...' : 'Desconectado');
  }
  function renderChannels() {
    const channels = server().channels;
    $('textChannelList').innerHTML = channels.filter((c) => c.type === 'text').map((c) =>
      '<button class="channel-item ' + (state.selectedType === 'text' && state.selectedChannelId === c.id ? 'active' : '') + '" data-text="' + escapeHTML(c.id) + '"><i data-lucide="hash"></i><span>' + escapeHTML(c.name) + '</span></button>'
    ).join('');
    $('voiceChannelList').innerHTML = channels.filter((c) => c.type === 'voice').map((c) => {
      const users = voiceMembers(c.id);
      const sharing = users.some((u) => u.sharing);
      return '<div><button class="channel-item ' + (state.selectedType === 'voice' && state.selectedChannelId === c.id ? 'active' : '') + '" data-voice="' + escapeHTML(c.id) + '"><i data-lucide="volume-2"></i><span>' + escapeHTML(c.name) + '</span>' + (sharing ? '<span class="live-tag">AO VIVO</span>' : '') + '</button>' +
        (users.length ? '<div class="voice-subusers">' + users.map((u) => '<div class="voice-subuser">' + avatar(u.name, 'mini-avatar') + '<span>' + escapeHTML(u.name) + (u.id === state.myPeerId ? ' (você)' : '') + '</span>' + (u.sharing ? ' 🔴' : '') + '</div>').join('') + '</div>' : '') + '</div>';
    }).join('');
    document.querySelectorAll('[data-text]').forEach((b) => b.addEventListener('click', () => selectChannel('text', b.dataset.text)));
    document.querySelectorAll('[data-voice]').forEach((b) => b.addEventListener('click', () => selectChannel('voice', b.dataset.voice)));
  }
  function renderHeader() {
    const channel = currentChannel();
    if (!channel) return;
    $('headerIcon').innerHTML = channel.type === 'text' ? '<i data-lucide="hash"></i>' : '<i data-lucide="volume-2"></i>';
    $('headerTitle').textContent = channel.name;
    $('headerDescription').textContent = channel.type === 'text' ? 'Converse com sua comunidade' : 'Áudio e transmissão de tela ao vivo';
    $('onlineCount').textContent = activeMembers().length + ' online';
    $('textView').classList.toggle('hidden', state.selectedType !== 'text');
    $('voiceView').classList.toggle('hidden', state.selectedType !== 'voice');
    $('messageInput').placeholder = 'Conversar em #' + channel.name;
    $('voiceHeading').textContent = channel.name;
  }
  function renderMessages() {
    if (state.selectedType !== 'text') return;
    const box = $('messages');
    const channel = currentChannel();
    const relevant = state.messages.filter((m) => m.channelId === channel.id);
    let content = '<div class="welcome-box"><span class="welcome-symbol"><i data-lucide="message-circle-more"></i></span><h2>Bem-vindo ao #' + escapeHTML(channel.name) + '!</h2><p>Este é o começo do canal. Chame seus amigos com o botão <strong>Convidar</strong> e comece uma conversa.</p></div>';
    relevant.forEach((m) => {
      const t = new Date(m.time || Date.now());
      const stamp = Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      content += '<div class="message-row">' + avatar(m.name, 'message-avatar') + '<div class="message-content"><div class="message-meta"><strong>' + escapeHTML(m.name) + '</strong><time>' + escapeHTML(stamp) + '</time></div><div class="message-body">' + escapeHTML(m.text) + '</div></div></div>';
    });
    box.innerHTML = content;
    box.scrollTop = box.scrollHeight;
    icons();
  }
  function renderMembers() {
    const members = activeMembers();
    $('memberCount').textContent = members.length;
    $('memberList').innerHTML = members.map((u) =>
      '<div class="member-item">' + avatar(u.name) + '<div class="member-data"><strong>' + escapeHTML(u.name) + (u.id === state.myPeerId ? ' (você)' : '') + '</strong><small>' + (u.sharing ? '🔴 Transmitindo' : (u.voiceChannelId ? '🔊 Em canal de voz' : '● Online')) + '</small></div></div>'
    ).join('');
    $('memberPanel').classList.toggle('show', state.showMembers);
  }
  function renderToolbar() {
    $('voiceStatus').classList.toggle('hidden', !state.voiceChannelId);
    $('voiceStatus').innerHTML = state.voiceChannelId ? '● Conectado ao canal <button id="voiceStatusLeave">Desconectar</button>' : '';
    const voiceLeaveLink = $('voiceStatusLeave');
    if (voiceLeaveLink) voiceLeaveLink.addEventListener('click', leaveVoice);
    if (state.selectedType !== 'voice') return;
    const joined = !!state.voiceChannelId && state.voiceChannelId === state.selectedChannelId;
    $('joinVoiceBtn').classList.toggle('hidden', joined);
    $('leaveVoiceBtn').classList.toggle('hidden', !joined);
    $('toggleMicBtn').disabled = !joined;
    $('shareScreenBtn').disabled = !joined;
    $('enableAudioBtn').classList.toggle('hidden', !joined);
    $('enableAudioBtn').innerHTML = state.playbackBlocked ? '<i data-lucide="volume-x"></i><span>Liberar áudio</span>' : '<i data-lucide="volume-2"></i><span>Testar som</span>';
    $('enableAudioBtn').classList.toggle('audio-blocked', state.playbackBlocked);
    $('toggleMicBtn').classList.toggle('active-mic', !!state.micStream);
    $('toggleMicBtn').innerHTML = state.micStream ? '<i data-lucide="mic"></i><span>Microfone ligado</span>' : '<i data-lucide="mic-off"></i><span>Ativar microfone</span>';
    $('shareScreenBtn').classList.toggle('streaming', !!state.screenStream);
    $('shareScreenBtn').innerHTML = state.screenStream ? '<i data-lucide="monitor-x"></i><span>Parar transmissão</span>' : '<i data-lucide="monitor-up"></i><span>Transmitir tela</span>';
    $('voiceCount').textContent = voiceMembers(state.selectedChannelId).length + ' participantes';
    $('participantTiles').innerHTML = voiceMembers(state.selectedChannelId).map((u) =>
      '<button class="participant-card" data-watch="' + escapeHTML(u.id) + '" title="' + (u.sharing ? 'Assistir à transmissão' : 'Participante') + '">' +
      avatar(u.name) + '<b>' + escapeHTML(u.name) + (u.id === state.myPeerId ? ' (você)' : '') + '</b>' +
      '<span>' + (u.sharing ? '🔴' : (u.mic ? '<i data-lucide="mic"></i>' : '<i data-lucide="mic-off"></i>')) + '</span></button>'
    ).join('');
    document.querySelectorAll('[data-watch]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.watch === state.myPeerId ? !!state.screenStream : state.remoteScreens.has(b.dataset.watch)) {
        state.selectedScreen = b.dataset.watch;
        state.stageKey = '';
        renderStage();
      } else if (state.voiceChannelId !== state.selectedChannelId) toast('Entre na sala para assistir à transmissão.');
      else toast('Este participante não está transmitindo uma tela.');
    }));
    icons();
  }
  function renderStage() {
    if (state.selectedType !== 'voice') return;
    const joined = state.voiceChannelId === state.selectedChannelId;
    let streams = [];
    if (joined) {
      if (state.screenStream) streams.push({ id: state.myPeerId, stream: state.screenStream, name: nickname, local: true });
      state.remoteScreens.forEach((stream, id) => {
        const user = state.members.get(id);
        if (user && user.voiceChannelId === state.selectedChannelId) streams.push({ id, stream, name: user.name, local: false });
      });
    }
    let chosen = streams.find((s) => s.id === state.selectedScreen);
    if (!chosen) chosen = streams.find((s) => !s.local) || streams[0];
    const key = chosen ? chosen.id + ':' + chosen.stream.id : joined ? 'joined' : 'unjoined';
    if (state.stageKey === key) return;
    state.stageKey = key;
    const stage = $('stage');
    if (!chosen) {
      stage.innerHTML = '<div class="stage-empty"><div class="stage-empty-icon"><i data-lucide="' + (joined ? 'monitor-play' : 'monitor-up') + '"></i></div><h2>' + (joined ? 'Nenhuma transmissão no momento' : 'Compartilhe seus melhores momentos') + '</h2><p>' + (joined ? 'Clique em “Transmitir tela” para começar, ou aguarde um amigo transmitir.' : 'Entre na sala para falar com seus amigos, assistir e transmitir a tela de verdade.') + '</p></div>';
    } else {
      stage.innerHTML = '<video class="stage-video" id="playingScreen" autoplay playsinline ' + (chosen.local ? 'muted' : '') + '></video>' +
        '<div class="video-label"><span class="live-badge">AO VIVO</span>' + escapeHTML(chosen.name) + (chosen.local ? ' (sua tela)' : '') + '</div>' +
        '<div class="stage-video-controls"><button id="fullscreenVideo" title="Tela cheia"><i data-lucide="maximize"></i></button></div>';
      const video = $('playingScreen');
      video.srcObject = chosen.stream;
      video.muted = chosen.local;
      video.play().catch(() => { if (!chosen.local) markPlaybackBlocked(); });
      $('fullscreenVideo').addEventListener('click', () => {
        if (video.requestFullscreen) video.requestFullscreen().catch(() => toast('Tela cheia indisponível neste navegador.'));
      });
    }
    icons();
  }
  function renderPresence() {
    renderServers();
    renderChannels();
    renderHeader();
    renderMembers();
    renderToolbar();
    renderStage();
    icons();
  }
  function renderAll() {
    renderPresence();
    renderMessages();
  }
  function selectChannel(type, id) {
    state.selectedType = type;
    state.selectedChannelId = id;
    state.stageKey = '';
    $('sidebar').classList.remove('mobile-open');
    renderAll();
  }

  function openDialog(html) {
    $('dialog').innerHTML = html;
    $('overlay').classList.remove('hidden');
    icons();
  }
  function closeDialog() {
    if (!nickname) return;
    $('overlay').classList.add('hidden');
    $('dialog').innerHTML = '';
  }
  function identityDialog(edit) {
    openDialog('<div class="dialog-logo"><i data-lucide="audio-lines"></i></div>' +
      '<h2>' + (edit ? 'Seu perfil' : 'Bem-vindo ao Discordo!') + '</h2>' +
      '<p>Um espaço para conversar, jogar e transmitir sua tela com quem você gosta.</p>' +
      '<form id="identityForm"><label class="field-label" for="identityName">COMO PODEMOS TE CHAMAR?</label><input id="identityName" maxlength="24" minlength="2" placeholder="Seu apelido" required value="' + escapeHTML(nickname) + '">' +
      '<button class="primary-action" type="submit">' + (edit ? 'Salvar nome' : 'Entrar no Discordo') + '</button></form>' +
      (edit ? '<button id="closeIdentity" class="secondary-action">Cancelar</button>' : ''));
    $('identityForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const next = $('identityName').value.trim().replace(/\s+/g, ' ').slice(0, 24);
      if (next.length < 2) return toast('Digite um apelido com pelo menos 2 caracteres.');
      nickname = next;
      save();
      closeDialog();
      updateSelf();
      renderAll();
      if (!state.peer) connectRoom();
    });
    if (edit) $('closeIdentity').addEventListener('click', closeDialog);
    $('identityName').focus();
  }
  function serverDialog() {
    openDialog('<button class="dialog-close" id="closeDialog" title="Fechar"><i data-lucide="x"></i></button>' +
      '<div class="dialog-logo"><i data-lucide="users-round"></i></div><h2>Uma comunidade, mil conversas.</h2><p>Crie seu próprio servidor ou participe de um usando o código de convite.</p>' +
      '<form id="createServerForm"><label class="field-label">CRIAR NOVO SERVIDOR</label><input id="newServerName" required minlength="2" maxlength="35" placeholder="Ex.: Galera da jogatina"><button class="primary-action">Criar servidor</button></form>' +
      '<div class="dialog-divider">OU</div><form id="joinServerForm"><label class="field-label">ENTRAR COM CÓDIGO</label><input id="joinServerCode" required maxlength="28" placeholder="Cole o código recebido"><button class="secondary-action">Entrar em servidor</button></form>');
    $('closeDialog').addEventListener('click', closeDialog);
    $('createServerForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const name = $('newServerName').value.trim().slice(0, 35);
      if (name.length < 2) return;
      const item = makeServer(name);
      servers.push(item); save(); closeDialog(); switchServer(item.id);
      toast('Servidor criado! Convide sua galera.');
    });
    $('joinServerForm').addEventListener('submit', (event) => {
      event.preventDefault();
      let id = $('joinServerCode').value.trim();
      try {
        const parsed = new URL(id);
        id = parsed.searchParams.get('room') || id;
      } catch (_) {}
      id = id.toLowerCase();
      if (!/^[a-z0-9-]{4,28}$/.test(id)) return toast('Código de convite inválido.');
      if (!servers.some((s) => s.id === id)) servers.push(makeServer('Sala de um amigo', id));
      save(); closeDialog(); switchServer(id);
    });
  }
  function inviteDialog() {
    const url = inviteURL();
    openDialog('<button id="closeDialog" class="dialog-close"><i data-lucide="x"></i></button>' +
      '<div class="dialog-logo"><i data-lucide="link"></i></div><h2>Convide a sua galera</h2><p>Quem abrir este link poderá participar do servidor, assistir às transmissões e conversar. Não compartilhe com desconhecidos.</p>' +
      '<label class="field-label">LINK DE CONVITE</label><div class="invite-code"><input id="inviteLink" readonly value="' + escapeHTML(url) + '"><button id="copyInvite">Copiar</button></div>' +
      '<label class="field-label">CÓDIGO DA SALA</label><div class="invite-code"><input readonly value="' + escapeHTML(selectedServerId) + '"><button id="copyCode">Copiar</button></div>');
    $('closeDialog').addEventListener('click', closeDialog);
    $('copyInvite').addEventListener('click', () => copyToClipboard(url, 'Link copiado!'));
    $('copyCode').addEventListener('click', () => copyToClipboard(selectedServerId, 'Código copiado!'));
  }
  async function copyToClipboard(value, message) {
    try {
      await navigator.clipboard.writeText(value);
      toast(message);
    } catch (_) {
      const input = $('inviteLink');
      if (input) input.select();
      toast('Não foi possível copiar automaticamente. Selecione e copie o texto.');
    }
  }
  function addChannelDialog(type) {
    openDialog('<button id="closeDialog" class="dialog-close"><i data-lucide="x"></i></button><div class="dialog-logo"><i data-lucide="' + (type === 'text' ? 'hash' : 'volume-2') + '"></i></div>' +
      '<h2>Novo canal de ' + (type === 'text' ? 'texto' : 'voz') + '</h2><p>Organize suas conversas e seus encontros em canais diferentes.</p>' +
      '<form id="newChannelForm"><label class="field-label">NOME DO CANAL</label><input id="newChannelName" maxlength="35" minlength="2" placeholder="' + (type === 'text' ? 'memes-e-clipes' : 'Sala de jogos') + '" required><button class="primary-action">Criar canal</button></form>');
    $('closeDialog').addEventListener('click', closeDialog);
    $('newChannelForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('newChannelName').value.trim().slice(0, 35);
      if (name.length < 2) return;
      const newChannel = { id: type + '-' + code().slice(0, 6), name: type === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name, type };
      if (state.isHost) {
        server().channels.push(newChannel); save();
        broadcast({ type: 'config', serverName: server().name, channels: server().channels });
        closeDialog(); selectChannel(type, newChannel.id);
      } else if (state.hostConnection && state.hostConnection.open) {
        state.hostConnection.send({ type: 'channel-add', channel: newChannel });
        closeDialog(); toast('Canal criado. Aguarde a atualização da sala.');
      } else toast('Aguarde a conexão com o servidor.');
    });
  }
  function addMessage(message) {
    if (!message || !message.id || state.messages.some((m) => m.id === message.id)) return;
    state.messages.push(message);
    if (state.messages.length > 300) state.messages.splice(0, state.messages.length - 300);
    saveChat();
    renderMessages();
  }
  function sendMessage(event) {
    event.preventDefault();
    const text = $('messageInput').value.trim().slice(0, 1200);
    if (!text) return;
    if (!state.connected) return toast('Aguarde a conexão com a sala.');
    const packet = { type: 'chat', channelId: state.selectedChannelId, text };
    if (state.isHost) handleChat(state.myPeerId, packet);
    else if (state.hostConnection && state.hostConnection.open) state.hostConnection.send(packet);
    else return toast('Sem conexão com a sala.');
    $('messageInput').value = '';
  }
  function handleChat(fromId, data) {
    const from = state.members.get(fromId);
    if (!from || typeof data.text !== 'string') return;
    const channel = server().channels.find((c) => c.id === data.channelId && c.type === 'text');
    if (!channel) return;
    const text = data.text.trim().slice(0, 1200);
    if (!text) return;
    const message = { id: code() + Date.now().toString(36), channelId: channel.id, name: from.name, text, time: Date.now() };
    addMessage(message);
    broadcast({ type: 'message', message });
  }

  function broadcast(packet) {
    state.guestConnections.forEach((conn) => {
      try { if (conn.open) conn.send(packet); } catch (_) {}
    });
  }
  function broadcastRoster() {
    broadcast({ type: 'roster', members: activeMembers() });
    renderPresence();
    reconcileOutgoing();
  }
  function receiveData(data, fromId) {
    if (!data || typeof data.type !== 'string') return;
    if (state.isHost) {
      const member = state.members.get(fromId);
      if (data.type === 'hello') {
        const conn = state.guestConnections.get(fromId);
        const name = String(data.name || 'Visitante').trim().slice(0, 24) || 'Visitante';
        state.members.set(fromId, { id: fromId, name, voiceChannelId: '', sharing: false, mic: false });
        if (conn && conn.open) conn.send({ type: 'snapshot', members: activeMembers(), channels: server().channels, serverName: server().name, messages: state.messages.slice(-150) });
        broadcastRoster();
      } else if (data.type === 'status' && member) {
        const validVoice = server().channels.some((c) => c.type === 'voice' && c.id === data.voiceChannelId);
        member.voiceChannelId = validVoice ? data.voiceChannelId : '';
        member.sharing = !!data.sharing && !!member.voiceChannelId;
        member.mic = !!data.mic && !!member.voiceChannelId;
        member.name = String(data.name || member.name).slice(0, 24);
        broadcastRoster();
      } else if (data.type === 'media-request' && member) routeMediaRequest(fromId, data);
      else if (data.type === 'chat' && member) handleChat(fromId, data);
      else if (data.type === 'channel-add' && member && data.channel) {
        const candidate = data.channel;
        const name = String(candidate.name || '').trim().slice(0, 35);
        if (name.length < 2 || !['text', 'voice'].includes(candidate.type) || server().channels.length >= 30) return;
        const channel = { id: candidate.type + '-' + code().slice(0, 6), name, type: candidate.type };
        server().channels.push(channel); save();
        broadcast({ type: 'config', serverName: server().name, channels: server().channels });
        renderChannels();
      }
    } else {
      if (data.type === 'snapshot') {
        state.connected = true;
        state.connecting = false;
        if (typeof data.serverName === 'string' && data.serverName.length <= 60) server().name = data.serverName;
        if (Array.isArray(data.channels)) applyChannels(data.channels);
        state.messages = Array.isArray(data.messages) ? data.messages.filter(validMessage).slice(-150) : [];
        save(); saveChat();
        applyRoster(data.members);
        updateSelf();
        renderAll();
        toast('Conectado à sala!');
      } else if (data.type === 'roster') applyRoster(data.members);
      else if (data.type === 'media-request' && typeof data.requesterId === 'string' && ['mic', 'screen'].includes(data.kind)) restartOutgoingTo(data.requesterId, data.kind);
      else if (data.type === 'message' && validMessage(data.message)) addMessage(data.message);
      else if (data.type === 'config') {
        if (typeof data.serverName === 'string') server().name = data.serverName.slice(0, 60);
        applyChannels(data.channels);
        save(); renderAll();
      }
    }
  }
  function validMessage(m) {
    return m && typeof m.id === 'string' && typeof m.channelId === 'string' && typeof m.text === 'string' && typeof m.name === 'string' && m.text.length <= 1200;
  }
  function applyChannels(channels) {
    if (!Array.isArray(channels)) return;
    const valid = channels.slice(0, 30).filter((c) => c && typeof c.id === 'string' && /^[a-zA-Z0-9-]{1,48}$/.test(c.id) && typeof c.name === 'string' && ['text', 'voice'].includes(c.type)).map((c) => ({ id: c.id, name: c.name.slice(0, 35), type: c.type }));
    if (valid.some((c) => c.type === 'text') && valid.some((c) => c.type === 'voice')) server().channels = valid;
    if (!server().channels.some((c) => c.id === state.selectedChannelId && c.type === state.selectedType)) {
      state.selectedType = 'text';
      state.selectedChannelId = server().channels.find((c) => c.type === 'text').id;
    }
  }
  function applyRoster(users) {
    if (!Array.isArray(users)) return;
    const next = new Map();
    users.slice(0, 50).forEach((u) => {
      if (u && typeof u.id === 'string' && typeof u.name === 'string') {
        next.set(u.id, { id: u.id, name: u.name.slice(0, 24), voiceChannelId: u.voiceChannelId || '', sharing: !!u.sharing, mic: !!u.mic });
      }
    });
    if (state.myPeerId) next.set(state.myPeerId, myParticipant());
    state.members = next;
    cleanupInactiveCalls();
    renderPresence();
    reconcileOutgoing();
    requestMissingMedia();
  }
  function cleanupInactiveCalls() {
    state.incoming.forEach((call, key) => {
      const u = state.members.get(call.peer);
      if (!u || !state.voiceChannelId || u.voiceChannelId !== state.voiceChannelId) {
        try { call.close(); } catch (_) {}
        removeIncoming(key, call);
      }
    });
    state.outgoing.forEach((call, key) => {
      const u = state.members.get(call.peer);
      if (!u || !state.voiceChannelId || u.voiceChannelId !== state.voiceChannelId) {
        try { call.close(); } catch (_) {}
        state.outgoing.delete(key);
      }
    });
  }
  function connectRoom() {
    if (!nickname) return identityDialog(false);
    cleanupNetwork();
    const generation = ++state.generation;
    state.connecting = true;
    state.messages = load('discordo-chat-' + selectedServerId, []);
    if (!Array.isArray(state.messages)) state.messages = [];
    state.members = new Map();
    renderAll();
    if (typeof window.Peer !== 'function') {
      state.connecting = false;
      toast('Não foi possível carregar a conexão WebRTC. Confira sua internet ou bloqueadores.');
      renderPresence();
      return;
    }
    const hostId = PEER_PREFIX + selectedServerId;
    const candidate = new Peer(hostId, { debug: 0 });
    state.peer = candidate;
    let hostHandled = false;
    candidate.on('open', (id) => {
      if (state.generation !== generation) return candidate.destroy();
      state.myPeerId = id;
      state.isHost = true;
      state.connected = true;
      state.connecting = false;
      state.members.set(id, myParticipant());
      bindPeerMedia(candidate, generation);
      renderAll();
    });
    candidate.on('error', (error) => {
      if (state.generation !== generation) return;
      if (error.type === 'unavailable-id' && !hostHandled) {
        hostHandled = true;
        try { candidate.destroy(); } catch (_) {}
        connectAsGuest(generation, hostId);
      } else {
        state.connecting = false;
        toast('Falha ao conectar: ' + (error.type || 'verifique sua conexão'));
        renderPresence();
      }
    });
    candidate.on('connection', (conn) => {
      if (state.generation !== generation || !state.isHost) return conn.close();
      attachGuestConnection(conn, generation);
    });
  }
  function bindPeerMedia(current, generation) {
    current.on('call', (call) => {
      if (state.generation !== generation) return call.close();
      answerCall(call);
    });
    current.on('disconnected', () => {
      if (state.generation !== generation) return;
      state.connected = false; renderPresence();
      toast('Conexão de sinalização interrompida. Tentando restabelecer...');
      try { current.reconnect(); } catch (_) {}
    });
  }
  function connectAsGuest(generation, hostId) {
    if (state.generation !== generation) return;
    const guest = new Peer(undefined, { debug: 0 });
    state.peer = guest;
    state.isHost = false;
    guest.on('open', (id) => {
      if (state.generation !== generation) return guest.destroy();
      state.myPeerId = id;
      state.members.set(id, myParticipant());
      bindPeerMedia(guest, generation);
      const conn = guest.connect(hostId, { reliable: true, serialization: 'json' });
      state.hostConnection = conn;
      conn.on('open', () => {
        if (state.generation !== generation) return conn.close();
        conn.send({ type: 'hello', name: nickname });
      });
      conn.on('data', (data) => {
        if (state.generation === generation) receiveData(data, hostId);
      });
      conn.on('close', () => {
        if (state.generation !== generation) return;
        state.connected = false;
        state.connecting = true;
        state.members.clear();
        state.members.set(state.myPeerId, myParticipant());
        state.remoteScreens.clear();
        state.stageKey = '';
        renderPresence();
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(() => {
          if (state.generation === generation) { toast('Reconectando à sala...'); connectRoom(); }
        }, 1700);
      });
      conn.on('error', () => {
        if (state.generation !== generation) return;
        toast('Falha na conexão com a sala. Verifique a rede.');
      });
    });
    guest.on('error', (error) => {
      if (state.generation !== generation) return;
      state.connecting = false;
      toast('Erro de conexão: ' + (error.type || 'indisponível'));
      renderPresence();
    });
  }
  function attachGuestConnection(conn, generation) {
    state.guestConnections.set(conn.peer, conn);
    conn.on('data', (data) => {
      if (state.generation === generation) receiveData(data, conn.peer);
    });
    conn.on('close', () => {
      if (state.generation !== generation) return;
      state.guestConnections.delete(conn.peer);
      state.members.delete(conn.peer);
      broadcastRoster();
    });
    conn.on('error', () => {
      state.guestConnections.delete(conn.peer);
      state.members.delete(conn.peer);
      broadcastRoster();
    });
  }
  function cleanupNetwork() {
    clearTimeout(state.reconnectTimer);
    stopScreen();
    stopMic();
    state.outgoing.forEach((call) => { try { call.close(); } catch (_) {} });
    state.incoming.forEach((call) => { try { call.close(); } catch (_) {} });
    state.remoteAudio.forEach((audio) => audio.remove());
    state.remoteAudio.clear();
    state.outgoing.clear();
    state.incoming.clear();
    state.remoteScreens.clear();
    clearInterval(state.mediaRetryTimer);
    state.mediaRetryTimer = null;
    state.mediaRequests.clear();
    state.playbackBlocked = false;
    state.guestConnections.forEach((conn) => { try { conn.close(); } catch (_) {} });
    state.guestConnections.clear();
    try { if (state.hostConnection) state.hostConnection.close(); } catch (_) {}
    try { if (state.peer) state.peer.destroy(); } catch (_) {}
    state.peer = null;
    state.hostConnection = null;
    state.myPeerId = '';
    state.members.clear();
    state.connected = false;
    state.connecting = false;
    state.isHost = false;
    state.voiceChannelId = '';
    state.selectedScreen = '';
    state.stageKey = '';
  }
  function switchServer(id) {
    if (!servers.some((s) => s.id === id)) return;
    state.generation++;
    cleanupNetwork();
    selectedServerId = id;
    state.selectedType = 'text';
    state.selectedChannelId = (server().channels.find((c) => c.type === 'text') || { id: 'geral' }).id;
    state.messages = load('discordo-chat-' + selectedServerId, []);
    if (!Array.isArray(state.messages)) state.messages = [];
    save(); persistURL();
    renderAll();
    connectRoom();
  }
  function joinVoice() {
    if (!state.connected) return toast('Aguarde a conexão antes de entrar na sala.');
    if (state.voiceChannelId === state.selectedChannelId) return;
    if (state.voiceChannelId) leaveVoice();
    state.voiceChannelId = state.selectedChannelId;
    state.stageKey = '';
    clearInterval(state.mediaRetryTimer);
    state.mediaRetryTimer = setInterval(requestMissingMedia, 7000);
    updateSelf();
    renderPresence();
    setTimeout(requestMissingMedia, 1600);
    toast('Você entrou no canal de voz.');
  }
  function leaveVoice() {
    clearInterval(state.mediaRetryTimer);
    state.mediaRetryTimer = null;
    state.mediaRequests.clear();
    stopScreen();
    stopMic();
    state.outgoing.forEach((call) => { try { call.close(); } catch (_) {} });
    state.incoming.forEach((call) => { try { call.close(); } catch (_) {} });
    state.outgoing.clear();
    state.incoming.clear();
    state.remoteScreens.clear();
    state.remoteAudio.forEach((audio) => audio.remove());
    state.remoteAudio.clear();
    state.voiceChannelId = '';
    state.selectedScreen = '';
    state.stageKey = '';
    state.playbackBlocked = false;
    updateSelf();
    renderPresence();
  }
  async function toggleMic() {
    if (!state.voiceChannelId) return;
    if (state.micStream) return stopMic();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Microfone indisponível neste navegador.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!state.voiceChannelId) { stream.getTracks().forEach((t) => t.stop()); return; }
      state.micStream = stream;
      stream.getAudioTracks().forEach((t) => { t.onended = () => stopMic(); });
      updateSelf();
    } catch (error) {
      toast(error.name === 'NotAllowedError' ? 'Autorize o microfone nas permissões do navegador.' : 'Não foi possível ativar o microfone.');
    }
  }
  function stopMic() {
    const stream = state.micStream;
    state.micStream = null;
    if (stream) stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    closeOutgoingKind('mic');
    updateSelf();
  }
  async function toggleScreen() {
    if (state.screenStream) return stopScreen();
    if (!state.voiceChannelId) return toast('Entre na sala de voz primeiro.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return toast('Compartilhamento não disponível neste navegador. Use Chrome ou Edge no computador.');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: true,
        surfaceSwitching: 'include',
        systemAudio: 'include'
      });
      if (!state.voiceChannelId) { stream.getTracks().forEach((t) => t.stop()); return; }
      state.screenStream = stream;
      state.selectedScreen = state.myPeerId;
      stream.getVideoTracks().forEach((t) => { t.onended = () => stopScreen(); });
      state.stageKey = '';
      updateSelf();
      toast('🔴 Sua tela está sendo transmitida!');
    } catch (error) {
      if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') toast('Não foi possível compartilhar a tela: ' + error.message);
    }
  }
  function stopScreen() {
    const stream = state.screenStream;
    state.screenStream = null;
    if (stream) stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    closeOutgoingKind('screen');
    if (state.selectedScreen === state.myPeerId) state.selectedScreen = '';
    state.stageKey = '';
    updateSelf();
  }
  function closeOutgoingKind(kind) {
    state.outgoing.forEach((call, key) => {
      if (key.endsWith(':' + kind)) {
        try { call.close(); } catch (_) {}
        state.outgoing.delete(key);
      }
    });
  }
  // Some callers start sharing before the receiver joins, or the network drops
  // the initial WebRTC offer. Request a fresh outgoing call from the sender.
  function requestMissingMedia() {
    if (!state.voiceChannelId || !state.connected) return;
    const now = Date.now();
    state.members.forEach((member) => {
      if (member.id === state.myPeerId || member.voiceChannelId !== state.voiceChannelId) return;
      for (const kind of ['mic', 'screen']) {
        if (!(kind === 'mic' ? member.mic : member.sharing)) continue;
        const key = member.id + ':' + kind;
        const received = kind === 'mic' ? state.remoteAudio.has(member.id) : state.remoteScreens.has(member.id);
        if (received || now - (state.mediaRequests.get(key) || 0) < 9000) continue;
        state.mediaRequests.set(key, now);
        const packet = { type: 'media-request', targetId: member.id, kind };
        if (state.isHost) routeMediaRequest(state.myPeerId, packet);
        else if (state.hostConnection && state.hostConnection.open) state.hostConnection.send(packet);
      }
    });
  }
  function routeMediaRequest(requesterId, packet) {
    if (!packet || !['mic', 'screen'].includes(packet.kind)) return;
    const requester = state.members.get(requesterId);
    const target = state.members.get(packet.targetId);
    if (!requester || !target || requester.id === target.id ||
        !requester.voiceChannelId || requester.voiceChannelId !== target.voiceChannelId) return;
    if (!(packet.kind === 'mic' ? target.mic : target.sharing)) return;
    if (packet.targetId === state.myPeerId) restartOutgoingTo(requesterId, packet.kind);
    else {
      const conn = state.guestConnections.get(packet.targetId);
      if (conn && conn.open) conn.send({ type: 'media-request', requesterId, kind: packet.kind });
    }
  }
  function restartOutgoingTo(peerId, kind) {
    if (!state.peer || !state.peer.open || !state.voiceChannelId) return;
    const target = state.members.get(peerId);
    if (!target || target.voiceChannelId !== state.voiceChannelId) return;
    const stream = kind === 'mic' ? state.micStream : state.screenStream;
    if (!stream || !stream.active && stream.getTracks().every((t) => t.readyState === 'ended')) return;
    const key = peerId + ':' + kind;
    const previous = state.outgoing.get(key);
    if (previous) {
      state.outgoing.delete(key);
      try { previous.close(); } catch (_) {}
    }
    startOutgoing(peerId, kind, stream);
  }
  function markPlaybackBlocked() {
    if (state.playbackBlocked) return;
    state.playbackBlocked = true;
    renderToolbar();
    toast('Seu navegador bloqueou o som. Clique em "Liberar áudio" na sala.');
  }
  function unlockPlayback() {
    // Called from a user click. Re-triggering play satisfies autoplay policies.
    const promises = [];
    state.remoteAudio.forEach((audio) => {
      audio.muted = false;
      audio.volume = 1;
      promises.push(audio.play().catch(() => {}));
    });
    const video = $('playingScreen');
    if (video && video.srcObject && !video.muted) promises.push(video.play().catch(() => {}));
    state.playbackBlocked = false;
    renderToolbar();
    Promise.all(promises).then(() => {
      toast(state.remoteAudio.size ? 'Áudio liberado. Confira também o volume do Windows.' :
        'Som habilitado. Quando alguém ligar o microfone, você poderá ouvir.');
    });
  }
  function reconcileOutgoing() {
    if (!state.peer || !state.peer.open || !state.voiceChannelId) return;
    state.members.forEach((user, id) => {
      if (id === state.myPeerId || user.voiceChannelId !== state.voiceChannelId) return;
      if (state.screenStream) startOutgoing(id, 'screen', state.screenStream);
      if (state.micStream) startOutgoing(id, 'mic', state.micStream);
    });
    cleanupInactiveCalls();
  }
  function startOutgoing(id, kind, stream) {
    const key = id + ':' + kind;
    if (state.outgoing.has(key)) return;
    try {
      const call = state.peer.call(id, stream, { metadata: { kind, voiceChannelId: state.voiceChannelId } });
      if (!call) return;
      state.outgoing.set(key, call);
      call.on('close', () => { if (state.outgoing.get(key) === call) state.outgoing.delete(key); });
      call.on('error', () => { if (state.outgoing.get(key) === call) state.outgoing.delete(key); });
    } catch (_) {}
  }
  function answerCall(call) {
    const kind = call.metadata && call.metadata.kind;
    const room = call.metadata && call.metadata.voiceChannelId;
    if (!['screen', 'mic'].includes(kind) || !state.voiceChannelId || room !== state.voiceChannelId || call.peer === state.myPeerId) return call.close();
    const key = call.peer + ':' + kind;
    const previous = state.incoming.get(key);
    if (previous) { try { previous.close(); } catch (_) {} }
    state.incoming.set(key, call);
    call.on('stream', (stream) => {
      if (state.incoming.get(key) !== call) return;
      if (kind === 'screen') {
        state.remoteScreens.set(call.peer, stream);
        state.mediaRequests.delete(call.peer + ':screen');
        state.stageKey = '';
        renderStage();
        renderToolbar();
      } else {
        let audio = state.remoteAudio.get(call.peer);
        if (audio) audio.remove();
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.srcObject = stream;
        audio.dataset.peer = call.peer;
        document.body.appendChild(audio);
        audio.play().catch(() => markPlaybackBlocked());
        state.remoteAudio.set(call.peer, audio);
        state.mediaRequests.delete(call.peer + ':mic');
      }
    });
    call.on('close', () => removeIncoming(key, call));
    call.on('error', () => removeIncoming(key, call));
    try { call.answer(); } catch (_) { removeIncoming(key, call); }
  }
  function removeIncoming(key, call) {
    if (state.incoming.get(key) !== call) return;
    state.incoming.delete(key);
    if (key.endsWith(':screen')) {
      state.remoteScreens.delete(call.peer);
      if (state.selectedScreen === call.peer) state.selectedScreen = '';
      state.stageKey = '';
      renderStage();
    } else {
      const audio = state.remoteAudio.get(call.peer);
      if (audio) audio.remove();
      state.remoteAudio.delete(call.peer);
    }
  }

  $('createServerBtn').addEventListener('click', serverDialog);
  $('serverHeader').addEventListener('click', inviteDialog);
  $('inviteBtn').addEventListener('click', inviteDialog);
  $('renameBtn').addEventListener('click', () => identityDialog(true));
  $('addTextBtn').addEventListener('click', () => addChannelDialog('text'));
  $('addVoiceBtn').addEventListener('click', () => addChannelDialog('voice'));
  $('messageForm').addEventListener('submit', sendMessage);
  $('chatHintBtn').addEventListener('click', () => $('messageInput').focus());
  $('joinVoiceBtn').addEventListener('click', joinVoice);
  $('leaveVoiceBtn').addEventListener('click', leaveVoice);
  $('toggleMicBtn').addEventListener('click', toggleMic);
  $('shareScreenBtn').addEventListener('click', toggleScreen);
  $('enableAudioBtn').addEventListener('click', unlockPlayback);
  $('membersBtn').addEventListener('click', () => {
    state.showMembers = !state.showMembers;
    renderMembers();
  });
  $('mobileMenu').addEventListener('click', () => $('sidebar').classList.toggle('mobile-open'));
  $('homeBtn').addEventListener('click', () => selectChannel('text', server().channels.find((c) => c.type === 'text').id));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('overlay').classList.contains('hidden') && nickname) closeDialog();
  });
  window.addEventListener('pagehide', () => {
    if (state.screenStream) state.screenStream.getTracks().forEach((t) => t.stop());
    if (state.micStream) state.micStream.getTracks().forEach((t) => t.stop());
  });
  save();
  persistURL();
  renderAll();
  if (nickname) connectRoom();
  else identityDialog(false);
})();