# Plotline — Demo Video Production Kit

Target: **≤ 90 seconds**, 1080p, posted on X with **#OKXAI**.
Everything below is copy-paste ready.

---

## 0. What you're filming (the plot of the video)

1. **Hook** — "AI agents lie about data" (generated image, 8s)
2. **Create** — one API call turns a CSV into a story (terminal, 8s)
3. **Beauty** — scroll the cinematic story page (browser, 22s)
4. **The Gauntlet** — 6 attacks, 6 correct verdicts (terminal, 40s)
5. **Close** — logo card with URL + #OKXAI (10s)

Live story to scroll: **https://plotline-production-34e6.up.railway.app/story/b1h4v9ta68**

---

## 1. VOICEOVER SCRIPT (ElevenLabs — paste each line as its own generation)

> Total ≈ 170 words ≈ 80 seconds at documentary pace. Generate each numbered
> line as a SEPARATE audio clip — much easier to sync in editing.

**VO-1 (Hook, 0:00–0:08)**
"AI agents are brilliant at analyzing data — and terrifyingly good at lying about it."

**VO-2 (Create, 0:08–0:16)**
"Plotline fixes that. Send it a raw CSV, and it returns a cinematic data story — where every claim is computed, not imagined."

**VO-3 (Beauty, 0:16–0:38)**
"A deterministic statistics engine does the math: regressions, confidence intervals, p-values. The prose is audited against those facts, scene by scene. And at the bottom — a fact ledger with row-level provenance, and a cryptographic proof signed by the server."

**VO-4 (Gauntlet, 0:38–1:18)**
"But here's the part that matters: anyone can verify any Plotline story. Watch me try to cheat. Flip the trend's direction — caught. Forge a perfect signature with my own key — caught: untrusted key. Swap one word in the prose — caught. Strip the proof entirely — it can never claim to be verified. Six attacks. Zero survived."

**VO-5 (Close, 1:18–1:28)**
"Plotline. Data stories you can actually trust. Live now on OKX-dot-AI — free to call."

### ElevenLabs settings (do exactly this)
1. Go to elevenlabs.io → **Text to Speech**.
2. Voice: search **"Brian"** (deep, calm documentary narrator) — or **"Adam"** if you want more energy. Preview both with VO-1 and pick the one you like.
3. Model: **Eleven Multilingual v2** (highest quality).
4. Settings sliders: **Stability 50%**, **Similarity 75%**, **Style 15%**, Speaker boost ON.
5. Paste **VO-1** → Generate → click the download icon → save as `vo1.mp3`. Repeat for VO-2 … VO-5.
6. Listen to each. If a word sounds rushed, add a comma where you want a breath and regenerate.

---

## 2. IMAGES TO GENERATE (Nano Banana Pro) — 2 images, both 16:9

> Rule: never ask the image model to draw text — text gets added later in CapCut.

**IMAGE-1 — The Hook (opening shot)**
```
Cinematic wide shot, 16:9. A sleek faceless humanoid AI robot in a dark
conference room presents a large holographic line chart that glows amber.
The chart is subtly wrong: the glowing line is dissolving into scattered,
crumbling pixels and drifting embers at its end, hinting the data is fake.
Moody midnight-blue color palette with a single warm amber light source,
volumetric haze, shallow depth of field, photorealistic render, dramatic
film lighting, no text, no words, no letters, no logos, no watermarks.
```

**IMAGE-2 — The Close (final card background)**
```
Minimalist abstract background, 16:9. A deep midnight-blue gradient canvas
with a single elegant amber line rising from lower-left to upper-right,
passing through a few small glowing nodes and ending in a bright four-point
star flare. A faint teal secondary line follows below it. Subtle dot-grid
texture, soft vignette, premium fintech aesthetic, clean negative space in
the center for a title, no text, no words, no letters, no logos.
```

---

## 3. RECORDING — step by step (like you're 6)

### A. One-time setup (10 minutes)
1. Download **OBS Studio** (free): obsproject.com → Download → install → open it.
2. When OBS asks, choose **"Optimize for recording"**.
3. Bottom-right → **Settings → Video**: set both Base and Output resolution to **1920×1080**, FPS **30** → OK.
4. Settings → **Output**: Recording quality **"High Quality, Medium File Size"**, format **MP4** → OK.
5. In the middle "Sources" box: click **+** → **Display Capture** → OK → OK. You should see your screen inside OBS.
6. IMPORTANT: click the microphone's speaker icon in the "Audio Mixer" to **MUTE it** (we use ElevenLabs voice, not yours).

### B. Prepare your screen (5 minutes)
1. Close every app except your browser and a terminal.
2. Browser: press `F11` (full screen) later when recording; hide bookmarks bar now (Ctrl+Shift+B).
3. Terminal: make it full screen and make the text BIG — in VS Code terminal press `Ctrl` + `+` about 4 times (aim for font size ~20). Dark theme.
4. In the terminal, get the demo ready but DON'T press Enter yet:
   ```bash
   cd /workspaces/okx_101 && node demo/attack-demo.mjs
   ```

