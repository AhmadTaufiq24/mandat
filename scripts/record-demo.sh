#!/usr/bin/env bash
# Rekam demo Mandat ke file log terminal.
# Untuk video MP4: jalankan sambil rekam layar (QuickTime / Cmd+Shift+5).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p recordings
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="recordings/demo-${STAMP}.log"

echo "Rekaman demo Mandat"
echo "Log: $LOG"
echo ""
echo "Untuk video: rekam layar terminal saat script ini berjalan."
echo "  macOS: Cmd+Shift+5 > Record Selected Portion"
echo "  atau QuickTime > File > New Screen Recording"
echo ""

{
  echo "=== Mandat Demo Recording ==="
  echo "Started: $(date)"
  echo ""
  MANDAT_DEMO=1 bash scripts/run-demo.sh
  echo ""
  echo "Finished: $(date)"
} 2>&1 | tee "$LOG"

echo ""
echo "Selesai. Log: $LOG"
