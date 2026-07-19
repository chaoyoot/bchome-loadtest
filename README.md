# bchome-loadtest

Browser-based load test for the bchome virtual classroom (mediasoup SFU + React client).  
Each bot logs in through Moodle, gets a token, and joins the classroom as a real student using a headless Chromium browser with a fake webcam and microphone.

---

## Repository structure

```
bchome-loadtest/
  .github/
    workflows/
      loadtest-browser.yml   # GitHub Actions workflow
  browser-load-test/
    run-batch.js             # Main bot script (one Chrome process per student)
    generate-audio.js        # Generates per-student WAV audio files
    package.json             # Node dependencies (Playwright)
    .gitignore               # Excludes audio/, screenshots/, node_modules/
```

---

## Prerequisites

- A GitHub repo (this one) with Actions enabled
- GitHub Secret `LOAD_TEST_CREDENTIALS` — a JSON array of student accounts (see below)

---

## Setting up credentials

In **Settings → Secrets → Actions**, add a secret named `LOAD_TEST_CREDENTIALS`:

```json
[
  { "username": "trntest0001", "password": "password1" },
  { "username": "trntest0002", "password": "password2" },
  { "username": "trntest0003", "password": "password3"  }
]
```

Add as many accounts as the maximum number of bots you plan to run.  
Each account must be enrolled in the test room in Moodle.

---

## Running the load test

Go to **Actions → Browser load test → Run workflow** and fill in the inputs:

| Input | Default | Description |
|-------|---------|-------------|
| `num_users` | `20` | Number of student bots (1–1000) |
| `tabs_per_batch` | `10` | Bots per GitHub Actions job (keep at 10) |
| `hold_minutes` | `10` | How long bots stay in the room |
| `client_host` | `https://home-th.braincloudlearning.com` | Classroom client URL |
| `moodle_base` | `https://admin.braincloudlearning.com` | Moodle URL for token auth |
| `room_id` | `c2c_trn_g1.1_chaoyootk_engl` | Room ID (use a test room, NOT a live class) |
| `session_time` | _(today 17:00 UTC+7)_ | Epoch ms for session time; leave blank for auto |
| `enable_youtube` | `false` | Enable YouTube iframe playback inside bots |
| `audio_mode` | `beep` | Microphone audio mode (see below) |
| `noise_distribution` | `40,30,20,10` | % split for `mix` mode (quiet/whisper/talking/noisy) |

### Audio modes

| Mode | Description |
|------|-------------|
| `beep` | Chrome default sine wave tone — fastest, no setup |
| `quiet` | All bots: faint breath-like noise, mic open but nearly silent |
| `whisper` | All bots: soft voice, short sentences (Yes / Got it), long pauses |
| `talking` | All bots: clear voice, medium sentences, moderate pauses |
| `noisy` | All bots: loud voice, long sentences, short pauses + crowd noise |
| `mix` | Each bot assigned a level by `noise_distribution` |

In all speech modes, each student gets a **unique voice** (12 espeak-ng variants) and a **unique pause pattern** seeded by their user index — so bots don't all speak at the same time.

### Scaling guide

| Users | Jobs | `hold_minutes` |
|------:|-----:|----------------|
| 20 | 2 | 10 |
| 100 | 10 | 10 |
| 500 | 50 | 20 |
| 1 000 | 100 | 30 |

Free GitHub accounts run ~20 jobs concurrently; jobs queue automatically.

---

## How it works

1. **setup job** — computes the job matrix (one job per 10 bots)
2. **student-bots jobs** (parallel) — for each batch:
   - Installs Playwright + Chromium (cached after first run)
   - If `audio_mode != beep`: installs `espeak-ng`, generates a unique WAV per student
   - Fetches Moodle tokens for all users in the batch
   - Launches one Chromium process per student with fake media flags
   - Opens the classroom URL; the app auto-joins (empty localStorage skips BeforeRoom)
   - Screenshots each bot at join and mid-hold
   - Uploads screenshots as workflow artifacts

---

## Screenshots

After each run, screenshots are available under **Actions → the run → Artifacts**.  
Each bot produces two screenshots: `username-after-join.png` and `username-mid-hold.png`.
