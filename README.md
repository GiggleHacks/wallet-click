# Wallet Click

Get paid in **Bitcoin** or **Ethereum** at a brand-new address every time. Whatever arrives is swapped to **USDT** and sent to your **Coinbase** USDT address. You watch it happen in a retro "copying files" style window, in one of four desktop themes.

## How it works

1. Click **Bitcoin** or **Ethereum**. The server creates a FixedFloat float-rate order and shows its deposit address as a QR code. Every order has its own address.
2. Someone pays any amount between FixedFloat's minimum and maximum. The minimum is about $10 for BTC and about $13 for ETH.
3. **The moment the payment is broadcast**, the app rings and opens the transfer window. The server watches each deposit address on-chain itself, through public Ethereum RPCs and mempool.space, and doesn't wait for FixedFloat to report the payment.
4. FixedFloat confirms the payment. In the window, the coin floats to the swap, turns into USDT, and the USDT floats to Coinbase.
5. Done: the USDT amount and the Etherscan link for the payout are shown.

The server polls FixedFloat and the chain for every order, so payments are picked up even when no browser is open. Sounds need the page open, and the browser only allows sound after a first click on the page.

**How it works** (desktop icon, Start menu, or the button on the main window) plays the whole flow with fake data and every sound. No order is created and no money moves. Use it to show someone.

## Themes

Open **Themes** on the desktop or in the Start menu. Each theme changes the fonts, window chrome, controls, taskbar, Start menu, sign-in screen, transfer dialog, sounds and wallpaper.

| Theme | Look |
|---|---|
| **Windows 95** | Solid navy title bars, the start-up sky with a splash screen, and the original chord and fanfare. |
| **Windows 98** (default) | Gradient title bars on the classic teal desktop. |
| **Windows 10** | Flat white windows with an accent border, coin buttons as live tiles, and a dark taskbar. The Start menu has a rail, an app list and tiles, and notifications are toasts. The transfer dialog shows "% complete" with the green copy graph. |
| **Windows 11** | Rounded frosted-glass windows over the bloom wallpaper, and a centred taskbar with active-app pills. The Start menu has pinned apps and search. |

Backgrounds can be changed on their own on the **Background** tab. All wallpapers are drawn in code.

## Safety

**Payouts**
- The payout address is fixed on the server: the built-in Coinbase address, or `PAYOUT_ADDRESS`. Its EIP-55 checksum is checked at boot.
- The browser only ever says "BTC" or "ETH".
- Every new FixedFloat order is checked before its address is shown. It must be a float-rate order from the coin you picked, paying USDT on Ethereum to exactly that address. Anything else is refused.
- The FixedFloat order token, which could redirect a refund, never leaves the server.

**Late or unusual payments.** FixedFloat flags these as an "emergency", and the server answers as follows.
- **Late payments, or amounts different from the quote:** "continue at market rate". If FixedFloat errors, the server retries with backoff and doesn't give up.
- **Below the minimum:** the payment is sent back to the wallet that paid, but only when both Ethereum RPCs (or both Esplora APIs for Bitcoin) agree that one ordinary wallet sent exactly that amount straight to the deposit address. Exchanges, smart wallets, contracts and multi-sender payments go to the owner instead. The transfer window asks for a refund address and the password.
- **Above the maximum:** always left to the owner.
- Each order gets one answer at a time. A new deposit on the same order gets a fresh answer.

**Watching for payments**
- Each address is watched for 30 days.
- Orders still in progress are never pruned.
- On-chain detection counts only money that arrives after watching starts. It ignores reused addresses, and stops trusting a sighting after an hour if FixedFloat never sees the payment.

**Login and requests**
- **Password:** `APP_PASSWORD`, hashed with scrypt. Password checks run one at a time, and floods are turned away.
- **Lockouts:** per client address, 5 tries and then a doubling lockout capped at 1 hour, plus a global ceiling. Attempts are counted before checking, so parallel guesses don't get extra tries. Refund passwords have their own counter.
- **Session cookie:** HttpOnly and SameSite=Strict, with a Secure flag and HSTS when served over HTTPS.
- **Request checks:** auth and CSRF checks use the route the router actually matched, so %-encoded paths can't slip past. There is also a Host allowlist and CSP, every write needs a custom header and a same-origin Origin, and request timeouts are set.
- **Client addresses:** only one proxy hop is trusted, so a client can't spoof its address with `X-Forwarded-For`.

**Privacy:** the payer only ever sees a one-time FixedFloat deposit address. FixedFloat sees both sides, and Coinbase sees a deposit from FixedFloat.

## Run it locally

```bash
npm install
cp .env.example .env   # set APP_PASSWORD, FF_API_KEY, FF_API_SECRET
npm run build && npm start
```

For development, use `npm run dev`. Vite runs on :5173 and proxies `/api` to :8787.

## Deploy (Docker + Tailscale)

```bash
docker compose up -d --build
tailscale funnel --bg --https=8443 http://127.0.0.1:8787   # public, behind the password
# or: tailscale serve --bg --https=8443 http://127.0.0.1:8787  (tailnet only)
```

The compose file binds only to `127.0.0.1`. Set `COOKIE_SECURE=true` when it's served over HTTPS. Data (`orders.json`, the password hash) lives in the `wc-data` volume.

## Tests

`npm test` covers:
- FixedFloat request signing.
- Payouts always going to the Coinbase address, whatever the browser sends.
- Refusing foreign payout addresses and tokens.
- The token never reaching the browser.
- Emergency handling: continue, retries, below-minimum refunds, the "not safe to refund" cases, RPC outages, and new deposits.
- On-chain detection with baselines.
- %-encoded path bypass attempts, parallel password guessing, per-address lockouts and forged `X-Forwarded-For`.
- jsdom runs of the real flow and the demo, checking the sounds, plus switching themes and backgrounds.

The previous Burner wallet app is kept in `archive/burner-v1/`.
