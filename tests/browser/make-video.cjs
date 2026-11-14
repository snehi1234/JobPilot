// Builds store-assets/hiresprint-demo.mp4 (2560x1440, 60 fps) from the real extension UI:
//   1. narration: one voice clip per beat (tests/browser/video-narration.json)
//   2. recording: video.spec.cjs plays each beat for as long as its voice clip
//      and captures 3200x1800 frames over the DevTools protocol
//   3. compositing (sharp): camera zooms/pans, animated captions and chapter pills
//   4. colourful transitions between scenes (xfade)
//   5. audio: voice + sound effects + original music ducked under the voice,
//      two-pass loudness normalization to -14 LUFS
// Usage: node tests/browser/make-video.cjs
// Needs: Python with edge-tts, numpy, imageio-ffmpeg; npm dev dependency sharp;
// a built extension in dist/stage.
const { execFileSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..", "..");
const VARIANT = process.env.VIDEO_VARIANT || "main"; // "main" (store/YouTube) or "linkedin" (~60s, subtitles)
const DIR = process.env.VIDEO_WORK_DIR || path.join(os.tmpdir(), VARIANT === "linkedin" ? "hs-video-linkedin" : "hs-video3");
const VOICE = process.env.VIDEO_VOICE || "en-US-AndrewNeural";
const FFMPEG = execFileSync("python", ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], { encoding: "utf8" }).trim();
const OUT_W = 2560, OUT_H = 1440, FPS = 60;
const CAM_EASE = 0.9; // seconds per camera move
const XF = 0.55; // transition length
const TRANSITIONS = ["circleopen", "slideleft", "radial", "wipeup", "smoothleft", "squeezeh", "slideup", "diagtl", "smoothup", "wiperight"];
fs.mkdirSync(DIR, { recursive: true });

const ff = (args) => execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"], maxBuffer: 1 << 26 });

function duration(file) {
  const out = spawnSync(FFMPEG, ["-i", file], { encoding: "utf8" }).stderr;
  const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

function speak(text, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return;
  for (let attempt = 1; attempt <= 10; attempt++) {
    const r = spawnSync("python", ["-m", "edge_tts", "--voice", VOICE, "--rate=+4%", "--text", text, "--write-media", file], { encoding: "utf8" });
    if (r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 1000) return;
    console.log(`  voice retry ${attempt}…`);
    execFileSync("powershell", ["-NoProfile", "-Command", `Start-Sleep ${8 * attempt}`]);
  }
  throw new Error(`Couldn't generate narration for: ${text.slice(0, 40)}`);
}

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, p) => a + (b - a) * p;

// Camera rectangle (CSS px) at time t, easing between keyframes.
function cameraAt(cam, t) {
  let from = cam[0], to = cam[0], start = 0;
  const val = (time) => {
    const p = ease(clamp01((time - start) / CAM_EASE));
    return { x: lerp(from.x, to.x, p), y: lerp(from.y, to.y, p), w: lerp(from.w, to.w, p) };
  };
  for (let i = 1; i < cam.length && cam[i].t <= t; i++) {
    from = val(cam[i].t);
    to = cam[i];
    start = cam[i].t;
  }
  return val(t);
}

const overlayCache = new Map();
async function overlay(file) {
  if (!overlayCache.has(file)) {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    overlayCache.set(file, { data, width: info.width, height: info.height, faded: new Map() });
  }
  return overlayCache.get(file);
}
function withAlpha(ov, alpha) {
  const a = Math.round(clamp01(alpha) * 20);
  if (!ov.faded.has(a)) {
    const buf = Buffer.from(ov.data);
    for (let i = 3; i < buf.length; i += 4) buf[i] = Math.round((buf[i] * a) / 20);
    ov.faded.set(a, buf);
  }
  return ov.faded.get(a);
}

