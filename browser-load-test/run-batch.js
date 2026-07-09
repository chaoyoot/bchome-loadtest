const { chromium } = require("playwright");

const CLIENT_HOST   = process.env.CLIENT_HOST;   // e.g. https://home.braincloudlearning.com
const ROOM_ID       = process.env.ROOM_ID;        // your test room ID
const HOLD_MS       = (parseInt(process.env.HOLD_MINUTES) || 5) * 60_000;
const BATCH         = parseInt(process.env.BATCH);
const TABS          = parseInt(process.env.TABS_PER_BATCH) || 5;
const ALL_TOKENS    = JSON.parse(process.env.LOAD_TEST_TOKENS);

(async () => {
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",      // auto-accept camera/mic permission
      "--use-fake-device-for-media-stream",  // use fake test camera, no real device needed
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const pages = [];

  for (let i = 0; i < TABS; i++) {
    const studentIdx = BATCH * TABS + i;
    if (studentIdx >= ALL_TOKENS.length) break;

    const { username, token } = ALL_TOKENS[studentIdx];
    const url = `${CLIENT_HOST}/classroom/${ROOM_ID}/${token}`;

    const page = await browser.newPage();
    page.on("pageerror", (e) =>
      console.error(`[${username}] page error: ${e.message}`)
    );

    await page.goto(url);
    console.log(`[${username}] page loaded`);

    // Wait for the hardware selection screen "Got it" button to be enabled,
    // then click it to enter the room. Timeout 30s for slow connections.
    try {
      const btn = page.locator('button:has-text("Got it"), button:has-text("Join the class anyway")');
      await btn.waitFor({ state: "visible", timeout: 30_000 });
      // Wait until it's no longer loading/disabled
      await page.waitForFunction(
        () => {
          const b = [...document.querySelectorAll("button")].find(
            (el) => el.textContent.includes("Got it") || el.textContent.includes("Join the class anyway")
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

    pages.push({ page, username });

    // Stagger joins so they don't all hit the SFU simultaneously
    if (i < TABS - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log(`[batch-${BATCH}] all bots in room — holding for ${HOLD_MS / 1000}s`);
  await new Promise((r) => setTimeout(r, HOLD_MS));

  console.log(`[batch-${BATCH}] done, closing`);
  await browser.close();
})();
