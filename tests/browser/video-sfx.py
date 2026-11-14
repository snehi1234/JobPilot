# Generates short original sound effects for the demo video.
# Usage: python video-sfx.py <out_dir>
import os
import sys
import wave

import numpy as np

SR = 48000
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
rng = np.random.default_rng(3)


def save(name, sig):
    sig = sig / (np.abs(sig).max() + 1e-9) * 0.9
    st = np.stack([sig, sig], axis=1)
    with wave.open(os.path.join(OUT, name), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((st * 32767).astype(np.int16).tobytes())


def t(sec):
    return np.arange(int(SR * sec)) / SR


def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for k in range(len(x)):
        acc = (1 - a) * x[k] + a * acc
        y[k] = acc
    return y


# Click: short bright tick
x = t(0.05)
save("click.wav", (np.sin(2 * np.pi * 2400 * x) * 0.6 + rng.standard_normal(len(x)) * 0.25) * np.exp(-x * 140))

# Pop: pitched blip that slides up
x = t(0.14)
f = 520 + 900 * x / 0.14
save("pop.wav", np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x * 30) * np.minimum(1, x / 0.004))

# Whoosh: filtered noise swelling and fading, for transitions
x = t(0.6)
env = np.sin(np.pi * x / 0.6) ** 2
noise = rng.standard_normal(len(x))
sweep = np.concatenate([lowpass(noise[i:i + 2400], 600 + 5000 * (i / len(x))) for i in range(0, len(x), 2400)])[: len(x)]
save("whoosh.wav", sweep * env)

# Chime: two bright notes (success)
x = t(0.9)
chime = np.zeros(len(x))
for start, freq in ((0.0, 1046.5), (0.11, 1568.0)):
    i = int(start * SR)
    seg = x[: len(x) - i]
    chime[i:] += (np.sin(2 * np.pi * freq * seg) + 0.3 * np.sin(2 * np.pi * 2 * freq * seg)) * np.exp(-seg * 5)
save("chime.wav", chime)
print("sfx written to", OUT)