async function composite(scene, index) {
  const outDir = path.join(DIR, `out-${index}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const frames = scene.frames;
  if (!frames.length) throw new Error(`No frames for ${scene.name}`);
  const meta = await sharp(frames[0].file).metadata();
  const scale = meta.width / 1280;
  const total = Math.max(1, Math.round(scene.length * FPS));
  const captions = await Promise.all((scene.captions || []).map(async (c) => ({ ...c, ov: await overlay(c.png) })));
  const subs = await Promise.all((scene.subs || []).filter((s) => s.png).map(async (s) => ({ ...s, ov: await overlay(s.png) })));
  const chapter = scene.chapterPng ? await overlay(scene.chapterPng) : null;
  let src = 0;
  let lastKey = "";
  let lastBuf = null;
  const jobs = [];
  for (let k = 0; k < total; k++) {
    const t = k / FPS;
    while (src + 1 < frames.length && frames[src + 1].t <= t) src++;
    const cam = cameraAt(scene.cam, t);
    const layers = [];
    // Caption: the latest one, sliding up and fading in; fades out at the scene end.
    const cap = [...captions].reverse().find((c) => c.t <= t);
    if (cap) {
      const pIn = ease(clamp01((t - cap.t) / 0.4));
      const pOut = clamp01((scene.length - 0.35 - t) / 0.3);
      const alpha = Math.min(pIn, pOut);
      if (alpha > 0.02) {
        const left = Math.round((OUT_W - cap.ov.width) / 2);
        // With subtitles at the bottom, feature captions move to the top.
        const top = subs.length ? Math.round(150 - (1 - pIn) * 40) : Math.round(OUT_H - cap.ov.height - 70 + (1 - pIn) * 60);
        layers.push({ ov: cap.ov, alpha, left, top });
      }
    }
    const sub = subs.find((s) => t >= s.t && t <= s.t + s.dur + 0.25);
    if (sub) {
      const alpha = Math.min(clamp01((t - sub.t) / 0.15), clamp01((sub.t + sub.dur + 0.25 - t) / 0.15));
      layers.push({ ov: sub.ov, alpha, left: Math.round((OUT_W - sub.ov.width) / 2), top: OUT_H - sub.ov.height - 50 });
    }
    if (chapter) {
      const p = ease(clamp01((t - 0.15) / 0.6));
      const alpha = Math.min(p, clamp01((scene.length - 0.3 - t) / 0.3));
      if (alpha > 0.02) layers.push({ ov: chapter, alpha, left: Math.round(lerp(-chapter.width, 44, p)), top: 40 });
    }
    const key = `${src}|${cam.x.toFixed(1)},${cam.y.toFixed(1)},${cam.w.toFixed(1)}|${layers.map((l) => `${l.left},${l.top},${Math.round(l.alpha * 20)}`).join(";")}`;
    const file = path.join(outDir, `${String(k).padStart(6, "0")}.jpg`);
    if (key === lastKey && lastBuf) {
      const buf = lastBuf;
      jobs.push(buf.then((b) => fs.promises.writeFile(file, b)));
      continue;
    }
    lastKey = key;
    const sw = Math.min(meta.width, Math.round(cam.w * scale));
    const sh = Math.min(meta.height, Math.round(((cam.w * 9) / 16) * scale));
    const left = Math.max(0, Math.min(meta.width - sw, Math.round(cam.x * scale)));
    const top = Math.max(0, Math.min(meta.height - sh, Math.round(cam.y * scale)));
    lastBuf = sharp(frames[src].file)
      .extract({ left, top, width: sw, height: sh })
      .resize(OUT_W, OUT_H, { kernel: "lanczos3" })
      .composite(layers.map((l) => ({
        input: withAlpha(l.ov, l.alpha), raw: { width: l.ov.width, height: l.ov.height, channels: 4 },
        left: Math.max(0, l.left), top: Math.max(0, l.top),
      })).filter((l) => l.left < OUT_W && l.top < OUT_H))
      .jpeg({ quality: 93, chromaSubsampling: "4:4:4" })
      .toBuffer();
    const buf = lastBuf;
    jobs.push(buf.then((b) => fs.promises.writeFile(file, b)));
    if (jobs.length >= 24) await Promise.all(jobs.splice(0));
  }
  await Promise.all(jobs);
  const clip = path.join(DIR, `clip-${index}.mp4`);
  ff(["-framerate", String(FPS), "-i", path.join(outDir, "%06d.jpg"), "-c:v", "libx264", "-preset", "slow", "-crf", "14",
    "-pix_fmt", "yuv420p", "-color_range", "tv", clip]);
  fs.rmSync(outDir, { recursive: true, force: true });
  return { clip, length: total / FPS };
}

(async () => {
  // 1. Narration and sound effects
  const script = JSON.parse(fs.readFileSync(path.join(__dirname, VARIANT === "linkedin" ? "video-narration-linkedin.json" : "video-narration.json"), "utf8"));
  const beats = {};
  for (const [scene, lines] of Object.entries(script)) {
    beats[scene] = lines.map((text) => {
      const file = path.join(DIR, `voice-${crypto.createHash("sha1").update(VOICE + text).digest("hex").slice(0, 12)}.mp3`);
      speak(text, file);
      return { text, file, dur: duration(file) };
    });
  }
  fs.writeFileSync(path.join(DIR, "beats.json"), JSON.stringify(beats, null, 2));
  execFileSync("python", [path.join(__dirname, "video-sfx.py"), DIR], { stdio: "inherit" });

  // 2. Recording
  if (!process.env.VIDEO_SKIP_RECORD) {
    const run = spawnSync("npx.cmd", ["playwright", "test", "tests/browser/video.spec.cjs", "--reporter=line"], {
      cwd: ROOT, stdio: "inherit", shell: true,
      env: { ...process.env, JOBPILOT_VIDEO_DIR: DIR, JOBPILOT_EXTENSION_DIR: process.env.JOBPILOT_EXTENSION_DIR || path.join(ROOT, "dist", "stage") },
    });
    if (run.status !== 0) throw new Error("Recording failed.");
  }
  const scenes = JSON.parse(fs.readFileSync(path.join(DIR, "scenes.json"), "utf8"));

  // 3. Composite each scene
  const clips = [];
  for (const [i, scene] of scenes.entries()) {
    const t0 = Date.now();
    const cached = path.join(DIR, `clip-${i}.mp4`);
    clips.push(process.env.VIDEO_SKIP_COMPOSITE && fs.existsSync(cached) ? { clip: cached, length: Math.round(scene.length * FPS) / FPS } : await composite(scene, i));
    console.log(`scene ${scene.name}: ${clips[i].length.toFixed(1)}s (${((Date.now() - t0) / 1000).toFixed(0)}s to render)`);
  }

  // 4. Transitions
  const starts = [0];
  for (let i = 1; i < clips.length; i++) starts.push(starts[i - 1] + clips[i - 1].length - XF);
  const total = starts.at(-1) + clips.at(-1).length;
  const vf = [];
  let last = "[0:v]";
  for (let i = 1; i < clips.length; i++) {
    const outLabel = i === clips.length - 1 ? "[vout]" : `[v${i}]`;
    vf.push(`${last}[${i}:v]xfade=transition=${TRANSITIONS[(i - 1) % TRANSITIONS.length]}:duration=${XF}:offset=${starts[i].toFixed(3)}${outLabel}`);
    last = outLabel;
  }
  const video = path.join(DIR, "video.mp4");
  ff([...clips.flatMap((c) => ["-i", c.clip]), "-filter_complex", vf.join(";"), "-map", "[vout]",
    "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-pix_fmt", "yuv420p", "-r", String(FPS), video]);

  // 5. Audio
  const SFX_GAIN = { click: 0.5, pop: 0.5, whoosh: 0.2, chime: 0.4 };
  const voiceEvents = scenes.flatMap((s, i) => s.voice.map((v) => ({ file: v.file, at: starts[i] + v.offset })));
  const sfxEvents = [
    ...scenes.flatMap((s, i) => s.sfx.filter((e) => e.name !== "whoosh").map((e) => ({ name: e.name, at: starts[i] + e.t }))),
    ...starts.slice(1).map((s) => ({ name: "whoosh", at: Math.max(0, s - 0.1) })),
  ];
  const mixTrack = (events, file, gainOf) => {
    const inputs = events.flatMap((e) => ["-i", e.file]);
    const parts = events.map((e, k) => `[${k}:a]volume=${gainOf(e)},adelay=${Math.round(e.at * 1000)}:all=1[a${k}]`);
    ff([...inputs, "-filter_complex", `${parts.join(";")};${events.map((_, k) => `[a${k}]`).join("")}amix=inputs=${events.length}:normalize=0,apad,atrim=0:${total.toFixed(3)},aresample=48000[o]`,
      "-map", "[o]", "-ac", "2", file]);
  };
  const voiceWav = path.join(DIR, "voice.wav");
  const sfxWav = path.join(DIR, "sfx.wav");
  mixTrack(voiceEvents, voiceWav, () => 1);
  mixTrack(sfxEvents.map((e) => ({ ...e, file: path.join(DIR, `${e.name}.wav`) })), sfxWav, (e) => SFX_GAIN[e.name] || 0.5);
  const music = path.join(DIR, "music.wav");
  execFileSync("python", [path.join(__dirname, "video-music.py"), String(Math.ceil(total) + 1), music], { stdio: "inherit" });
  const mixed = path.join(DIR, "mixed.wav");
  ff(["-i", voiceWav, "-i", sfxWav, "-i", music, "-filter_complex",
    "[0:a]asplit=2[voice][key];[2:a]volume=0.4[bed];[bed][key]sidechaincompress=threshold=0.04:ratio=5:attack=25:release=500[ducked];" +
    `[voice][1:a][ducked]amix=inputs=3:normalize=0,atrim=0:${total.toFixed(3)}[o]`, "-map", "[o]", "-ar", "48000", mixed]);
  // Two-pass loudness normalization (linear, so the mix balance is kept).
  const pass1 = spawnSync(FFMPEG, ["-i", mixed, "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const m = JSON.parse(pass1.slice(pass1.lastIndexOf("{"), pass1.lastIndexOf("}") + 1));
  const audio = path.join(DIR, "audio.m4a");
  ff(["-i", mixed, "-af", `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
    "-c:a", "aac", "-b:a", "256k", audio]);

  const target = path.join(ROOT, "store-assets", VARIANT === "linkedin" ? "hiresprint-demo-linkedin.mp4" : "hiresprint-demo.mp4");
  ff(["-i", video, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", "-shortest", "-movflags", "+faststart", target]);
  console.log(`wrote ${target} (${duration(target).toFixed(1)}s, ${OUT_W}x${OUT_H} @ ${FPS} fps)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
