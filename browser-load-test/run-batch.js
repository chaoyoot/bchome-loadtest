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
const SIMULATE_SPEECH = process.env.SIMULATE_SPEECH === "true";

const SPEECH_FILE    = path.resolve(__dirname, "fake-speech.wav");
const SCREENSHOT_DIR = path.join("screenshots", `batch-${BATCH}`);
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

console.log(`[batch-${BATCH}] YouTube: ${ENABLE_YOUTUBE ? "ON" : "off"} | Speech simulation: ${SIMULATE_SPEECH ? "ON" : "off (sine wave)"}`);

if (SIMULATE_SPEECH && !fs.existsSync(SPEECH_FILE)) {
  console.error(`[batch-${BATCH}] ERROR: simulate_speech is ON but fake-speech.wav not found at ${SPEECH_FILE}`);
  console.error(`[batch-${BATCH}] Make sure the "Generate speech audio file" workflow step ran successfully.`);
  process.exit(1);
}

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
  console.log(`[${username}] screenshot: ${label}`);
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

  // Step 2: build Chrome args
  const chromeArgs = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ];

  if (SIMULATE_SPEECH) {
    // Replace the default sine wave with the generated speech WAV.
    // Chrome loops the file automatically for the duration of the session.
    chromeArgs.push(`--use-file-for-fake-audio-capture=${SPEECH_FILE}`);
    console.log(`[batch-${BATCH}] Using speech file: ${SPEECH_FILE}`);
  }

  if (ENABLE_YOUTUBE) {
    chromeArgs.push(
      "--autoplay-policy=no-user-gesture-required",
      "--disable-blink-features=AutomationControlled"
    );
  }

  const browser = await chromium.launch({ args: chromeArgs });

  // When YouTube is enabled, use a real user agent so YouTube does not block the iframe.
  const contextOptions = ENABLE_YOUTUBE
    ? {
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      }
    : {};

  // Step 3: open tabs and join room
  const activeBots = []; // { username, page }

  for (let i = 0; i < batchTokens.length; i++) {
    const { username, token } = batchTokens[i];
    const url = buildRoomUrl(token);

    const context = await browser.newContext(contextOptions);
    const page    = await context.newPage();
    page.on("pageerror", (e) => console.error(`[${username}] page error: ${e.message}`));

    await page.goto(url);
    console.log(`[${username}] page loaded`);

    // App auto-joins on fresh browser (localStorage empty → BeforeRoom skipped).
    // Wait 8 seconds then screenshot to confirm state.
    await new Promise((r) => setTimeout(r, 8_000));
    await screenshot(page, username, "after-join");
    console.log(`[${username}] in room`);

    activeBots.push({ username, page });

    if (i < batchTokens.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Step 4: hold — screenshot each user halfway through
  const halfHold = Math.min(HOLD_MS / 2, 60_000);
  console.log(`[batch-${BATCH}] holding ${HOLD_MS / 1000}s...`);
  await new Promise((r) => setTimeout(r, halfHold));

  console.log(`[batch-${BATCH}] taking mid-hold screenshots...`);
  for (const { username, page } of activeBots) {
    await screenshot(page, username, "mid-hold");
  }

  await new Promise((r) => setTimeout(r, HOLD_MS - halfHold));

  await browser.close();
  console.log(`[batch-${BATCH}] done`);
})();

// const { chromium } = require("playwright");
// const fs = require("fs");
// const path = require("path");

// const CLIENT_HOST      = process.env.CLIENT_HOST;
// const MOODLE_BASE      = process.env.MOODLE_BASE;
// const ROOM_ID          = process.env.ROOM_ID;
// const HOLD_MS          = (parseInt(process.env.HOLD_MINUTES) || 10) * 60_000;
// const BATCH            = parseInt(process.env.BATCH);
// const TABS             = parseInt(process.env.TABS_PER_BATCH) || 10;
// const NUM_USERS        = parseInt(process.env.NUM_USERS);
// const ALL_CREDS        = JSON.parse(process.env.LOAD_TEST_CREDENTIALS);
// const ENABLE_YOUTUBE   = process.env.ENABLE_YOUTUBE === "true";

// const SCREENSHOT_DIR = path.join("screenshots", `batch-${BATCH}`);
// fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// console.log(`[batch-${BATCH}] YouTube support: ${ENABLE_YOUTUBE ? "ENABLED" : "disabled"}`);

// function getSessionTime() {
//   const override = process.env.SESSION_TIME;
//   if (override && override.trim() !== '') return parseInt(override.trim());
//   const now = new Date();
//   return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0, 0);
// }

