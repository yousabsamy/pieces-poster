"""Puts a video in a 4:5 frame (filled with a blurred copy of itself) and the shop logo in its calmest corner.

Used by .github/workflows/video-logo.yml:  python3 video_logo.py in.video logo.png out.mp4
- 4:5 is the shape Facebook shows in full, so nothing is cut.
- The logo is 16% of the width. It goes where the video has the least detail, so it doesn't cover the piece.
  Bottom-right is never used: Facebook puts its sound button there. Top-right is the usual place.
- Keeps the file under 19 MB (the bot can only download 20 MB from Telegram).
"""
import os, subprocess, sys

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")

W, H = 1080, 1350
LOGO_W = round(W * 0.16)
MARGIN = round(W * 0.03)
CHECK_W, CHECK_H = 40, 50
CORNERS = ["top-right", "top-left", "bottom-left"]      # first one is the usual place

src, logo, out = sys.argv[1:4]
FRAME = (f"split=2[a][b];[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
         f"gblur=sigma=40,eq=brightness=-0.06[bg];"
         f"[b]scale={W}:{H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];"
         f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1")


def calm_corner():
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", src, "-filter_complex",
                          f"[0:v]{FRAME},fps=2,scale={CHECK_W}:{CHECK_H},format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    size = CHECK_W * CHECK_H
    frames = [raw[i:i + size] for i in range(0, len(raw) - size + 1, size)] or [bytes(size)]
    bw = round(CHECK_W * 0.22); bh = round(bw * 640 / 620) + 1
    spots = {"top-right": (CHECK_W - bw, 0), "top-left": (0, 0), "bottom-left": (0, CHECK_H - bh)}
    score = {}
    for name, (x0, y0) in spots.items():
        total = n = 0
        for g in frames:
            for y in range(y0, y0 + bh - 1):
                for x in range(x0, x0 + bw - 1):
                    i = y * CHECK_W + x
                    total += abs(g[i] - g[i + 1]) + abs(g[i] - g[i + CHECK_W]); n += 1
        score[name] = total / max(n, 1)
    print("detail in each corner:", {k: round(v, 1) for k, v in score.items()})
    usual, others = CORNERS[0], CORNERS[1:]
    calmest = min(others, key=score.get)
    return calmest if score[calmest] < score[usual] * 0.85 else usual


corner = calm_corner()
x = f"W-w-{MARGIN}" if corner.endswith("right") else f"{MARGIN}"
y = f"{MARGIN}" if corner.startswith("top") else f"H-h-{MARGIN}"
print("logo goes:", corner)

has_audio = "Audio:" in subprocess.run([FFMPEG, "-hide_banner", "-i", src], capture_output=True, text=True).stderr
for crf in (20, 23, 26, 29, 32):
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-i", logo, "-filter_complex",
           f"[0:v]{FRAME}[base];[1:v]scale={LOGO_W}:-1[logo];[base][logo]overlay=x={x}:y={y},format=yuv420p[v]",
           "-map", "[v]", "-c:v", "libx264", "-preset", "slow", "-crf", str(crf), "-movflags", "+faststart"]
    cmd += ["-map", "0:a", "-c:a", "aac", "-b:a", "128k"] if has_audio else []
    subprocess.run(cmd + [out], check=True)
    size = os.path.getsize(out)
    print(f"crf {crf} -> {size} bytes")
    if size < 19_000_000:
        break
