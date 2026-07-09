const { chromium } = require("playwright");

const CLIENT_HOST = process.env.CLIENT_HOST;
const MOODLE_BASE = process.env.MOODLE_BASE;
const ROOM_ID     = process.env.ROOM_ID;
const HOLD_MS     = (parseInt(process.env.HOLD_MINUTES) || 10) * 60_000;
const BATCH       = parseInt(process.env.BATCH);
const TABS        = parseInt(process.env.TABS_PER_BATCH) || 10;
const NUM_USERS   = parseInt(process.env.NUM_USERS);
const ALL_CREDS   = JSON.parse(process.env.LOAD_TEST_CREDENTIALS);

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

(async () => {
  // Work out which accounts this batch is responsible for.
  // The last batch may get fewer tabs if num_users is not divisible.
  const start = BATCH * TABS;
  const end   = Math.min(start + TABS, NUM_USERS);

  if (start >= NUM_USERS) {
    console.log(`[batch-${BATCH}] no users assigned — skipping`);
    return;
  }
  if (start >= ALL_CREDS.length) {
    console.error(`[batch-${BATCH}] ERROR: credentials only has ${ALL_CREDS.length} entries but need index ${start}. Add more accounts to LOAD_TEST_CREDENTIALS.`);
    process.exit(1);
  }

  const batchCreds = ALL_CREDS.slice(start, end);
  console.log(`[batch-${BATCH}] responsible for ${batchCreds.length} users: ${batchCreds.map(c => c.username).join(", ")}`);

  // ── Step 1: get tokens ──────────────────────────────────────────────────
  const batchTokens = await Promise.all(
    batchCreds.map(async ({ username, password }) => {
      const token = await getToken(username, password);
      console.log(`[batch-${BATCH}] ${username}: token OK`);
      return { username, token };
    })
  );

  // ── Step 2: open browser ────────────────────────────────────────────────
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  // ── Step 3: open tabs and join room ─────────────────────────────────────
  for (let i = 0; i < batchTokens.length; i++) {
    const { username, token } = batchTokens[i];
    const url = `${CLIENT_HOST}/classroom/${ROOM_ID}/${token}`;

    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`[${username}] page error: ${e.message}`));

    await page.goto(url);
    console.log(`[${username}] page loaded`);

    try {
      const btn = page.locator(
        'button:has-text("Got it"), button:has-text("Join the class anyway")'
      );
      await btn.waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction(
        () => {
          const b = [...document.querySelectorAll("button")].find(
            (el) => el.textContent.includes("Got it") ||
                    el.textContent.includes("Join the class anyway")
          );
          return b && !b.disabled;
        },
        { timeout: 30_000 }
      );
      await btn.click();
      console.log(`[${username}] entered room`);
    } catch (e) {
      console.error(`[${username}] could not click enter button: ${e.message}`);
    }

    if (i < batchTokens.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // ── Step 4: hold ────────────────────────────────────────────────────────
  console.log(`[batch-${BATCH}] all bots in room — holding ${HOLD_MS / 1000}s`);
  await new Promise((r) => setTimeout(r, HOLD_MS));

  await browser.close();
  console.log(`[batch-${BATCH}] done`);
})();
