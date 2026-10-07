// app.js — Interfaz de la consola PTT: formulario de conexión, canales, botón PTT y log.

import { ZelloClient } from './zello-client.js';
import { isWebCodecsSupported } from './audio.js';

const PREFS_KEY = 'zello-poc';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const MAX_LOG_LINES = 1000;

const $ = id => document.getElementById(id);

const client = new ZelloClient();
let selected = null;
let loggedIn = false;

// ---------------------------------------------------------------------------
// Configuración inicial. Prioridad (de menor a mayor):
//   preferencias guardadas < parámetros de la URL < config.local.js (solo en localhost)
// La clave nunca se guarda en el navegador ni se acepta por URL.
// ---------------------------------------------------------------------------
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePrefs({ network, username, channels }) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ network, username, channels }));
  } catch {
    /* almacenamiento no disponible (modo privado, etc.) */
  }
}

// Permite compartir un link con los datos precargados: ?network=…&username=…&channel=…&channel=…
function urlParams() {
  const q = new URLSearchParams(location.search);
  const out = {};
  if (q.get('network')) out.network = q.get('network');
  if (q.get('username')) out.username = q.get('username');
  if (q.getAll('channel').length) out.channels = q.getAll('channel');
  return out;
}

// config.local.js es opcional y no se sube al repo: solo se intenta cargar al desarrollar en local.
async function loadLocalConfig() {
  if (!LOCAL_HOSTS.includes(location.hostname)) return {};
  try {
    await import('../config.local.js');
  } catch {
    return {};
  }
  return window.ZELLO_CONFIG || {};
}

const cfg = { ...loadPrefs(), ...urlParams(), ...(await loadLocalConfig()) };
$('network').value = cfg.network || '';
$('username').value = cfg.username || '';
$('password').value = cfg.password || '';
$('channelsIn').value = (cfg.channels || []).join('\n');

