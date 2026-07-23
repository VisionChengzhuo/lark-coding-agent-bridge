#!/usr/bin/env bash
set -euo pipefail

export PATH="/ytech_m2v5_hdd/tcz/.local/bin:${PATH}"
export CODEX_HOME="/ytech_m2v5_hdd/tcz/.codex"
case " ${NODE_OPTIONS:-} " in
  *" --use-env-proxy "*) ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--use-env-proxy" ;;
esac

PROFILE="gpu-fable"
SESSION="kml-fable-bridge"
ROOT_DIR="/ytech_m2v5_hdd/tcz/lyc/lark-coding-agent-bridge"
LOG_DIR="/root/.lark-channel/profiles/${PROFILE}/logs/tmux"
BRIDGE_LOG="${LOG_DIR}/bridge.log"
SUPERVISOR_LOG="${LOG_DIR}/supervisor.log"

sync_inherited_environment() {
  local name
  # tmux servers retain their environment after a session exits. Clear the
  # old values first, then copy only values already present in this process.
  for name in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY NODE_OPTIONS; do
    tmux set-environment -gu "${name}" 2>/dev/null || true
    if [[ -n "${!name:-}" ]]; then
      tmux set-environment -g "${name}" "${!name}"
    fi
  done
}

start_bridge() {
  mkdir -p "${LOG_DIR}"
  umask 077

  if tmux has-session -t "${SESSION}" 2>/dev/null; then
    echo "tmux session already running: ${SESSION}"
    return
  fi

  sync_inherited_environment
  tmux new-session -d -s "${SESSION}" -c "${ROOT_DIR}" \
    "while true; do
       echo \"[\$(date -Is)] starting lark-channel-bridge profile ${PROFILE}\" | tee -a \"${SUPERVISOR_LOG}\"
       lark-channel-bridge run --profile \"${PROFILE}\" 2>&1 | tee -a \"${BRIDGE_LOG}\"
       code=\"\${PIPESTATUS[0]}\"
       echo \"[\$(date -Is)] lark-channel-bridge exited with code \${code}; restarting in 5s\" | tee -a \"${SUPERVISOR_LOG}\"
       sleep 5
     done"
  echo "started profile ${PROFILE}: tmux session ${SESSION}"
  echo "logs: ${BRIDGE_LOG}"
}

stop_bridge() {
  if ! tmux has-session -t "${SESSION}" 2>/dev/null; then
    echo "tmux session not running: ${SESSION}"
    return
  fi
  tmux kill-session -t "${SESSION}"
  echo "stopped profile ${PROFILE}: tmux session ${SESSION}"
}

status_bridge() {
  if tmux has-session -t "${SESSION}" 2>/dev/null; then
    echo "tmux session: ${SESSION} (running)"
    tmux list-panes -t "${SESSION}" -F "pane_pid=#{pane_pid} command=#{pane_current_command}"
  else
    echo "tmux session: ${SESSION} (not running)"
  fi
  lark-channel-bridge ps || true
  if [[ -f "${BRIDGE_LOG}" ]]; then
    echo
    echo "last log lines: ${BRIDGE_LOG}"
    tail -n 40 "${BRIDGE_LOG}"
  fi
}

case "${1:-start}" in
  start) start_bridge ;;
  stop) stop_bridge ;;
  restart)
    stop_bridge
    start_bridge
    ;;
  status) status_bridge ;;
  logs) tail -n "${2:-100}" -f "${BRIDGE_LOG}" ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs [lines]}" >&2
    exit 2
    ;;
esac
