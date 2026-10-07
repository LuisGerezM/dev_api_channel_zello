// audio.js — Captura del micrófono y reproducción de streams entrantes.
// Audio: Opus vía WebCodecs (AudioEncoder / AudioDecoder). Requiere Chrome/Edge reciente
// y un contexto seguro (https o http://localhost).

export const FRAME_MS = 60;       // duración de cada paquete Opus (igual que las apps Zello)
export const JITTER_S = 0.15;     // buffer de reproducción para que el audio entrante sea fluido
const PREFERRED_RATE = 16000;     // frecuencia que usan las apps Zello

const WORKLET_URL = new URL('./pcm-tap.worklet.js', import.meta.url);

// codec_header: {sample_rate_hz(16 LE), frames_per_packet(8), frame_size_ms(8)} en base64
export function encodeCodecHeader(sampleRate, framesPerPacket, frameMs) {
  const b = new Uint8Array([sampleRate & 0xff, sampleRate >> 8, framesPerPacket, frameMs]);
  return btoa(String.fromCharCode(...b));
}

export function decodeCodecHeader(b64) {
  const b = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return { sampleRate: b[0] | (b[1] << 8), framesPerPacket: b[2], frameMs: b[3] };
}

export function isWebCodecsSupported() {
  return 'AudioEncoder' in window && 'AudioDecoder' in window;
}

// ---------------------------------------------------------------------------
// Micrófono: captura PCM mono vía AudioWorklet
// ---------------------------------------------------------------------------
export class Microphone {
  constructor() {
    this.onpcm = null;
    this.sampleRate = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // Si el navegador no puede remuestrear el mic a 16 kHz, usamos la frecuencia nativa.
    try {
      this.ctx = new AudioContext({ sampleRate: PREFERRED_RATE });
      this.source = this.ctx.createMediaStreamSource(this.stream);
    } catch {
      this.ctx?.close();
      this.ctx = new AudioContext();
      this.source = this.ctx.createMediaStreamSource(this.stream);
    }
    this.sampleRate = this.ctx.sampleRate;
    await this.ctx.audioWorklet.addModule(WORKLET_URL);
    const tap = new AudioWorkletNode(this.ctx, 'pcm-tap');
    tap.port.onmessage = e => this.onpcm?.(e.data);
    const mute = this.ctx.createGain();
    mute.gain.value = 0; // conectado a destination solo para que el grafo se procese
    this.source.connect(tap).connect(mute).connect(this.ctx.destination);
  }

  stop() {
    this.onpcm = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
  }
}

// ---------------------------------------------------------------------------
// Reproducción de un stream entrante (con jitter buffer)
// ---------------------------------------------------------------------------
export class IncomingStream {
  constructor(ctx, info, onError) {
    this.ctx = ctx;
    this.info = info;
    this.header = decodeCodecHeader(info.codec_header);
    this.packetUs = (info.packet_duration || this.header.frameMs * this.header.framesPerPacket) * 1000;
    this.ts = 0;
    this.nextTime = 0;
    this.decoder = new AudioDecoder({
      output: data => this._play(data),
      error: e => onError(e),
    });
    this.decoder.configure({ codec: 'opus', sampleRate: this.header.sampleRate, numberOfChannels: 1 });
  }

  push(opus) {
    if (this.decoder.state !== 'configured') return;
    this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.ts, data: opus }));
    this.ts += this.packetUs;
  }

  _play(data) {
    const n = data.numberOfFrames;
    const pcm = new Float32Array(n);
    data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
    const buf = this.ctx.createBuffer(1, n, data.sampleRate);
    buf.copyToChannel(pcm, 0);
    data.close();
    // Si nos quedamos sin audio en cola (inicio o hueco de red), re-armamos el buffer.
    if (this.nextTime < this.ctx.currentTime) this.nextTime = this.ctx.currentTime + JITTER_S;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.start(this.nextTime);
    this.nextTime += buf.duration;
  }

  close() {
    if (this.decoder.state !== 'configured') return;
    this.decoder.flush().catch(() => {}).finally(() => {
      if (this.decoder.state !== 'closed') this.decoder.close();
    });
  }
}
