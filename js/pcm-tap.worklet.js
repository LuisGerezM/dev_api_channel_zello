// pcm-tap.worklet.js — AudioWorklet que entrega el PCM del micrófono en bloques de 20 ms.
// Corre en el hilo de audio; se carga desde audio.js con audioWorklet.addModule().

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 50); // 20 ms
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          // Se transfiere el buffer (sin copia); después de esto queda vacío y se crea otro.
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