function checkBrowser() {
  let msg = '';
  if (!window.isSecureContext) msg = 'La página tiene que abrirse por https o desde localhost para usar el micrófono.';
  else if (!isWebCodecsSupported()) msg = 'Este navegador no soporta WebCodecs. Usá Chrome o Edge actualizados.';
  $('browserWarning').textContent = msg;
  $('browserWarning').hidden = !msg;
}
checkBrowser();

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
function log(level, msg) {
  if ((level === 'tx' || level === 'rx') && !$('showJson').checked) return;
  const box = $('log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 20;
  const line = document.createElement('div');
  line.className = level;
  const arrow = level === 'tx' ? '→ ' : level === 'rx' ? '← ' : '';
  line.textContent = `${new Date().toLocaleTimeString()}  ${arrow}${msg}`;
  box.append(line);
  while (box.childElementCount > MAX_LOG_LINES) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

$('clearLog').addEventListener('click', () => {
  $('log').textContent = '';
});

// ---------------------------------------------------------------------------
// Estado y canales
// ---------------------------------------------------------------------------
function setState(text, cls = '') {
  $('state').textContent = text;
  $('state').className = `badge ${cls}`.trim();
}

function setConnecting(busy) {
  $('connect').disabled = busy;
  $('disconnect').disabled = !busy;
  for (const id of ['network', 'username', 'password', 'channelsIn']) $(id).disabled = busy;
}

function parseChannels() {
  return $('channelsIn')
    .value.split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

function refreshControls() {
  const ch = selected && client.channels.get(selected);
  const ready = loggedIn && ch?.status === 'online';
  $('ptt').disabled = !ready;
  $('target').textContent = selected ? `Canal: ${selected}${ready ? '' : ' (no disponible)'}` : 'Elegí un canal';
}

function selectChannel(name) {
  selected = name;
  renderChannels();
  refreshControls();
}

function channelMeta(st) {
  if (!st) return '…';
  return st.status === 'online' ? `${st.users_online ?? '?'} en línea` : st.status;
}

function renderChannels() {
  const names = parseChannels();
  const ul = $('channels');
  ul.textContent = '';
  if (!names.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'Sin canales';
    ul.append(li);
    return;
  }
  for (const name of names) {
    const st = client.channels.get(name);
    const li = document.createElement('li');
    li.tabIndex = 0;
    if (name === selected) {
      li.className = 'sel';
      li.setAttribute('aria-current', 'true');
    }
    const dot = document.createElement('span');
    dot.className = `dot ${st?.status ?? ''}`.trim();
    const label = document.createElement('span');
    label.textContent = name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = channelMeta(st);
    li.append(dot, label, meta);
    li.addEventListener('click', () => selectChannel(name));
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter') selectChannel(name);
    });
    ul.append(li);
  }
}

// ---------------------------------------------------------------------------
// Eventos del cliente
// ---------------------------------------------------------------------------
client.addEventListener('log', e => log(e.detail.level, e.detail.msg));

client.addEventListener('connected', () => setState('conectando…', 'retry'));

client.addEventListener('logged-in', () => {
  loggedIn = true;
  setState(`en línea — ${client.cfg.username}`, 'on');
  refreshControls();
});

client.addEventListener('disconnected', e => {
  loggedIn = false;
  const { willRetry } = e.detail;
  setState(willRetry ? 'reconectando…' : 'desconectado', willRetry ? 'retry' : '');
  if (!willRetry) setConnecting(false);
  renderChannels();
  refreshControls();
});

client.addEventListener('channel-status', () => {
  // Al primer canal que queda en línea lo seleccionamos solos.
  selected ??= parseChannels().find(n => client.channels.get(n)?.status === 'online') ?? null;
  renderChannels();
  refreshControls();
});

client.addEventListener('stream-start', e => {
  const m = e.detail;
  $('rx').textContent = `🔊 ${m.from} → ${m.channel}${m.for ? ` (privado a ${m.for})` : ''}`;
  log('ok', `Recibiendo audio de ${m.from} en "${m.channel}"`);
});

client.addEventListener('stream-stop', () => {
  $('rx').textContent = '';
});

client.addEventListener('text', e => log('ok', `💬 ${e.detail.from} @ ${e.detail.channel}: ${e.detail.text}`));

client.addEventListener('location', e => log('ok', `📍 ${e.detail.from}: ${e.detail.latitude}, ${e.detail.longitude}`));

client.addEventListener('tx-state', e => {
  $('ptt').classList.toggle('talking', e.detail.talking);
  $('ptt').setAttribute('aria-pressed', String(e.detail.talking));
});

// ---------------------------------------------------------------------------
// Conectar / desconectar
// ---------------------------------------------------------------------------
$('connectForm').addEventListener('submit', async e => {
  e.preventDefault();
  const c = {
    network: $('network').value.trim(),
    username: $('username').value.trim(),
    password: $('password').value,
    channels: parseChannels(),
  };
  if (!c.network || !c.username || !c.password || !c.channels.length) {
    log('error', 'Completá red, usuario, clave y al menos un canal.');
    return;
  }
  savePrefs(c);
  if (selected && !c.channels.includes(selected)) selected = null;
  setConnecting(true);
  renderChannels();
  try {
    await client.connect(c);
  } catch (err) {
    log('error', err.message);
    setConnecting(false);
  }
});

$('disconnect').addEventListener('click', () => client.disconnect());

// ---------------------------------------------------------------------------
// Push-to-talk (botón o barra espaciadora)
// ---------------------------------------------------------------------------
let holding = false;

function pttDown() {
  if (holding || $('ptt').disabled) return;
  holding = true;
  client.startTalking(selected, $('forUser').value.trim() || undefined).catch(err => log('error', err.message));
}

function pttUp() {
  if (!holding) return;
  holding = false;
  client.stopTalking();
}

$('ptt').addEventListener('pointerdown', e => {
  $('ptt').setPointerCapture(e.pointerId);
  pttDown();
});
$('ptt').addEventListener('pointerup', pttUp);
$('ptt').addEventListener('pointercancel', pttUp);
window.addEventListener('blur', pttUp);

const isTyping = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

window.addEventListener('keydown', e => {
  if (e.code !== 'Space' || isTyping()) return;
  e.preventDefault();
  if (!e.repeat) pttDown();
});

window.addEventListener('keyup', e => {
  if (e.code !== 'Space' || isTyping()) return;
  e.preventDefault();
  pttUp();
});

renderChannels();
