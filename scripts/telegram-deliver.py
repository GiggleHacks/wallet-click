#!/usr/bin/env python3
"""Deliver Wallet Click outbox lines to Telegram. Does not print message bodies."""

import json
import os
import subprocess
import sys
import time

OUTBOX = os.environ.get(
    "WC_OUTBOX",
    "/var/lib/docker/volumes/wallet-click_wc-data/_data/telegram-outbox.jsonl",
)
OFFSET = os.environ.get("WC_OFFSET", "/var/lib/wallet-click-notify/offset")
# Your Telegram chat id: set WC_CHAT_ID in the service (never in the repo).
CHAT = os.environ.get("WC_CHAT_ID", "")
OPENCLAW = os.environ.get("OPENCLAW", "openclaw")


def load_offset() -> int:
    try:
        return int(open(OFFSET, encoding="utf-8").read().strip() or "0")
    except FileNotFoundError:
        return 0


def save_offset(n: int) -> None:
    os.makedirs(os.path.dirname(OFFSET), exist_ok=True)
    tmp = OFFSET + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(str(n))
    os.replace(tmp, OFFSET)


def send(text: str) -> bool:
    try:
        result = subprocess.run(
            [OPENCLAW, "message", "send", "--channel", "telegram", "--target", CHAT, "-m", text],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        sys.stderr.write(f"send failed: {type(e).__name__}\n")
        return False
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip().replace("\n", " ")
        sys.stderr.write(f"send failed rc={result.returncode} {err[:240]}\n")
        return False
    return True


def main() -> None:
    if not CHAT:
        sys.stderr.write("WC_CHAT_ID is not set: nothing to deliver to
")
        sys.exit(1)
    while True:
        try:
            if not os.path.exists(OUTBOX):
                time.sleep(2)
                continue
            off = load_offset()
            size = os.path.getsize(OUTBOX)
            if off > size:
                off = 0
            if off == size:
                time.sleep(2)
                continue
            with open(OUTBOX, encoding="utf-8") as f:
                f.seek(off)
                line = f.readline()
                if not line or not line.endswith("\n"):
                    time.sleep(1)
                    continue
                new_off = f.tell()
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                save_offset(new_off)
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                save_offset(new_off)
                continue
            if send(text):
                save_offset(new_off)
                sys.stderr.write("delivered one notice\n")
            else:
                time.sleep(5)
        except Exception as e:
            sys.stderr.write(f"deliver error: {type(e).__name__}\n")
            time.sleep(5)


if __name__ == "__main__":
    main()
