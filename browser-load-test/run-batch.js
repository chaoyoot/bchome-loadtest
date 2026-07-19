const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

const CLIENT_HOST    = process.env.CLIENT_HOST;
const MOODLE_BASE    = process.env.MOODLE_BASE;
const ROOM_ID        = process.env.ROOM_ID;
const HOLD_MS        = (parseInt(process.env.HOLD_MINUTES) || 10) * 60_000;
const BATCH          = parseInt(process.env.BATCH);
const TABS           = parseInt(process.env.TABS_PER_BATCH) || 10;
const NUM_USERS      = parseInt(process.env.NUM_USERS);
const ALL_CREDS      = JSON.parse(process.env.LOAD_TEST_CREDENTIALS);
const ENABLE_YOUTUBE = process.env.ENABLE_YOUTUBE === "true";
const AUDIO_MODE     = (process.env.AUDIO_MODE || "beep").toLowerCase();
const NOISE_DIST     = (process.env.NOISE_DISTRIBUTION || "40,30,20,10").split(",").map(Number);

const SCREENSHOT_DIR = path.join("screenshots", `batch-${BATCH}`);
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

console.log(`[batch-${BATCH}] audio=${AUDIO_MODE} | YouTube: ${ENABLE_YOUTUBE ? "ON" : "off"}`);

// ── audio simulation ──────────────────────────────────────────────────────────
// Each level defines oscillator gain (volume), how long the bot "speaks" per
// cycle, and how long it stays silent. Bots are staggered within the cycle so
// they don't all speak at the same time.
const LEVEL_PARAMS = [
  { gain: 0.05, speakMs:  5_000, pauseMs: 30_000 },  // 0: quiet
  { gain: 0.20, speakMs:  2_000, pauseMs: 15_000 },  // 1: whisper
  { gain: 0.60, speakMs:  4_000, pauseMs:  8_000 },  // 2: talking
  { gain: 1.00, speakMs:  6_000, pauseMs:  2_000 },  // 3: noisy
];
const LEVEL_NAMES = ["quiet", "whisper", "talking", "noisy"];

function assignLevel(globalIndex) {
  if (AUDIO_MODE === "quiet")   return 0;
  if (AUDIO_MODE === "whisper") return 1;
  if (AUDIO_MODE === "talking") return 2;
  if (AUDIO_MODE === "noisy")   return 3;
  if (AUDIO_MODE !== "mix")     return null;  // beep — no injection
  const total = NOISE_DIST.reduce((a, b) => a + b, 0);
  let slot = globalIndex % total;
  let cumulative = 0;
  for (let lvl = 0; lvl < NOISE_DIST.length; lvl++) {
    cumulative += NOISE_DIST[lvl];
    if (slot < cumulative) return lvl;
  }
  return 0;
}

// Returns a JS snippet injected into each page before any app code runs.
// Overrides getUserMedia so the app receives a Web Audio oscillator stream
// instead of the fake device's default sine wave. Each bot gets a unique
// frequency (pitch) and a different start offset so they don't all speak
// at the same time. The real video track is preserved unchanged.
function buildAudioScript(globalIndex) {
  const level = assignLevel(globalIndex);
  if (level === null) return null;

  const { gain, speakMs, pauseMs } = LEVEL_PARAMS[level];
  const cycleSec   = (speakMs + pauseMs) / 1000;
  const speakSec   = speakMs / 1000;
  // Distribute bots evenly across one cycle so at any moment only ~speakMs/cycleSec
  // fraction of bots are speaking simultaneously.
  const startDelay = (globalIndex % 10) * (cycleSec / 10);
  // Unique pitch per student: 150–350 Hz
  const freq       = 150 + (globalIndex * 37) % 200;

  console.log(
    `[batch-${BATCH}] user ${globalIndex}: level=${LEVEL_NAMES[level]} ` +
    `gain=${gain} speak=${speakMs}ms pause=${pauseMs}ms freq=${freq}Hz`
  );

  return `
(function() {
  const _gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async function(constraints) {
    const stream = await _gum(constraints);
    if (!constraints || !constraints.audio) return stream;
    try {
      const ctx  = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      const osc  = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = ${freq};
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0.0001;
      osc.connect(gainNode);
      gainNode.connect(dest);
      osc.start();
      function cycle(when) {
        gainNode.gain.setValueAtTime(${gain}, when);
        gainNode.gain.setValueAtTime(0.0001, when + ${speakSec});
        const next = when + ${cycleSec};
        setTimeout(() => cycle(next), Math.max(0, (next - ctx.currentTime) * 1000 - 50));
      }
      cycle(ctx.currentTime + ${startDelay});
      return new MediaStream([dest.stream.getAudioTracks()[0], ...stream.getVideoTracks()]);
    } catch (e) {
      console.warn('[bot-audio] inject failed:', e.message);
      return stream;
    }
  };
})();`;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function getSessionTime() {
  const override = process.env.SESSION_TIME;
  if (override && override.trim() !== "") return parseInt(override.trim());
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0, 0);
}

