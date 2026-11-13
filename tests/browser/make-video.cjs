// Stitches the scenes recorded by video.spec.cjs into store-assets/hiresprint-demo.mp4,
// with a narration voice-over (tests/browser/video-narration.json, one line per scene).
// Usage: node tests/browser/make-video.cjs <recordDir> <ffmpegPath>
// Narration uses the `edge-tts` Python package (pip install edge-tts).
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [dir, ffmpeg] = process.argv.slice(2);
const VOICE = process.env.VIDEO_VOICE || "en-US-AndrewNeural";
const scenes = JSON.parse(fs.readFileSync(path.join(dir, "scenes.json"), "utf8"));
const lines = JSON.parse(fs.readFileSync(path.join(__dirname, "video-narration.json"), "utf8"));
if (lines.length !== scenes.length) throw new Error(`Need ${scenes.length} narration lines, found ${lines.length}.`);

function mediaDuration(file) {
  const out = spawnSync(ffmpeg, ["-i", file], { encoding: "utf8" }).stderr;
  const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

function speak(text, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return;
  // The speech service sometimes throttles; wait and retry.
  for (let attempt = 1; attempt <= 8; attempt++) {
    const r = spawnSync("python", ["-m", "edge_tts", "--voice", VOICE, "--rate=+4%", "--text", text, "--write-media", file], { encoding: "utf8" });
    if (r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 1000) return;
    console.log(`  voice retry ${attempt}…`);
    execFileSync("powershell", ["-NoProfile", "-Command", `Start-Sleep ${10 * attempt}`]);
  }
  throw new Error(`Couldn't generate narration for: ${text.slice(0, 40)}`);
}

const LEAD = 0.35; // narration starts just after each scene fades in
const TAIL = 0.6;
const parts = [];
scenes.forEach((scene, i) => {
  const audio = path.join(dir, `narr${i}.mp3`);
  speak(lines[i], audio);
  const clip = Math.max(0.5, scene.end - scene.start);
  const speech = mediaDuration(audio);
  const dur = Math.max(clip, speech + LEAD + TAIL);
  // Stretch the footage a little to fit longer narration, then hold the last frame.
  const slow = Math.min(1.3, dur / clip);
  const hold = Math.max(0, dur - clip * slow);
  const out = path.join(dir, `part${i}.mp4`);
  execFileSync(ffmpeg, [
    "-y", "-loglevel", "error",
    "-ss", scene.start.toFixed(2), "-t", clip.toFixed(2), "-i", scene.video,
    "-i", audio,
    "-filter_complex",
    `[0:v]setpts=${slow.toFixed(3)}*PTS,fps=30,scale=1280:720:flags=lanczos,format=yuv420p,` +
      `tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)},` +
      `fade=t=in:st=0:d=0.35,fade=t=out:st=${(dur - 0.35).toFixed(2)}:d=0.35[v];` +
      `[1:a]adelay=${Math.round(LEAD * 1000)}:all=1,apad,atrim=0:${dur.toFixed(2)},aresample=48000,` +
      `loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
    "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(2),
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", out,
  ]);
  parts.push(out);
  console.log(`scene ${i}: footage ${clip.toFixed(1)}s, voice ${speech.toFixed(1)}s → ${dur.toFixed(1)}s`);
});
const list = path.join(dir, "list.txt");
fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
const target = path.join(__dirname, "..", "..", "store-assets", "hiresprint-demo.mp4");
execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", target]);
console.log(`wrote ${target} (${mediaDuration(target).toFixed(1)}s)`);
