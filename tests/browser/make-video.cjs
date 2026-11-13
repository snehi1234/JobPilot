// Builds store-assets/hiresprint-demo.mp4 (1920x1080) from the real extension UI:
//   1. narration: one voice clip per beat (tests/browser/video-narration.json)
//   2. recording: video.spec.cjs plays each beat for as long as its voice clip
//      and captures 1080p frames over the DevTools protocol
//   3. music: an original track (video-music.py), ducked under the voice
//   4. mix + encode (H.264, 30 fps)
// Usage: node tests/browser/make-video.cjs
// Needs: Python with edge-tts, numpy, imageio-ffmpeg; a built extension in dist/stage.
const { execFileSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const DIR = process.env.VIDEO_WORK_DIR || path.join(os.tmpdir(), "hs-video2");
const VOICE = process.env.VIDEO_VOICE || "en-US-AndrewNeural";
const FFMPEG = execFileSync("python", ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], { encoding: "utf8" }).trim();
fs.mkdirSync(DIR, { recursive: true });

function duration(file) {
  const out = spawnSync(FFMPEG, ["-i", file], { encoding: "utf8" }).stderr;
  const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

function speak(text, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return;
  for (let attempt = 1; attempt <= 10; attempt++) {
    const r = spawnSync("python", ["-m", "edge_tts", "--voice", VOICE, "--rate=+3%", "--text", text, "--write-media", file], { encoding: "utf8" });
    if (r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 1000) return;
    console.log(`  voice retry ${attempt}…`);
    execFileSync("powershell", ["-NoProfile", "-Command", `Start-Sleep ${8 * attempt}`]);
  }
  throw new Error(`Couldn't generate narration for: ${text.slice(0, 40)}`);
}

// 1. Narration
const script = JSON.parse(fs.readFileSync(path.join(__dirname, "video-narration.json"), "utf8"));
const beats = {};
for (const [scene, lines] of Object.entries(script)) {
  beats[scene] = lines.map((text) => {
    const file = path.join(DIR, `voice-${crypto.createHash("sha1").update(VOICE + text).digest("hex").slice(0, 12)}.mp3`);
    speak(text, file);
    return { text, file, dur: duration(file) };
  });
  console.log(`voice ${scene}: ${beats[scene].map((b) => b.dur.toFixed(1)).join(" + ")}s`);
}
fs.writeFileSync(path.join(DIR, "beats.json"), JSON.stringify(beats, null, 2));

// 2. Recording
const run = spawnSync("npx.cmd", ["playwright", "test", "tests/browser/video.spec.cjs", "--reporter=line"], {
  cwd: ROOT, stdio: "inherit", shell: true,
  env: { ...process.env, JOBPILOT_VIDEO_DIR: DIR, JOBPILOT_EXTENSION_DIR: process.env.JOBPILOT_EXTENSION_DIR || path.join(ROOT, "dist", "stage") },
});
if (run.status !== 0) throw new Error("Recording failed.");
const scenes = JSON.parse(fs.readFileSync(path.join(DIR, "scenes.json"), "utf8"));

// Each scene: frames → constant 30 fps clip, with its voice clips at their offsets.
const parts = [];
scenes.forEach((scene, i) => {
  const list = path.join(scene.dir, "frames.txt");
  const audioInputs = scene.voice.flatMap((v) => ["-i", v.file]);
  const delays = scene.voice.map((v, k) => `[${k + 1}:a]adelay=${Math.round(v.offset * 1000)}:all=1[a${k}]`);
  const mix = scene.voice.length
    ? `${delays.join(";")};${scene.voice.map((_, k) => `[a${k}]`).join("")}amix=inputs=${scene.voice.length}:normalize=0,apad,atrim=0:${scene.length.toFixed(2)}[a]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${scene.length.toFixed(2)}[a]`;
  const out = path.join(DIR, `part${i}.mp4`);
  execFileSync(FFMPEG, [
    "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, ...audioInputs,
    "-filter_complex",
    `[0:v]fps=30,scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p,trim=0:${scene.length.toFixed(2)},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=0.3,fade=t=out:st=${(scene.length - 0.3).toFixed(2)}:d=0.3[v];${mix}`,
    "-map", "[v]", "-map", "[a]", "-t", scene.length.toFixed(2),
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", out,
  ]);
  parts.push(out);
  console.log(`scene ${scene.name}: ${scene.length.toFixed(1)}s`);
});
const list = path.join(DIR, "parts.txt");
fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
const voiced = path.join(DIR, "voiced.mp4");
execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", voiced]);

// 3. Music, ducked under the narration; 4. final encode
const total = duration(voiced);
const music = path.join(DIR, "music.wav");
execFileSync("python", [path.join(__dirname, "video-music.py"), String(Math.ceil(total) + 1), music], { stdio: "inherit" });
const target = path.join(ROOT, "store-assets", "hiresprint-demo.mp4");
execFileSync(FFMPEG, [
  "-y", "-loglevel", "error", "-i", voiced, "-i", music,
  "-filter_complex",
  "[0:a]volume=1.6,asplit=2[voice][key];[1:a]volume=0.22[bed];[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=450[ducked];" +
    `[voice][ducked]amix=inputs=2:normalize=0,atrim=0:${total.toFixed(2)},alimiter=limit=0.89[a]`,
  "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", target,
]);
console.log(`wrote ${target} (${duration(target).toFixed(1)}s)`);