### C. Record Clip 1 — "Create" (terminal, ~15s of footage)
1. In OBS click **Start Recording**.
2. Click on your terminal so it's focused. Wait 2 seconds.
3. Press **Enter**. The demo starts: it creates the story and prints the URL, then Act 1 begins.
4. Let it run ALL SIX ACTS — don't touch anything (~60 seconds total).
5. When the final "SIX ATTACKS" banner appears, wait 3 seconds, then in OBS click **Stop Recording**.
6. That single file contains BOTH the "create" moment and the whole Gauntlet. We'll cut it up in editing. Find the file: OBS menu → File → Show Recordings.  Rename it **gauntlet.mp4**.

### D. Record Clip 2 — "Beauty scroll" (browser, ~30s of footage)
1. Open **https://plotline-production-34e6.up.railway.app/story/b1h4v9ta68** in the browser.
2. Press `F11` for full screen. Press `Ctrl+0` so zoom is 100%.
3. In OBS click **Start Recording**. Wait 2 seconds.
4. Scroll SLOWLY and SMOOTHLY with the mouse wheel: two gentle notches, pause 1 second, two notches, pause… all the way to the bottom (the fact ledger + proof block). The page animates as you scroll — the pauses let the charts play.
5. At the very bottom, hover the proof block for 2 seconds.
6. Stop recording. Rename the file **story.mp4**.
7. Do this twice and keep the smoother take. Smooth scrolling is the whole game here.

---

## 4. EDITING in CapCut — step by step (like you're 6)

1. Download **CapCut** (free, desktop): capcut.com → open → **New project**.
2. Click **Import** → select: `gauntlet.mp4`, `story.mp4`, `image1.png`, `image2.png`, `vo1.mp3` … `vo5.mp3`. 
3. **Set the canvas**: right side → Ratio → **16:9**.

### Build the timeline in this exact order
4. **Drag IMAGE-1** to the timeline. Drag its right edge until it's **8 seconds** long.
   - With it selected → **Animation → In → "Zoom In (slow)"** so it slowly pushes in.
5. **Drag vo1.mp3** to the audio track under it. Line its start up with 0:00.
6. **Drag gauntlet.mp4** next on the video track. Find the moment the story URL prints (the "create" part) — **Split** (scissors icon) just before it, Split again after Act 1's banner appears, and DELETE everything before/after so you keep ~8s of "creating a story… URL… facts: 10". Place **vo2.mp3** under it.
7. **Drag story.mp4** next. Trim it to ~22 seconds of the smoothest scrolling (start at the hero, end on the proof block). Place **vo3.mp3** under it.
8. **Drag the rest of gauntlet.mp4** (Acts 1→6 + final banner) next.
   - It's ~55s of footage but only has ~40s of room: select it → **Speed → 1.4x**. The typewriter pacing was designed to survive this.
   - Place **vo4.mp3** under it. Nudge the clip so "Flip the trend's direction — caught" lands roughly when Act 2's ❌ banner pops. Don't stress about perfect sync; close is fine.
9. **Drag IMAGE-2** last, 10 seconds. Place **vo5.mp3** under it.
   - Click **Text → Add text**: type `Plotline` big and centered (white, bold). Below it smaller: `plotline-production-34e6.up.railway.app` and on a third line: `OKX.AI · Agent #5106 · #OKXAI`.
   - Text → Animation → In → "Fade".

### Polish (5 minutes)
10. **Music**: CapCut top menu → **Audio → Music → search "minimal tech ambient"** → pick something calm → drag it to a second audio track spanning the whole video → select it → **Volume → -25dB** (it must whisper, not compete).
11. **Transitions**: click the small square between each pair of clips → **Mix → "Fade"** → duration 0.3s.
12. Watch it once. Check: total length **≤ 90 seconds** (top-right shows duration). If over, trim the story scroll first, then increase gauntlet speed to 1.5x.
13. **Export** (top right): name `plotline-demo`, Resolution **1080p**, Frame rate 30, format MP4 → Export.

---

## 5. POST IT

X post text (copy-paste):

```
AI agents lie about data. Plotline makes that structurally impossible.

CSV in → cinematic data story out. Every fact computed, every claim signed,
and ANY agent can re-verify the whole thing — six attacks, zero survived.

Live on @OKX OKX.AI · free to call
🔗 plotline-production-34e6.up.railway.app
#OKXAI
```

Attach `plotline-demo.mp4`, post, then paste the post URL into the hackathon Google form together with:
- Repo: github.com/Tonyflam/okx_101
- Endpoint: https://plotline-production-34e6.up.railway.app/mcp
- Agent: #5106 (Plotline)
