// zello-client.js — Cliente mínimo de la Zello Channel API para navegador.
// Spec: https://github.com/zelloptt/zello-channel-api/blob/main/API.md
//
// Eventos (CustomEvent, datos en e.detail):
//   log {level, msg}, connected, logged-in, disconnected {code, reason, willRetry},
//   channel-status {...}, stream-start {...}, stream-stop {...}, text {...}, location {...},
//   tx-state {talking}

import { ZelloError, ConnectionError } from './errors.js';
import {
  FRAME_MS, Microphone, IncomingStream, encodeCodecHeader, isWebCodecsSupported,
} from './audio.js';

const WS_BASE = 'wss://zellowork.io/ws/';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRY_DELAY_MS = 30000;
const OPUS_BITRATE = 24000;

const PACKET_AUDIO = 0x01; // 0x02 = imagen, no soportado

export class ZelloClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.cfg = null;
    this.seq = 0;
    this.pending = new Map();
    this.incoming = new Map();
    this.channels = new Map();
    this.tx = null;
    this.mic = null;
    this.playCtx = null;
    this.autoReconnect = false;
    this.retries = 0;
    this.retryTimer = null;

    // Si se cae la red, el WebSocket no se entera hasta que vence un timeout (pueden ser minutos).
    // El navegador sí avisa al toque cuando la PC pierde la red: cortamos nosotros y reconectamos al volver.
    window.addEventListener('offline', () => this._drop('Sin red (el navegador avisó offline)'));
    window.addEventListener('online', () => {
      if (!this.autoReconnect || (this.ws && !this.ws.dead)) return;
      this._log('info', 'Volvió la red, reconectando …');
      clearTimeout(this.retryTimer);
      this.retries = 0;
      this._open();
    });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN && !this.ws.dead;
  }

  // Debe llamarse desde un gesto del usuario (click) por las políticas de audio del navegador.
  async connect(cfg) {
    if (!isWebCodecsSupported()) {
      throw new Error('Este navegador no soporta WebCodecs (AudioEncoder/AudioDecoder). Usá Chrome o Edge.');
    }
    const support = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    if (!support.supported) throw new Error('El navegador no puede codificar Opus.');

    this.cfg = { ...cfg };
    this.playCtx ??= new AudioContext();
    await this.playCtx.resume();
    if (!this.mic) {
      const mic = new Microphone();
      await mic.start();
      this.mic = mic;
      this._log('info', `Micrófono listo (${mic.sampleRate} Hz)`);
    }
    this.autoReconnect = true;
    this.retries = 0;
    this._open();
  }

  disconnect() {
    this.autoReconnect = false;
    clearTimeout(this.retryTimer);
    // Si la conexión ya estaba caída (esperando reintento o red), avisamos acá porque no va a llegar otro onclose.
    if (!this.ws || this.ws.dead) {
      this._releaseMic();
      this._emit('disconnected', { code: 1000, reason: 'bye', willRetry: false });
    } else {
      this.ws.close(1000, 'bye');
    }
  }

  // ------------------------------ conexión ---------------------------------
  _open() {
    const url = WS_BASE + encodeURIComponent(this.cfg.network);
    this._log('info', `Conectando a ${url} …`);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = async () => {
      this._emit('connected');
      const { username, password, channels } = this.cfg;
      try {
        await this._request({ command: 'logon', username, password, channels });
        this.retries = 0;
        this._log('ok', `Logon OK como ${username}`);
        this._emit('logged-in');
      } catch (e) {
        this._log('error', `Logon falló: ${e.message}`);
        // Un rechazo del logon (credenciales, canal, permisos) no se arregla reintentando.
        if (!e.transient) this.autoReconnect = false;
        ws.close();
      }
    };

    ws.onmessage = ev => {
      if (typeof ev.data === 'string') this._onJson(ev.data);
      else this._onBinary(ev.data);
    };

    ws.onerror = () => this._log('error', 'Error de WebSocket (ver consola del navegador).');

    ws.onclose = ev => this._teardown(ws, ev.code, ev.reason);
  }

  // Cierra a la fuerza la conexión actual sin esperar al navegador (ver listener 'offline').
  _drop(reason) {
    const ws = this.ws;
    if (!ws || ws.dead) return;
    this._log('warn', reason);
    try { ws.close(); } catch { /* ya cerrado */ }
    this._teardown(ws, 4000, reason);
  }

  _teardown(ws, code, reason) {
    if (this.ws !== ws || ws.dead) return; // ya se procesó (p. ej. por _drop)
    ws.dead = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ConnectionError('Conexión cerrada'));
    }
    this.pending.clear();
    for (const s of this.incoming.values()) s.close();
    this.incoming.clear();
    this._abortTx();
    this.channels.clear();

    const willRetry = this.autoReconnect;
    this._emit('disconnected', { code, reason, willRetry });
    this._log(willRetry ? 'warn' : 'info', `Desconectado (code ${code}${reason ? ', ' + reason : ''})`);
    if (!willRetry) {
      this._releaseMic();
      return;
    }
    if (!navigator.onLine) {
      this._log('info', 'Esperando a que vuelva la red …'); // el listener 'online' reconecta
      return;
    }
    const delay = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** this.retries++);
    this._log('info', `Reintentando en ${delay / 1000}s …`);
    this.retryTimer = setTimeout(() => this._open(), delay);
  }

  _releaseMic() {
    this.mic?.stop();
    this.mic = null;
  }

  _request(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new ConnectionError('No conectado'));
      const seq = ++this.seq;
      const msg = { ...cmd, seq };
      const timer = setTimeout(() => {
        if (this.pending.delete(seq)) reject(new ConnectionError(`Timeout esperando respuesta a ${cmd.command}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(seq, { resolve, reject, timer });
      this._log('tx', JSON.stringify({ ...msg, password: msg.password ? '***' : undefined }));
      this.ws.send(JSON.stringify(msg));
    });
  }

  // ------------------------------ entrada ----------------------------------
  _onJson(text) {
    let m;
    try { m = JSON.parse(text); } catch { return this._log('error', `JSON inválido recibido: ${text}`); }
    this._log('rx', text);

    if (m.seq && this.pending.has(m.seq)) {
      const p = this.pending.get(m.seq);
      this.pending.delete(m.seq);
      clearTimeout(p.timer);
      if (m.success) p.resolve(m);
      else p.reject(new ZelloError(m.error || 'respuesta sin success'));
      return;
    }

    switch (m.command) {
      case 'on_channel_status':
        this.channels.set(m.channel, m);
        if (m.error) this._log('error', `Canal "${m.channel}": ${m.error}${m.error_type ? ' (' + m.error_type + ')' : ''}`);
        this._emit('channel-status', m);
        break;
      case 'on_stream_start':
        if (m.type && m.type !== 'audio') break;
        try {
          this.incoming.set(m.stream_id, new IncomingStream(this.playCtx, m,
            e => this._log('error', `Decoder stream ${m.stream_id}: ${e.message}`)));
        } catch (e) {
          this._log('error', `No se pudo abrir el decoder: ${e.message}`);
        }
        this._emit('stream-start', m);
        break;
      case 'on_stream_stop':
        this.incoming.get(m.stream_id)?.close();
        this.incoming.delete(m.stream_id);
        this._emit('stream-stop', m);
        break;
      case 'on_text_message':
        this._emit('text', m);
        break;
      case 'on_location':
        this._emit('location', m);
        break;
      case 'on_error':
        this._log('error', `on_error: ${new ZelloError(m.error).message}`);
        break;
      default:
        break;
    }
  }

  // Paquete binario: {type(8) = 0x01, stream_id(32 BE), packet_id(32 BE), opus...}
  _onBinary(buf) {
    if (buf.byteLength < 9) return;
    const dv = new DataView(buf);
    if (dv.getUint8(0) !== PACKET_AUDIO) return;
    const s = this.incoming.get(dv.getUint32(1));
    if (s) s.push(new Uint8Array(buf, 9));
  }

  // ------------------------------- PTT -------------------------------------
  async startTalking(channel, forUser) {
    if (this.tx) return;
    if (!this.mic) throw new Error('Micrófono no inicializado');
    const sampleRate = this.mic.sampleRate;
    const tx = { channel, streamId: null, packetId: 0, queue: [], stopped: false, ts: 0 };
    this.tx = tx;

    tx.encoder = new AudioEncoder({
      output: chunk => {
        const opus = new Uint8Array(chunk.byteLength);
        chunk.copyTo(opus);
        // Lo que se graba antes de que Zello confirme el stream se encola, para no perder el inicio de la frase.
        if (tx.streamId === null) tx.queue.push(opus);
        else this._sendAudio(tx, opus);
      },
      error: e => this._log('error', `Encoder: ${e.message}`),
    });
    tx.encoder.configure({
      codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: OPUS_BITRATE,
      opus: { frameDuration: FRAME_MS * 1000, application: 'voip' },
    });

    this.mic.onpcm = pcm => {
      if (tx.encoder.state !== 'configured') return;
      const data = new AudioData({
        format: 'f32-planar', sampleRate, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: tx.ts, data: pcm,
      });
      tx.ts += (pcm.length / sampleRate) * 1e6;
      tx.encoder.encode(data);
      data.close();
    };
    this._emit('tx-state', { talking: true, channel, forUser });

    const cmd = {
      command: 'start_stream', channel, type: 'audio', codec: 'opus',
      codec_header: encodeCodecHeader(sampleRate, 1, FRAME_MS), packet_duration: FRAME_MS,
    };
    if (forUser) cmd.for = forUser;

    try {
      const r = await this._request(cmd);
      if (this.tx !== tx) return; // se abortó mientras esperábamos (p. ej. corte de conexión)
      tx.streamId = r.stream_id;
      for (const opus of tx.queue) this._sendAudio(tx, opus);
      tx.queue = [];
      if (tx.stopped) await this._finishTx(tx); // soltaron el botón antes de que llegara el stream_id
    } catch (e) {
      this._log('error', `start_stream falló: ${e.message}`);
      if (this.tx === tx) this._abortTx();
    }
  }

  async stopTalking() {
    const tx = this.tx;
    if (!tx || tx.stopped) return;
    tx.stopped = true;
    if (this.mic) this.mic.onpcm = null;
    if (tx.streamId !== null) await this._finishTx(tx);
  }

  async _finishTx(tx) {
    try { await tx.encoder.flush(); } catch { /* encoder ya cerrado */ }
    if (tx.encoder.state !== 'closed') tx.encoder.close();
    try {
      await this._request({ command: 'stop_stream', stream_id: tx.streamId, channel: tx.channel });
    } catch (e) {
      this._log('error', `stop_stream falló: ${e.message}`);
    }
    this._log('info', `Transmisión terminada (${tx.packetId} paquetes, ${(tx.packetId * FRAME_MS / 1000).toFixed(1)}s)`);
    if (this.tx === tx) this.tx = null;
    this._emit('tx-state', { talking: false });
  }

  _abortTx() {
    const tx = this.tx;
    if (!tx) return;
    if (this.mic) this.mic.onpcm = null;
    if (tx.encoder.state !== 'closed') tx.encoder.close();
    this.tx = null;
    this._emit('tx-state', { talking: false });
  }

  _sendAudio(tx, opus) {
    if (!this.connected) return;
    const pkt = new Uint8Array(9 + opus.length);
    const dv = new DataView(pkt.buffer);
    dv.setUint8(0, PACKET_AUDIO);
    dv.setUint32(1, tx.streamId);    // big-endian
    dv.setUint32(5, tx.packetId++);
    pkt.set(opus, 9);
    this.ws.send(pkt);
  }

  // ------------------------------ texto ------------------------------------
  sendText(channel, text, forUser) {
    const cmd = { command: 'send_text_message', channel, text };
    if (forUser) cmd.for = forUser;
    return this._request(cmd);
  }

  // ------------------------------ util -------------------------------------
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _log(level, msg) { this._emit('log', { level, msg }); }
}
