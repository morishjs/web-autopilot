#!/bin/bash
# Check if nav-index exists in the project, print guidance if not

NAV_INDEX="${NAV_INDEX_PATH:-docs/ui-nav-index.yaml}"

if [ ! -f "$NAV_INDEX" ]; then
  echo "[web-autopilot] nav-index not found at $NAV_INDEX"
  echo "  Run: bunx web-autopilot init"
  echo "  Or create docs/ui-nav-index.yaml manually"
fi
