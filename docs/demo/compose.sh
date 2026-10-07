#!/bin/bash
# compose.sh <scene>  → out/<scene>.mp4 (1920x1200 for X) + out/<scene>.gif (README)
set -e
S=$1; mkdir -p out
python3 assemble.py $S raw-$S.mp4 >/dev/null
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 raw-$S.mp4)
ffmpeg -y -loglevel error -loop 1 -t $D -i stage-bg.png -i raw-$S.mp4 -loop 1 -t $D -i stage-mask.png -filter_complex \
 "[1:v]scale=1600:1000:flags=lanczos,format=rgba[v];[2:v]format=gray,scale=1600:1000[m];[v][m]alphamerge[vm];[0:v][vm]overlay=160:120:shortest=1,format=yuv420p" \
 -c:v libx264 -crf 17 -preset slow -r 30 -movflags +faststart out/$S.mp4
ffmpeg -y -loglevel error -i out/$S.mp4 -vf "fps=15,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" out/$S.gif
echo "✓ $S  mp4 $(du -h out/$S.mp4|cut -f1)  gif $(du -h out/$S.gif|cut -f1)  $(ffprobe -v error -show_entries format=duration -of csv=p=0 out/$S.mp4)s"