function buildRoomUrl(token) {
  const sessionTime = getSessionTime();
  return (
    `${CLIENT_HOST}/classroom/${ROOM_ID}/${token}/` +
    `?sessiontime=${sessionTime}&showUserlist=false&disablechat=true&hd=true`
  );
}

async function getToken(username, password) {
  const url =
    `${MOODLE_BASE}/login/token.php` +
    `?username=${encodeURIComponent(username)}` +
    `&password=${encodeURIComponent(password)}` +
    `&service=braincloud`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.token) throw new Error(`Token failed for ${username}: ${JSON.stringify(data)}`);
  return data.token;
}

async function screenshot(page, username, label) {
  const file = path.join(SCREENSHOT_DIR, `${username}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.log(`[${username}] screenshot: ${label}`);
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  const start = BATCH * TABS;
  const end   = Math.min(start + TABS, NUM_USERS);

  if (start >= NUM_USERS) {
    console.log(`[batch-${BATCH}] no users assigned — skipping`);
    return;
  }
  if (start >= ALL_CREDS.length) {
    console.error(
      `[batch-${BATCH}] ERROR: credentials only has ${ALL_CREDS.length} entries ` +
      `but need index ${start}. Add more accounts to LOAD_TEST_CREDENTIALS.`
    );
    process.exit(1);
  }

  const batchCreds = ALL_CREDS.slice(start, end);
  console.log(`[batch-${BATCH}] users: ${batchCreds.map(c => c.username).join(", ")}`);
  console.log(`[batch-${BATCH}] sessiontime: ${getSessionTime()} (${new Date(getSessionTime()).toISOString()})`);

  // Fetch all tokens in parallel before opening any browser
  const batchTokens = await Promise.all(
    batchCreds.map(async ({ username, password }) => {
      const token = await getToken(username, password);
      console.log(`[batch-${BATCH}] ${username}: token OK`);
      return { username, token };
    })
  );

  const chromeArgs = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ];
  if (ENABLE_YOUTUBE) {
    chromeArgs.push(
      "--autoplay-policy=no-user-gesture-required",
      "--disable-blink-features=AutomationControlled"
    );
  }

  const contextOptions = ENABLE_YOUTUBE
    ? {
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      }
    : {};

  // One browser per batch; audio is injected per-page via addInitScript so
  // each student gets a different level, rhythm, and frequency without
  // needing a separate browser process.
  const browser    = await chromium.launch({ args: chromeArgs });
  const activeBots = [];

  for (let i = 0; i < batchTokens.length; i++) {
    const { username, token } = batchTokens[i];
    const globalIndex = start + i;
    const url         = buildRoomUrl(token);

    const context = await browser.newContext(contextOptions);
    const page    = await context.newPage();
    page.on("pageerror", (e) => console.error(`[${username}] page error: ${e.message}`));

    // Inject audio override BEFORE page.goto() so it is in place when the
    // app calls getUserMedia during room initialisation.
    const audioScript = buildAudioScript(globalIndex);
    if (audioScript) {
      await page.addInitScript(audioScript);
    }

    await page.goto(url);
    console.log(`[${username}] page loaded`);

    // App auto-joins on a fresh browser (empty localStorage → BeforeRoom skip).
    await new Promise((r) => setTimeout(r, 8_000));
    await screenshot(page, username, "after-join");
    console.log(`[${username}] in room`);

    activeBots.push({ username, page });

    if (i < batchTokens.length - 1) {
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  const halfHold = Math.min(HOLD_MS / 2, 60_000);
  console.log(`[batch-${BATCH}] holding ${HOLD_MS / 1000}s...`);
  await new Promise((r) => setTimeout(r, halfHold));

  console.log(`[batch-${BATCH}] mid-hold screenshots...`);
  for (const { username, page } of activeBots) {
    await screenshot(page, username, "mid-hold");
  }

  await new Promise((r) => setTimeout(r, HOLD_MS - halfHold));

  await browser.close();
  console.log(`[batch-${BATCH}] done`);
})();
