const fs = require("fs");
const path = require("path");

function generateWav(frequencyStart, frequencyEnd, durationMs, volume = 0.25) {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * (durationMs / 1000));
  const buffer = Buffer.alloc(44 + numSamples * 2);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20);  // AudioFormat (PCM)
  buffer.writeUInt16LE(1, 22);  // Mono
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buffer.writeUInt16LE(2, 32);  // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample
  buffer.write("data", 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  let phase = 0;
  for (let i = 0; i < numSamples; i++) {
    const t = i / numSamples;
    const freq = frequencyStart + (frequencyEnd - frequencyStart) * t;
    phase += (2 * Math.PI * freq) / sampleRate;

    let env = 1.0;
    if (t < 0.1) env = t / 0.1;
    else if (t > 0.8) env = (1.0 - t) / 0.2;

    const sample = Math.sin(phase) * volume * env;
    const intSample = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    buffer.writeInt16LE(intSample, 44 + i * 2);
  }
  return buffer;
}

const soundDir = path.join(__dirname, "modules", "voice-nav", "sounds");
if (!fs.existsSync(soundDir)) {
  fs.mkdirSync(soundDir, { recursive: true });
}

// Tono ascendente brillante de apertura (440Hz -> 880Hz, 160ms)
fs.writeFileSync(path.join(soundDir, "earcon_unmute.wav"), generateWav(440, 880, 160, 0.35));

// Tono descendente de cierre (520Hz -> 220Hz, 180ms)
fs.writeFileSync(path.join(soundDir, "earcon_mute.wav"), generateWav(520, 220, 180, 0.35));

// Tono éxito suave (540Hz -> 840Hz, 120ms)
fs.writeFileSync(path.join(soundDir, "earcon_success.wav"), generateWav(540, 840, 120, 0.25));

// Tono error sordo (320Hz -> 180Hz, 180ms)
fs.writeFileSync(path.join(soundDir, "earcon_error.wav"), generateWav(320, 180, 180, 0.25));

console.log("WAV Earcons creados exitosamente en modules/voice-nav/sounds/");