// function buildRoomUrl(token) {
//   const sessionTime = getSessionTime();
//   return (
//     `${CLIENT_HOST}/classroom/${ROOM_ID}/${token}/` +
//     `?sessiontime=${sessionTime}&showUserlist=false&disablechat=true&hd=true`
//   );
// }

// async function getToken(username, password) {
//   const url = `${MOODLE_BASE}/login/token.php` +
//               `?username=${encodeURIComponent(username)}` +
//               `&password=${encodeURIComponent(password)}` +
//               `&service=braincloud`;
//   const res  = await fetch(url);
//   const data = await res.json();
//   if (!data.token) throw new Error(`Token failed for ${username}: ${JSON.stringify(data)}`);
//   return data.token;
// }

// async function screenshot(page, username, label) {
//   const file = path.join(SCREENSHOT_DIR, `${username}-${label}.png`);
//   await page.screenshot({ path: file, fullPage: true }).catch(() => {});
//   console.log(`[${username}] screenshot: ${label}`);
// }

// (async () => {
//   const start = BATCH * TABS;
//   const end   = Math.min(start + TABS, NUM_USERS);

//   if (start >= NUM_USERS) {
//     console.log(`[batch-${BATCH}] no users assigned — skipping`);
//     return;
//   }
//   if (start >= ALL_CREDS.length) {
//     console.error(
//       `[batch-${BATCH}] ERROR: credentials only has ${ALL_CREDS.length} entries ` +
//       `but need index ${start}. Add more accounts to LOAD_TEST_CREDENTIALS.`
//     );
//     process.exit(1);
//   }

//   const batchCreds = ALL_CREDS.slice(start, end);
//   console.log(`[batch-${BATCH}] users: ${batchCreds.map(c => c.username).join(", ")}`);
//   console.log(`[batch-${BATCH}] sessiontime: ${getSessionTime()} (${new Date(getSessionTime()).toISOString()})`);

//   // Step 1: get tokens
//   const batchTokens = await Promise.all(
//     batchCreds.map(async ({ username, password }) => {
//       const token = await getToken(username, password);
//       console.log(`[batch-${BATCH}] ${username}: token OK`);
//       return { username, token };
//     })
//   );

//   // Step 2: open browser
//   // When YouTube is enabled, add extra flags to allow autoplay and
//   // hide headless detection so YouTube does not block the iframe.
//   const chromeArgs = [
//     "--use-fake-ui-for-media-stream",
//     "--use-fake-device-for-media-stream",
//     "--no-sandbox",
//     "--disable-setuid-sandbox",
//   ];

//   if (ENABLE_YOUTUBE) {
//     chromeArgs.push(
//       "--autoplay-policy=no-user-gesture-required",
//       "--disable-blink-features=AutomationControlled"
//     );
//   }

//   const browser = await chromium.launch({ args: chromeArgs });

//   // When YouTube is enabled, use a real browser user agent so YouTube
//   // does not detect and block the headless Chrome iframe.
//   const contextOptions = ENABLE_YOUTUBE
//     ? {
//         userAgent:
//           "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
//           "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
//       }
//     : {};

//   // Step 3: open tabs and join room
//   const activeBots = []; // { username, page }

//   for (let i = 0; i < batchTokens.length; i++) {
//     const { username, token } = batchTokens[i];
//     const url = buildRoomUrl(token);

//     const context = await browser.newContext(contextOptions);
//     const page    = await context.newPage();
//     page.on("pageerror", (e) => console.error(`[${username}] page error: ${e.message}`));

//     await page.goto(url);
//     console.log(`[${username}] page loaded`);

//     // App auto-joins on fresh browser (localStorage empty → BeforeRoom skipped).
//     // Wait 8 seconds then screenshot to confirm state.
//     await new Promise((r) => setTimeout(r, 8_000));
//     await screenshot(page, username, "after-join");
//     console.log(`[${username}] in room`);

//     activeBots.push({ username, page });

//     if (i < batchTokens.length - 1) {
//       await new Promise((r) => setTimeout(r, 2000));
//     }
//   }

//   // Step 4: hold — screenshot each user halfway through
//   const halfHold = Math.min(HOLD_MS / 2, 60_000);
//   console.log(`[batch-${BATCH}] holding ${HOLD_MS / 1000}s...`);
//   await new Promise((r) => setTimeout(r, halfHold));

//   console.log(`[batch-${BATCH}] taking mid-hold screenshots...`);
//   for (const { username, page } of activeBots) {
//     await screenshot(page, username, "mid-hold");
//   }

//   await new Promise((r) => setTimeout(r, HOLD_MS - halfHold));

//   await browser.close();
//   console.log(`[batch-${BATCH}] done`);
// })();
