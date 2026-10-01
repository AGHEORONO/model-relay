"""Render the README demo GIFs as fake terminal recordings.

    python assets/src/make_gifs.py <shelf-output.txt>

Needs Pillow and a monospace font with box-drawing glyphs (JetBrains Mono,
Cascadia Mono). The shelf GIF replays real `node server/src/shelf.js` output.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent
FONT_CANDIDATES = [
    "C:/Windows/Fonts/JetBrainsMonoNerdFontMono-Regular.ttf",
    "C:/Windows/Fonts/CascadiaMono.ttf",
    "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf",
    "/System/Library/Fonts/Menlo.ttc",
]
SIZE = 15
FONT_PATH = next(f for f in FONT_CANDIDATES if Path(f).exists())
FONT = ImageFont.truetype(FONT_PATH, SIZE)
# Glyphs the mono font lacks (★ ⇄ ⎿) come from a symbol font, one cell wide.
FALLBACK_PATH = next((f for f in ["C:/Windows/Fonts/seguisym.ttf",
                                  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"] if Path(f).exists()), None)
FALLBACK = ImageFont.truetype(FALLBACK_PATH, SIZE - 1) if FALLBACK_PATH else FONT
try:
    from fontTools.ttLib import TTFont
    CMAP = set(TTFont(FONT_PATH, fontNumber=0).getBestCmap())
except Exception:  # no fontTools: trust the primary font
    CMAP = None
CW = FONT.getbbox("M")[2]
LH = SIZE + 6
PAD = 20

BG = (14, 16, 20)
FG = (236, 237, 238)
DIM = (155, 161, 166)
AMBER = (245, 165, 36)
BLUE = (96, 165, 250)
GREEN = (52, 211, 153)
VIOLET = (167, 139, 250)


def frame(lines, cols, rows):
    """lines: list of rows; each row is a str or a list of (text, colour)."""
    img = Image.new("RGB", (PAD * 2 + cols * CW, PAD * 2 + rows * LH), BG)
    d = ImageDraw.Draw(img)
    for r, line in enumerate(lines[-rows:]):
        x = PAD
        for text, colour in [(line, FG)] if isinstance(line, str) else line:
            for ch in text:
                font = FONT if CMAP is None or ord(ch) in CMAP else FALLBACK
                d.text((x, PAD + r * LH), ch, font=font, fill=colour)
                x += CW
    return img


def save(name, frames):
    """frames: list of (image, ms)."""
    imgs = [f.convert("P", palette=Image.ADAPTIVE, colors=32) for f, _ in frames]
    imgs[0].save(
        OUT / name, save_all=True, append_images=imgs[1:],
        duration=[ms for _, ms in frames], loop=0, optimize=True,
    )
    print("wrote", OUT / name)


def typing(prefix_lines, prompt, cols, rows, ms=70):
    out = []
    for i in range(len(prompt) + 1):
        out.append((frame(prefix_lines + [[("> ", AMBER), (prompt[:i] + "▌", FG)]], cols, rows), ms))
    return out


def shelf_gif(shelf_text):
    lines = shelf_text.rstrip("\n").split("\n")
    cols, rows = max(len(l) for l in lines) + 2, 30
    frames = typing([], "/shelf", cols, rows, 110)
    frames.append((frame([[("> ", AMBER), ("/shelf", FG)], [("  ⎿  asking each CLI for its models…", DIM)]], cols, rows), 900))
    shown = [[("> ", AMBER), ("/shelf", FG)], ""]
    for l in lines:
        shown.append(l)
        frames.append((frame(shown, cols, rows), 45))
    frames.append((frame(shown, cols, rows), 3500))
    save("shelf.gif", frames)


def status(five, active, manual=False):
    relay = [("⇄ RELAY ON" + (" (manual)" if manual else ""), AMBER)] if active else [("relay auto @50%", DIM)]
    bar_on = round(five / 5)
    return [("Opus 5.5 · ctx 31%  │  5h ", DIM), (f"{five}% ", AMBER if active else FG),
            ("█" * bar_on, AMBER if active else BLUE), ("░" * (20 - bar_on), DIM), ("  ", DIM)] + relay


def relay_gif():
    cols, rows = 96, 16
    convo = [
        [("> ", AMBER), ("refactor the parser and write tests for it", FG)],
        [("● ", GREEN), ("Reading src/parser.js …", DIM)],
        "",
    ]
    frames = []
    for pct in range(41, 53):
        active = pct >= 50
        body = convo + ([] if not active else [
            [("● ", AMBER), ("Relay on — 5-hour limit at %d%% ≥ 50%%. Handing drafts to other models." % pct, FG)],
        ])
        screen = body + [""] * (rows - len(body) - 2) + ["─" * cols, status(pct, active)]
        frames.append((frame(screen, cols, rows), 380 if not active else 700))
    tail = convo + [
        [("● ", AMBER), ("Relay on — 5-hour limit at 52% ≥ 50%. Handing drafts to other models.", FG)],
        [("● ", BLUE), ("model-router · ask_model", FG), ("(antigravity:gemini-3.8-flash-low, effort: low)", DIM)],
        [("  ⎿  ", DIM), ("draft tests received · 9.5s · via subscription", GREEN)],
        [("● ", BLUE), ("model-router · ask_model", FG), ("(codex, effort: high)", DIM)],
        [("  ⎿  ", DIM), ("parser refactor proposal received · 41s", GREEN)],
        [("● ", GREEN), ("Reviewing both against the repo before applying…", FG)],
    ]
    for i in range(len(convo) + 1, len(tail) + 1):
        screen = tail[:i] + [""] * (rows - i - 2) + ["─" * cols, status(52, True)]
        frames.append((frame(screen, cols, rows), 900))
    frames.append((frames[-1][0], 3500))
    save("relay.gif", frames)


def manual_gif():
    cols, rows = 96, 12
    frames = typing([], "/relay on", cols, rows, 110)
    out = [
        [("> ", AMBER), ("/relay on", FG)],
        [("Relay:      ", DIM), ("ON  ⇄", AMBER), ("   (turned on manually)", DIM)],
        [("Mode:       ", DIM), ("on", FG)],
        [("5-hour:      ", DIM), ("12% ", FG), ("██", BLUE), ("░" * 18, DIM)],
        [("Weekly:      ", DIM), ("40% ", FG), ("████████", BLUE), ("░" * 12, DIM)],
        [("Statusline: ", DIM), ("installed", GREEN)],
    ]
    for i in range(2, len(out) + 1):
        screen = out[:i] + [""] * (rows - i - 2) + ["─" * cols, status(12, True, manual=True)]
        frames.append((frame(screen, cols, rows), 250))
    frames.append((frames[-1][0], 3000))
    save("manual.gif", frames)


if __name__ == "__main__":
    shelf_gif(Path(sys.argv[1]).read_text(encoding="utf-8"))
    relay_gif()
    manual_gif()
