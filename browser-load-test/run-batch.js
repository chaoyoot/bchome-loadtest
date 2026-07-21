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

const SCREENSHOT_DIR = path.join("screenshots", `batch-${BATCH}`);
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

console.log(`[batch-${BATCH}] audio=${AUDIO_MODE} | YouTube: ${ENABLE_YOUTUBE ? "ON" : "off"}`);

// ── Web Audio injection for speech modes ──────────────────────────────────────
// --use-file-for-fake-audio-capture does not work in Playwright's Chromium —
// Chrome produces silence instead of reading the WAV.
//
// Instead, we override getUserMedia in the page via addInitScript() to return
// a Web Audio MediaStreamDestination fed from the student's pre-generated WAV.
// The WAV (espeak-ng speech) passes Opus DTX's WebRTC VAD, unlike a pure sine
// wave, so the SFU actually transmits audio and the teacher can hear it.
//
// The WAV is embedded as base64 inside the injected script (files are ~2 MB
// at 16 kHz mono, ~2.7 MB base64 — manageable as a local string injection).
function buildAudioScript(slot) {
  if (AUDIO_MODE === "beep") return null;

  const wavPath = path.resolve(__dirname, "audio", `batch-${BATCH}-user-${slot}.wav`);
  if (!fs.existsSync(wavPath)) {
    console.error(`[batch-${BATCH}] ERROR: audio file missing: ${wavPath}`);
    console.error(`  Make sure the "Generate per-student audio files" step ran.`);
    process.exit(1);
  }

  const wavBase64 = fs.readFileSync(wavPath).toString("base64");

  return `
(function() {
  var b64 = "${wavBase64}";
  var bin = atob(b64);
  var buf = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  var wavBuf = buf.buffer;

  var _gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async function(constraints) {
    var stream = await _gum(constraints);
    if (!constraints || !constraints.audio) return stream;
    try {
      var ctx = new AudioContext({ sampleRate: 48000 });
      console.log('[bot-audio] ctx state:', ctx.state);
      var audioBuf = await ctx.decodeAudioData(wavBuf.slice(0));
      console.log('[bot-audio] decoded WAV:', audioBuf.duration.toFixed(1) + 's', audioBuf.sampleRate + 'Hz');
      var dest = ctx.createMediaStreamDestination();
      var src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.loop = true;
      src.connect(dest);
      src.start(0);
      console.log('[bot-audio] audio injected OK');
      return new MediaStream([dest.stream.getAudioTracks()[0], ...stream.getVideoTracks()]);
    } catch (e) {
      console.warn('[bot-audio] inject failed:', e.message);
      return stream;
    }
  };
})();
`;
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
    `?sessiontime=${sessionTime}&showUserlist=true&disablechat=true&hd=true`
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

function buildChromeArgs() {
  const args = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    // Required for AudioContext to run without a user gesture (headless bots
    // never trigger a user gesture, so AudioContext stays suspended otherwise).
    "--autoplay-policy=no-user-gesture-required",
  ];
  if (ENABLE_YOUTUBE) {
    args.push("--disable-blink-features=AutomationControlled");
  }
  return args;
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

  const contextOptions = ENABLE_YOUTUBE
    ? {
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      }
    : {};

  const activeBots = []; // { username, page, browser }

  const chromeArgs = buildChromeArgs();

  for (let i = 0; i < batchTokens.length; i++) {
    const { username, token } = batchTokens[i];
    const url         = buildRoomUrl(token);
    const audioScript = buildAudioScript(i);

    const browser = await chromium.launch({ args: chromeArgs });
    const context = await browser.newContext(contextOptions);
    const page    = await context.newPage();
    if (audioScript) await page.addInitScript({ content: audioScript });
    page.on("pageerror", (e) => console.error(`[${username}] page error: ${e.message}`));
    if (audioScript) page.on("console", (msg) => {
      if (msg.text().includes("[bot-audio]")) console.log(`[${username}] ${msg.text()}`);
    });

    await page.goto(url);
    console.log(`[${username}] page loaded`);

    // App auto-joins on a fresh browser (empty localStorage → BeforeRoom skip).
    await new Promise((r) => setTimeout(r, 8_000));
    await screenshot(page, username, "after-join");
    console.log(`[${username}] in room`);

    activeBots.push({ username, page, browser });

    if (i < batchTokens.length - 1) {
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  // Hold — screenshot each bot halfway through
  const halfHold = Math.min(HOLD_MS / 2, 60_000);
  console.log(`[batch-${BATCH}] holding ${HOLD_MS / 1000}s...`);
  await new Promise((r) => setTimeout(r, halfHold));

  console.log(`[batch-${BATCH}] mid-hold screenshots...`);
  for (const { username, page } of activeBots) {
    await screenshot(page, username, "mid-hold");
  }

  await new Promise((r) => setTimeout(r, HOLD_MS - halfHold));

  for (const { browser } of activeBots) {
    await browser.close();
  }
  console.log(`[batch-${BATCH}] done`);
})();
