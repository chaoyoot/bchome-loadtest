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

// Returns the per-student WAV path, or null for beep mode.
// Each student gets their own file so Chrome can be launched with a unique
// --use-file-for-fake-audio-capture per process.
function getAudioFile(slot) {
  if (AUDIO_MODE === "beep") return null;
  const f = path.resolve(__dirname, "audio", `batch-${BATCH}-user-${slot}.wav`);
  if (!fs.existsSync(f)) {
    console.error(`[batch-${BATCH}] ERROR: audio file missing: ${f}`);
    console.error(`[batch-${BATCH}]   Make sure the "Generate per-student audio" step ran.`);
    process.exit(1);
  }
  return f;
}

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

function buildChromeArgs(audioFile) {
  const args = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ];
  // Point Chrome's fake mic device at the student's unique WAV.
  // This flag is per-browser-process, so each student needs their own launch().
  if (audioFile) {
    args.push(`--use-file-for-fake-audio-capture=${audioFile}`);
  }
  if (ENABLE_YOUTUBE) {
    args.push(
      "--autoplay-policy=no-user-gesture-required",
      "--disable-blink-features=AutomationControlled"
    );
  }
  return args;
}

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

  for (let i = 0; i < batchTokens.length; i++) {
    const { username, token } = batchTokens[i];
    const url       = buildRoomUrl(token);
    const audioFile = getAudioFile(i);

    // One browser per student: --use-file-for-fake-audio-capture is a process-level
    // flag, so sharing one browser across students would give them all the same audio.
    const browser = await chromium.launch({ args: buildChromeArgs(audioFile) });
    const context = await browser.newContext(contextOptions);
    const page    = await context.newPage();
    page.on("pageerror", (e) => console.error(`[${username}] page error: ${e.message}`));

    await page.goto(url);
    console.log(`[${username}] page loaded`);

    // App auto-joins on a fresh browser (empty localStorage → BeforeRoom skip).
    // Wait 8 s then capture state.
    await new Promise((r) => setTimeout(r, 8_000));
    await screenshot(page, username, "after-join");
    console.log(`[${username}] in room`);

    activeBots.push({ username, page, browser });

    if (i < batchTokens.length - 1) {
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  // Hold — take a screenshot from each bot halfway through
  const halfHold = Math.min(HOLD_MS / 2, 60_000);
  console.log(`[batch-${BATCH}] holding ${HOLD_MS / 1000}s...`);
  await new Promise((r) => setTimeout(r, halfHold));

  console.log(`[batch-${BATCH}] mid-hold screenshots...`);
  for (const { username, page } of activeBots) {
    await screenshot(page, username, "mid-hold");
  }

  await new Promise((r) => setTimeout(r, HOLD_MS - halfHold));

  // Close every browser
  for (const { browser } of activeBots) {
    await browser.close();
  }
  console.log(`[batch-${BATCH}] done`);
})();
