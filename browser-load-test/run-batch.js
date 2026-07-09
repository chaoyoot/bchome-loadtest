const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CLIENT_HOST = process.env.CLIENT_HOST;
const MOODLE_BASE = process.env.MOODLE_BASE;
const ROOM_ID     = process.env.ROOM_ID;
const HOLD_MS     = (parseInt(process.env.HOLD_MINUTES) || 10) * 60_000;
const BATCH       = parseInt(process.env.BATCH);
const TABS        = parseInt(process.env.TABS_PER_BATCH) || 10;
const NUM_USERS   = parseInt(process.env.NUM_USERS);
const ALL_CREDS   = JSON.parse(process.env.LOAD_TEST_CREDENTIALS);

const SCREENSHOT_DIR = path.join("screenshots", `batch-${BATCH}`);
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function getSessionTime() {
  const override = process.env.SESSION_TIME;
  if (override && override.trim() !== '') return parseInt(override.trim());
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
  const url = `${MOODLE_BASE}/login/token.php` +
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
  console.log(`[${username}] screenshot saved: ${file}`);
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

  // Step 1: get tokens
  const batchTokens = await Promise.all(
    batchCreds.map(async ({ username, password }) => {
      const token = await getToken(username, password);
      console.log(`[batch-${BATCH}] ${username}: token OK`);
      return { username, token };
    })
  );

  // Step 2: open browser
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  // Step 3: open tabs and join room
  for (let i = 0; i < batchTokens.length; i++) {
    const { username, token } = batchTokens[i];
    const url = buildRoomUrl(token);

    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`[${username}] page error: ${e.message}`));

    await page.goto(url);
    console.log(`[${username}] page loaded`);

    // The app auto-joins on a fresh browser (localStorage empty → forcedRefresh logic).
    // We wait for the classroom to be visible instead of looking for "Got it".
    // Take a screenshot 8 seconds after load to confirm state.
    await new Promise((r) => setTimeout(r, 8_000));
    await screenshot(page, username, "after-join");
    console.log(`[${username}] in room (auto-joined)`);

    if (i < batchTokens.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Step 4: hold, then take a final screenshot to confirm bots are still in room
  const holdCheckMs = Math.min(HOLD_MS / 2, 60_000); // screenshot halfway through
  console.log(`[batch-${BATCH}] holding ${HOLD_MS / 1000}s...`);
  await new Promise((r) => setTimeout(r, holdCheckMs));

  for (const { username, token } of batchTokens) {
    const pages = browser.contexts().flatMap(ctx => ctx.pages());
    // take mid-hold screenshot of first page as a sample
    if (pages[0]) await screenshot(pages[0], `batch${BATCH}-sample`, "mid-hold");
    break;
  }

  await new Promise((r) => setTimeout(r, HOLD_MS - holdCheckMs));

  await browser.close();
  console.log(`[batch-${BATCH}] done`);
})();
