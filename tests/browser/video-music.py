# Generates an original, royalty-free background track for the demo video.
# Usage: python video-music.py <seconds> <out.wav>
import sys
import wave

import numpy as np

SR = 48000
BPM = 104
BEAT = 60 / BPM
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 90
OUT = sys.argv[2] if len(sys.argv) > 2 else "music.wav"
rng = np.random.default_rng(7)
n = int(SR * (DUR + 2))
L = np.zeros(n)
R = np.zeros(n)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def add(buf, start, sig, gain=1.0):
    i = int(start * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i] * gain


def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for k in range(len(x)):
        acc = (1 - a) * x[k] + a * acc
        y[k] = acc
    return y


def saw(f, t, harmonics=7):
    s = np.zeros_like(t)
    for h in range(1, harmonics + 1):
        s += np.sin(2 * np.pi * f * h * t) / h
    return s


# I – vi – IV – V in C, as MIDI chords
CHORDS = [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65]]
BAR = 4 * BEAT
bars = int(DUR / BAR) + 2

# Pads (slow attack, gentle filter, slight stereo detune)
pad_len = BAR
t = np.arange(int(pad_len * SR)) / SR
env = np.minimum(1, t / 0.6) * np.minimum(1, (pad_len - t) / 0.5)
pad_cache = {}
for b in range(bars):
    chord = CHORDS[b % 4]
    key = b % 4
    if key not in pad_cache:
        left = sum(saw(hz(m), t) for m in chord)
        right = sum(saw(hz(m) * 1.003, t) for m in chord)
        pad_cache[key] = (lowpass(left * env, 1400), lowpass(right * env, 1400))
    pl, pr = pad_cache[key]
    add(L, b * BAR, pl, 0.035)
    add(R, b * BAR, pr, 0.035)

# Plucked arpeggio (8th notes), enters after 2 bars
pl_t = np.arange(int(0.5 * SR)) / SR
pl_env = np.exp(-pl_t * 9)
pluck_cache = {}
pattern = [0, 1, 2, 3, 2, 1, 2, 3]
for b in range(2, bars):
    chord = CHORDS[b % 4]
    for s, idx in enumerate(pattern):
        m = chord[idx] + 12
        if m not in pluck_cache:
            f = hz(m)
            sig = (np.sin(2 * np.pi * f * pl_t) + 0.35 * np.sin(2 * np.pi * 2 * f * pl_t) + 0.15 * np.sin(2 * np.pi * 3 * f * pl_t)) * pl_env
            pluck_cache[m] = sig
        start = b * BAR + s * BEAT / 2
        pan = 0.35 if s % 2 else 0.65
        add(L, start, pluck_cache[m], 0.06 * (1 - pan) * 2)
        add(R, start, pluck_cache[m], 0.06 * pan * 2)

# Bass on each beat (root), from bar 2
b_t = np.arange(int(BEAT * SR)) / SR
b_env = np.minimum(1, b_t / 0.01) * np.exp(-b_t * 3.5)
for b in range(2, bars):
    root = CHORDS[b % 4][0] - 24
    f = hz(root)
    sig = (np.sin(2 * np.pi * f * b_t) + 0.25 * np.sign(np.sin(2 * np.pi * f * b_t))) * b_env
    for beat in range(4):
        add(L, b * BAR + beat * BEAT, sig, 0.11)
        add(R, b * BAR + beat * BEAT, sig, 0.11)

# Drums from bar 4: kick on every beat, clap on 2 & 4, hats on off-beats
k_t = np.arange(int(0.35 * SR)) / SR
kick = np.sin(2 * np.pi * (45 * k_t + (120 - 45) / 18 * (1 - np.exp(-18 * k_t)))) * np.exp(-k_t * 9)
c_t = np.arange(int(0.2 * SR)) / SR
noise = rng.standard_normal(len(c_t))
clap = np.diff(noise, prepend=0) * np.exp(-c_t * 22)
h_t = np.arange(int(0.06 * SR)) / SR
hat = np.diff(rng.standard_normal(len(h_t)), prepend=0) * np.exp(-h_t * 70)
for b in range(4, bars):
    for beat in range(4):
        t0 = b * BAR + beat * BEAT
        add(L, t0, kick, 0.22)
        add(R, t0, kick, 0.22)
        if beat in (1, 3):
            add(L, t0, clap, 0.05)
            add(R, t0, clap, 0.05)
        add(L, t0 + BEAT / 2, hat, 0.03)
        add(R, t0 + BEAT / 2, hat, 0.035)

# Trim, fade in/out, normalize
L = L[: int(SR * DUR)]
R = R[: int(SR * DUR)]
fade = np.ones(len(L))
fi = int(SR * 1.0)
fo = int(SR * 3.0)
fade[:fi] = np.linspace(0, 1, fi)
fade[-fo:] = np.linspace(1, 0, fo)
L *= fade
R *= fade
peak = max(np.abs(L).max(), np.abs(R).max(), 1e-9)
stereo = np.stack([L, R], axis=1) / peak * 0.85
pcm = (stereo * 32767).astype(np.int16)
with wave.open(OUT, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f"wrote {OUT} ({DUR:.1f}s)")
