"""frames/<scene>/frames.json → <scene>.mp4 (real timing, with sped-up segments)."""
import json, subprocess, sys, os
scene = sys.argv[1]; out = sys.argv[2]
d = f"frames/{scene}"
j = json.load(open(f"{d}/frames.json"))
fr, marks, end = j["frames"], j["marks"], j["end"]
def speed_at(t):
    s = 1
    for m in marks:
        if m["t"] <= t: s = m["speed"]
    return s
lines = []
for i, f in enumerate(fr):
    t1 = fr[i + 1]["t"] if i + 1 < len(fr) else end
    dur = max(0.0, (t1 - f["t"]) / speed_at(f["t"]))
    lines += [f"file '{os.path.abspath(f['file'])}'", f"duration {dur:.4f}"]
lines.append(f"file '{os.path.abspath(fr[-1]['file'])}'")
open(f"{d}/list.txt", "w").write("\n".join(lines))
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", f"{d}/list.txt",
                "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-preset", "slow", out], check=True)
print("✓", out)
