const { execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

// ── voice pool ────────────────────────────────────────────────────────────────
const VOICES = [
  "en",
  "en+m1", "en+m2", "en+m3", "en+m4", "en+m5", "en+m6", "en+m7",
  "en+f1", "en+f2", "en+f3", "en+f4",
];

// ── sentence pools per noise level ───────────────────────────────────────────
const SENTENCES = {
  1: ["Yes", "Okay teacher", "I see", "Got it", "Mm-hmm", "Sure", "Okay"],
  2: [
    "Hello teacher, I am ready to start",
    "Can you hear me? I can hear you clearly",
    "I have a question about today's assignment",
    "Please repeat that, I missed the last part",
    "Yes, I understand. Thank you teacher",
    "The screen is clear on my side",
    "I am following along, please continue",
  ],
  3: [
    "Hello, hello, is my microphone on? Can anyone hear me? Hello!",
    "Teacher I have many questions, first about the homework, and second about the exam",
    "Okay okay I am here, can we start already, I have been waiting for so long",
    "Everyone please stop talking, I cannot hear the teacher at all",
    "Hello teacher, sorry I am late, what did I miss? What are we doing now?",
  ],
};

// ── level configuration ───────────────────────────────────────────────────────
const LEVEL_CONFIG = {
  0: { segments: 0, minPause: 0,  maxPause: 0,  noiseAmp: 0.015, amp: 0,   noiseColor: "white" },
  1: { segments: 2, minPause: 10, maxPause: 20, noiseAmp: 0.04,  amp: 40,  noiseColor: "pink"  },
  2: { segments: 3, minPause: 5,  maxPause: 12, noiseAmp: 0.08,  amp: 100, noiseColor: "pink"  },
  3: { segments: 5, minPause: 1,  maxPause: 4,  noiseAmp: 0.35,  amp: 180, noiseColor: "brown" },
};

// ── seeded RNG (xorshift32) ───────────────────────────────────────────────────
function makeRng(seed) {
  let x = (seed ^ 0xdeadbeef) >>> 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

// ── level assignment ──────────────────────────────────────────────────────────
function assignLevel(globalIndex, mode, dist) {
  if (mode === "quiet")   return 0;
  if (mode === "whisper") return 1;
  if (mode === "talking") return 2;
  if (mode === "noisy")   return 3;
  // mix
  const total = dist.reduce((a, b) => a + b, 0);
  let slot = globalIndex % total;
  let cumulative = 0;
  for (let lvl = 0; lvl < dist.length; lvl++) {
    cumulative += dist[lvl];
    if (slot < cumulative) return lvl;
  }
  return 0;
}

// ── run a shell command; throw with stderr on failure ─────────────────────────
function run(cmd) {
  try {
    execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`Command failed:\n  ${cmd}\n${e.stderr?.toString()}`);
  }
}

// ── generate one student's 60-second WAV ─────────────────────────────────────
// All ffmpeg outputs use -acodec pcm_s16le because Chrome's
// --use-file-for-fake-audio-capture only accepts 16-bit integer PCM.
// Without this, filter_complex (amix/concat) outputs 32-bit float WAV
// and Chrome produces silence.
function generateStudent(globalIndex, slot, batch, level, tmpDir, audioDir) {
  const outFile = path.join(audioDir, `batch-${batch}-user-${slot}.wav`);
  const cfg     = LEVEL_CONFIG[level];
  const rng     = makeRng(globalIndex * 137 + 7);

  // Level 0: quiet breath-like noise, no TTS
  if (level === 0) {
    run(
      `ffmpeg -y -f lavfi -i "anoisesrc=c=${cfg.noiseColor}:a=${cfg.noiseAmp}:d=60" ` +
      `-af "bandpass=f=150:w=200:width_type=h" ` +
      `-ar 48000 -ac 2 -acodec pcm_s16le "${outFile}"`
    );
    return outFile;
  }

  const voice = VOICES[globalIndex % VOICES.length];
  const speed = 115 + (globalIndex % 8) * 5;   // 115–150 wpm, varies per student
  const pool  = SENTENCES[level];

  // Generate speech segments
  const speechFiles = [];
  for (let j = 0; j < cfg.segments; j++) {
    const sentence = pool[(globalIndex + j) % pool.length];
    const raw  = path.join(tmpDir, `raw-${slot}-${j}.wav`);
    const conv = path.join(tmpDir, `conv-${slot}-${j}.wav`);

    run(`espeak-ng -v "${voice}" -s ${speed} -a ${cfg.amp} "${sentence.replace(/"/g, '\\"')}" -w "${raw}"`);
    // espeak-ng outputs mono at its own sample rate; convert to 48 kHz stereo 16-bit
    run(`ffmpeg -y -i "${raw}" -ar 48000 -ac 2 -acodec pcm_s16le "${conv}"`);
    speechFiles.push(conv);
  }

  // Build ordered list: silence speech silence speech … silence
  const ordered = [];
  for (let j = 0; j <= cfg.segments; j++) {
    const dur = cfg.minPause + rng() * (cfg.maxPause - cfg.minPause);
    const sil = path.join(tmpDir, `sil-${slot}-${j}.wav`);
    // anullsrc outputs float internally; force 16-bit output
    run(
      `ffmpeg -y -f lavfi -i "anullsrc=r=48000:cl=stereo" ` +
      `-t ${dur.toFixed(2)} -acodec pcm_s16le "${sil}"`
    );
    ordered.push(sil);
    if (j < cfg.segments) ordered.push(speechFiles[j]);
  }

  // Concatenate all segments
  const concat     = path.join(tmpDir, `concat-${slot}.wav`);
  const inputFlags = ordered.map(f => `-i "${f}"`).join(" ");
  const filterIn   = ordered.map((_, i) => `[${i}:a]`).join("");
  // concat filter outputs float internally; force 16-bit on the way out
  run(
    `ffmpeg -y ${inputFlags} ` +
    `-filter_complex "${filterIn}concat=n=${ordered.length}:v=0:a=1[out]" ` +
    `-map "[out]" -ar 48000 -ac 2 -acodec pcm_s16le "${concat}"`
  );

  // Mix background noise into the concat (duration=first → output length = concat)
  run(
    `ffmpeg -y -i "${concat}" ` +
    `-f lavfi -i "anoisesrc=c=${cfg.noiseColor}:a=${cfg.noiseAmp}:d=300" ` +
    `-filter_complex "[0][1]amix=inputs=2:duration=first" ` +
    `-ar 48000 -ac 2 -acodec pcm_s16le "${outFile}"`
  );

  return outFile;
}

// ── main ──────────────────────────────────────────────────────────────────────
const BATCH      = parseInt(process.env.BATCH);
const TABS       = parseInt(process.env.TABS_PER_BATCH) || 10;
const NUM_USERS  = parseInt(process.env.NUM_USERS);
const AUDIO_MODE = (process.env.AUDIO_MODE || "beep").toLowerCase();
const DIST       = (process.env.NOISE_DISTRIBUTION || "40,30,20,10").split(",").map(Number);

if (AUDIO_MODE === "beep") {
  console.log("[generate] beep mode — no audio files needed");
  process.exit(0);
}

const LEVEL_NAMES = ["quiet", "whisper", "talking", "noisy"];
const audioDir    = path.join(__dirname, "audio");
const tmpDir      = `/tmp/bchome-audio-${BATCH}`;
fs.mkdirSync(audioDir, { recursive: true });
fs.mkdirSync(tmpDir,   { recursive: true });

const start = BATCH * TABS;
const end   = Math.min(start + TABS, NUM_USERS);

for (let i = start; i < end; i++) {
  const slot  = i - start;
  const level = assignLevel(i, AUDIO_MODE, DIST);
  const voice = level > 0 ? VOICES[i % VOICES.length] : "—";
  const speed = level > 0 ? 115 + (i % 8) * 5 : 0;

  console.log(
    `[generate] user ${i} (slot ${slot}): level=${LEVEL_NAMES[level]} ` +
    `voice=${voice} speed=${speed || "n/a"}`
  );

  try {
    const outFile = generateStudent(i, slot, BATCH, level, tmpDir, audioDir);
    console.log(`[generate] → ${path.basename(outFile)}`);
  } catch (e) {
    console.error(`[generate] user ${i} FAILED: ${e.message}`);
    process.exit(1);
  }
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
console.log(`[generate] batch-${BATCH} complete`);
