// sound.js — a procedural wind bed (filtered noise, slowly wandering), no
// audio files. Off by default; M toggles. Created lazily because an
// AudioContext needs a user gesture anyway.

export function createSound() {
  let ctx = null;
  let master = null;
  let on = false;

  function build() {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 420;
    lowpass.Q.value = 0.6;

    // slow gusts: an LFO wandering the filter cutoff
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain);
    lfoGain.connect(lowpass.frequency);

    src.connect(lowpass);
    lowpass.connect(master);
    src.start();
    lfo.start();
  }

  return {
    get on() {
      return on;
    },
    toggle() {
      if (!ctx) build();
      if (ctx.state === "suspended") ctx.resume();
      on = !on;
      master.gain.setTargetAtTime(on ? 0.045 : 0, ctx.currentTime, 0.4);
      return on;
    },
  };
}
