#!/usr/bin/env bash
# Turn the phone's mobile data off, wait, turn it on again and wait until the phone is online, so the modem re-registers on 5G/LTE.
# Uses only `adb shell svc data disable|enable`. Run it by hand or call it from another script.
#
#   cycle_mobile_data.sh [-s SERIAL] [-w OFF_SECONDS] [-t ONLINE_TIMEOUT] [-m MIN_INTERVAL] [-o] [-n]
#
#   -s SERIAL        phone to use (default: $ANDROID_SERIAL, or the only attached phone; with several, you must choose)
#   -w SECONDS       how long data stays off (default 5)
#   -t SECONDS       how long to wait for the phone to be online again (default 60)
#   -m SECONDS       refuse to cycle again within this time of the last cycle (default 120), so a caller cannot loop it
#   -o               only cycle if the phone is offline right now (ping from the phone fails)
#   -n               dry run: print what would be done, change nothing
set -euo pipefail

serial="${ANDROID_SERIAL:-}"; off=5; timeout=60; min_interval=120; only_offline=0; dry=0
while getopts "s:w:t:m:onh" opt; do
  case $opt in
    s) serial=$OPTARG ;; w) off=$OPTARG ;; t) timeout=$OPTARG ;; m) min_interval=$OPTARG ;;
    o) only_offline=1 ;; n) dry=1 ;;
    *) sed -n '2,12p' "$0"; exit 2 ;;
  esac
done
for v in "$off" "$timeout" "$min_interval"; do [[ $v =~ ^[0-9]+$ ]] || { echo "Numbers only: $v" >&2; exit 2; }; done

if [[ -z $serial ]]; then
  mapfile -t phones < <(adb devices | awk 'NR>1 && $2=="device" {print $1}')
  case ${#phones[@]} in
    0) echo "No phone attached (adb devices shows none in the 'device' state)." >&2; exit 1 ;;
    1) serial=${phones[0]} ;;
    *) echo "Several phones attached (${phones[*]}); pick one with -s SERIAL." >&2; exit 1 ;;
  esac
fi
a() { adb -s "$serial" "$@"; }
online() { a shell ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; }
status() { echo "data=$(a shell settings get global mobile_data | tr -d '\r') network=$(a shell getprop gsm.network.type | tr -d '\r')"; }

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/browserforge"; mkdir -p "$state_dir"
exec 9>"$state_dir/cycle-mobile-data.lock"
flock -n 9 || { echo "Another cycle is already running." >&2; exit 1; }

if (( only_offline )) && online; then echo "$serial is online; nothing to do."; exit 0; fi

last_file="$state_dir/cycle-mobile-data.last"
if [[ -f $last_file ]]; then
  ago=$(( $(date +%s) - $(cat "$last_file") ))
  if (( ago < min_interval )); then echo "Last cycle was ${ago}s ago (minimum ${min_interval}s); not cycling again." >&2; exit 3; fi
fi

echo "[$serial] before: $(status)"
if (( dry )); then echo "dry run: would disable data, wait ${off}s, enable data, wait up to ${timeout}s for the phone to be online"; exit 0; fi

date +%s > "$last_file"
a shell svc data disable
sleep "$off"
a shell svc data enable
for ((i = 0; i < timeout; i++)); do
  if online; then echo "[$serial] after:  $(status) (online after ${i}s)"; exit 0; fi
  sleep 1
done
echo "[$serial] data is on again but the phone did not get online within ${timeout}s: $(status)" >&2
exit 4
