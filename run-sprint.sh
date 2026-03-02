#!/bin/bash
# Loopwright Sprint 1 — Agent Launcher (No Docker)
# Usage: ./run-sprint.sh <day> <agent>
# Example: ./run-sprint.sh 1 1    (Day 1, Agent 1 — Engram work)
#          ./run-sprint.sh 1 2    (Day 1, Agent 2 — Loopwright work)
#          ./run-sprint.sh 3 both (Day 3, both agents in parallel)

set -euo pipefail

DAY="${1:?Usage: ./run-sprint.sh <day> <agent|both>}"
AGENT="${2:?Usage: ./run-sprint.sh <day> <agent|both>}"
MAX_TURNS="${MAX_TURNS:-40}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPTS_DIR="$SCRIPT_DIR/prompts"
ENGRAM_DIR="/home/prosperitylabs/Desktop/development/engram"
LOOPWRIGHT_DIR="/home/prosperitylabs/Desktop/development/Loopwright"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

run_claude() {
    local prompt_file="$1"
    local work_dir="$2"
    local label="$3"

    echo -e "${GREEN}[Loopwright]${NC} Starting ${label}..."
    echo -e "${BLUE}  Prompt:${NC} $prompt_file"
    echo -e "${BLUE}  Working dir:${NC} $work_dir"
    echo -e "${BLUE}  Max turns:${NC} $MAX_TURNS"
    echo ""

    claude --dangerously-skip-permissions \
           --max-turns "$MAX_TURNS" \
           --print \
           "$(cat "$prompt_file")" \
           2>&1 | tee "$SCRIPT_DIR/logs/day${DAY}_${label}.log"
}

run_codex() {
    local prompt_file="$1"
    local work_dir="$2"
    local label="$3"

    echo -e "${GREEN}[Loopwright]${NC} Starting ${label}..."
    echo -e "${BLUE}  Prompt:${NC} $prompt_file"
    echo -e "${BLUE}  Working dir:${NC} $work_dir"
    echo -e "${BLUE}  Max turns:${NC} (auto)"
    echo ""

    cd "$work_dir"
    codex exec --full-auto \
               --sandbox danger-full-access \
               "$(cat "$prompt_file")" \
               2>&1 | tee "$SCRIPT_DIR/logs/day${DAY}_${label}.log"
    cd "$SCRIPT_DIR"
}

# Ensure directories exist
mkdir -p "$SCRIPT_DIR/logs"
mkdir -p "$PROMPTS_DIR"

# Validate day
if [[ "$DAY" -lt 1 || "$DAY" -gt 5 ]]; then
    echo "Error: Day must be 1-5"
    exit 1
fi

PROMPT_A1="$PROMPTS_DIR/day${DAY}_agent1.md"
PROMPT_A2="$PROMPTS_DIR/day${DAY}_agent2.md"

if [[ ! -f "$PROMPT_A1" ]] || [[ ! -f "$PROMPT_A2" ]]; then
    echo -e "${YELLOW}[Loopwright]${NC} Prompt files not found. Run: ./extract-prompts.sh first"
    exit 1
fi

case "$AGENT" in
    1)
        # Agent 1: Claude Code with Engram (memory-layer work)
        run_claude "$PROMPT_A1" "$ENGRAM_DIR" "agent1-engram"
        ;;
    2)
        # Agent 2: Codex (greenfield Loopwright/Bun work)
        run_codex "$PROMPT_A2" "$LOOPWRIGHT_DIR" "agent2-loopwright"
        ;;
    both)
        # Run both in parallel
        echo -e "${GREEN}[Loopwright]${NC} Launching both agents in parallel..."
        echo ""

        run_claude "$PROMPT_A1" "$ENGRAM_DIR" "agent1-engram" &
        PID1=$!

        run_codex "$PROMPT_A2" "$LOOPWRIGHT_DIR" "agent2-loopwright" &
        PID2=$!

        echo -e "${YELLOW}[Loopwright]${NC} Agent 1 PID: $PID1"
        echo -e "${YELLOW}[Loopwright]${NC} Agent 2 PID: $PID2"
        echo -e "${YELLOW}[Loopwright]${NC} Waiting for both to complete..."

        wait $PID1
        EXIT1=$?
        wait $PID2
        EXIT2=$?

        echo ""
        echo -e "${GREEN}[Loopwright]${NC} Agent 1 exited: $EXIT1"
        echo -e "${GREEN}[Loopwright]${NC} Agent 2 exited: $EXIT2"
        echo -e "${GREEN}[Loopwright]${NC} Logs: $SCRIPT_DIR/logs/"
        ;;
    *)
        echo "Error: Agent must be 1, 2, or both"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}[Loopwright]${NC} Day $DAY complete. Check logs: $SCRIPT_DIR/logs/"
