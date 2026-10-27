#!/usr/bin/env python3
"""Wallet Click's Wallet window, from the command line (for OpenClaw on the same host).

  wc-agent.py address SOL --label "Sam"     a fresh address (never handed out before)
  wc-agent.py list                          what's held, what's waiting
  wc-agent.py show <id>                     one address
  wc-agent.py move <id> xmr                 Swap to Monero (held in the Wallet)
  wc-agent.py move <id> coinbase [--to ID]  Send to Coinbase (USDC on Base, address book id)
  wc-agent.py coins                         every coin it can give an address for

Talks to the local server (WC_URL, default http://127.0.0.1:8818) with AGENT_TOKEN, read from the environment or
from /etc/wallet-click-agent.env (AGENT_TOKEN=...; keep it root-only). Add --json for the raw answer.
Money only ever goes to your own Monero or to your address book: the server takes no other address.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("WC_URL", "http://127.0.0.1:8818").rstrip("/")
TOKEN_FILE = os.environ.get("WC_AGENT_ENV", "/etc/wallet-click-agent.env")


def token() -> str:
    t = os.environ.get("AGENT_TOKEN", "").strip()
    if t:
        return t
    try:
        for line in open(TOKEN_FILE, encoding="utf-8"):
            key, _, value = line.strip().partition("=")
            if key == "AGENT_TOKEN":
                return value.strip().strip('"')
    except FileNotFoundError:
        pass
    sys.exit(f"No AGENT_TOKEN (set it, or put AGENT_TOKEN=... in {TOKEN_FILE}).")


def call(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{URL}{path}", data=data, method=method)
    req.add_header("authorization", f"Bearer {token()}")
    req.add_header("x-wallet", "1")
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", "")
        except ValueError:
            msg = ""
        sys.exit(f"Wallet Click said no ({e.code}): {msg or e.reason}")
    except urllib.error.URLError as e:
        sys.exit(f"Can't reach Wallet Click at {URL}: {e.reason}")


def show_address(a: dict) -> None:
    where = a["name"] if a["name"] == a["network"] else f"{a['name']} on {a['network']}"
    print(f"{where}{' for ' + a['label'] if a.get('label') else ''}")
    print(a["address"])
    if a.get("memo"):
        print(f"Memo / tag (required): {a['memo']}")
    print(a["warning"])
    if a.get("landsIn"):
        print(f"Lands in: {a['landsIn']}" + (f", minimum {a['minimum']}" if a.get("minimum") else ""))
    print(f"(id {a['id']})")


def main() -> None:
    p = argparse.ArgumentParser(description="Wallet Click Wallet, for OpenClaw")
    p.add_argument("--json", action="store_true", help="print the raw answer")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("address", help="a fresh address for a coin")
    a.add_argument("coin", help="BTC, LTC, ETH, base, arbitrum, optimism, POL, BNB, SOL, XMR, or any FixedFloat code (DOGE, XRP, USDTTRC…)")
    a.add_argument("--label", default="", help="who's paying (only you see it)")
    sub.add_parser("list", help="held and waiting addresses")
    s = sub.add_parser("show", help="one address")
    s.add_argument("id")
    m = sub.add_parser("move", help="Swap to Monero, or Send to Coinbase")
    m.add_argument("id")
    m.add_argument("to", choices=["xmr", "coinbase"])
    m.add_argument("--to", dest="dest", default=None, help="address book id for coinbase (default: the Wallet's setting)")
    sub.add_parser("coins", help="every coin it can give an address for")
    args = p.parse_args()

    if args.cmd == "address":
        r = call("POST", "/api/agent/address", {"coin": args.coin, "label": args.label})
        return print(json.dumps(r, indent=2)) if args.json else show_address(r)
    if args.cmd == "list":
        r = call("GET", "/api/agent/wallet")
        if args.json:
            return print(json.dumps(r, indent=2))
        print(f"Held: about ${r['totalUsd']:.2f}")
        for e in r["entries"]:
            amt = f"{e['amount']} {e['held']}" if e["amount"] != "0" else ""
            usd = f" (~${e['usd']:.2f})" if e.get("usd") else ""
            print(f"  {e['id']}  {e['coin']:<6} {e['network']:<16} {e['state']:<9} {amt}{usd}  {e['label']}")
        return
    if args.cmd == "show":
        r = call("GET", f"/api/agent/wallet/{args.id}")
        return print(json.dumps(r, indent=2)) if args.json else (show_address(r), print(f"State: {r['state']}, {r['amount']} {r['held']}"))
    if args.cmd == "move":
        body = {"id": args.id, "to": args.to}
        if args.dest:
            body["destinationId"] = args.dest
        r = call("POST", "/api/agent/move", body)
        return print(json.dumps(r, indent=2)) if args.json else print(f"Started: {'Swap to Monero' if args.to == 'xmr' else 'Send to Coinbase'} for {r['amount']} {r['held']} ({r['id']}).")
    if args.cmd == "coins":
        r = call("GET", "/api/agent/coins")
        if args.json:
            return print(json.dumps(r, indent=2))
        print("Held here:", ", ".join(f"{c['id']} ({c['network']})" for c in r["held"]))
        print("Via FixedFloat into Monero:", ", ".join(c["code"] for c in r["other"]))


if __name__ == "__main__":
    main()
