# Wallet Click

Get paid in **Bitcoin**, **Ethereum** or **Monero**: at a brand-new address every time, or at a **permanent address** you save in your phone wallet. Whatever arrives is swapped to **USDT** and sent to **Coinbase** (or another USDT address in your address book). **Privacy Enhanced** routes it through Monero first, with a wait you choose. You watch it all happen in a retro "copying files" style window, in one of four desktop themes.

## How it works

1. Click **Bitcoin**, **Ethereum** or **Monero**. The server creates a FixedFloat float-rate order and shows its deposit address as a QR code. Every order has its own address.
2. Someone pays any amount between FixedFloat's minimum and maximum, within 24 hours of the address being made. The minimum is about $10.
3. **The moment the payment is broadcast**, the app rings and opens the transfer window. The server watches each deposit address on-chain itself, through public Ethereum RPCs and mempool.space, and doesn't wait for FixedFloat to report the payment.
4. FixedFloat confirms the payment. In the window, the coin floats to the swap, turns into USDT, and the USDT floats to Coinbase.
5. Done: the USDT amount and the Etherscan link for the payout are shown.

The server polls FixedFloat and the chain for every order, so payments are picked up even when no browser is open. Sounds need the page open, and the browser only allows sound after a first click on the page.

**How it works** (desktop icon, Start menu, or the button on the main window) plays the whole flow with fake data and every sound. No order is created and no money moves. Use it to show someone.

### Address Book

The USDT (ERC-20) addresses swaps may pay out to. **Coinbase** is built in. Adding or removing one asks for the password again, and the address must carry its EIP-55 checksum (copy it from the exchange's deposit page). Pick the destination for new addresses on the main window.

### Privacy Enhanced

**Privacy Enhanced…** on the main window: pick Bitcoin or Ethereum, a wait (4, 12, 24 or 42 hours) and a destination, and pay the address it shows.

1. FixedFloat swaps the payment to **Monero**, paid to a fresh subaddress of the VPS's own Monero wallet.
2. Once it has unlocked (10 blocks, about 20 minutes), the server moves it once to another fresh subaddress of its own, so FixedFloat's outputs never go straight back to FixedFloat.
3. It waits the chosen hours (from the moment it unlocked) plus a random 0–30 minutes.
4. A second FixedFloat order swaps exactly that Monero to USDT for the destination, and the wallet pays it.

The transfer window shows every step, a countdown, and **Change wait…**, **Release now** and **Retry**.

Limits: FixedFloat only swaps **about $110 or more into Monero**, so smaller privacy payments can't go through (they're sent back). Two swaps cost two FixedFloat fees (0.5% each) plus small network fees. It hides the link between your coins and the USDT from outside chain analysis; FixedFloat itself still sees both swaps (the same API key makes them).

### Permanent addresses

**My Addresses** (desktop icon, Start menu or main window): addresses you save in your phone wallet once and pay any time, like a saved contact.

- **Monero**: a subaddress of the VPS's Monero wallet.
- **Bitcoin / Ethereum**: from the server's own hot wallet (a 24-word seed, encrypted on disk).
- Each one goes **straight to USDT** or through **Privacy Enhanced**, to a destination that's **fixed for life**: a saved address always lands in the same place. Only its name and privacy wait can change.

When money lands, it rings. Once it's confirmed (BTC 1 block, ETH 12 blocks, XMR 10 blocks) and above FixedFloat's minimum, the server creates a FixedFloat order for exactly that amount and pays it from the hot wallet. Smaller payments **collect** at the address until they add up to the minimum. **Send $…** works out the coin amount for a dollar amount and gives an **Open in wallet** link (`bitcoin:`, `ethereum:`, `monero:`) that opens your wallet app with everything filled in.

Costs: one extra network fee per Bitcoin/Ethereum forward. Reusing a Bitcoin/Ethereum address is visible on-chain (Monero subaddresses aren't).

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

**Hot wallet (permanent addresses, Privacy Enhanced)**
- The server can only send to the deposit address of a FixedFloat order it has just created and checked (right coin in, USDT to a saved destination or XMR to our own subaddress, float rate), or to one of its own Monero subaddresses. No API takes an outbound address.
- Every send is signed and saved to disk before it's broadcast. After a crash the same transaction is broadcast again; a second one is never built. Bitcoin forwards spend exactly the quoted coins; Ethereum keeps gas back.
- FixedFloat's rule that a new order in the same direction waits for the previous one is followed: one order per pair at a time.
- Refunds of orders the hot wallet paid go back to the hot wallet's own address.
- Monero: Wallet Click keeps to its own "wallet-click" account (never account 0) and subaddresses it made.
- The BTC/ETH seed is encrypted with `WALLET_KEY` (scrypt + AES-GCM). The browser never receives seeds, signed transactions or FixedFloat tokens.
- What can be stolen if the VPS is compromised: whatever is in flight at the time, including Privacy funds during their wait. Turning on `--rpc-login` for monero-wallet-rpc is recommended: without it, any process on the VPS can spend from that wallet.

**Privacy:** the payer only ever sees a one-time FixedFloat deposit address (or your permanent address). FixedFloat sees both sides, and Coinbase sees a deposit from FixedFloat.

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
tailscale serve --bg --https=8443 http://127.0.0.1:8787    # tailnet only
# or: tailscale funnel --bg --https=8443 http://127.0.0.1:8787  (public, behind the password)
```

The container uses host networking (to reach monero-wallet-rpc on `127.0.0.1:18083`) and listens on `127.0.0.1:${WC_PORT}` only. Set `COOKIE_SECURE=true` when it's served over HTTPS. Data (orders, transfers, permanent addresses, the address book, the encrypted seed, the password hash) lives in the `wc-data` volume.

Monero: set `MONERO_RPC_URL=http://127.0.0.1:18083/json_rpc` (and `MONERO_RPC_USER`/`MONERO_RPC_PASSWORD` with `--rpc-login`).

Bitcoin/Ethereum hot wallet, once:

```bash
echo "WALLET_KEY=$(openssl rand -hex 32)" >> .env
docker compose up -d
docker compose exec wallet-click node dist/server/cli/wallet-init.js
docker compose exec wallet-click cat /app/data/seed-backup.txt   # write the 24 words down
docker compose exec wallet-click rm /app/data/seed-backup.txt
docker compose restart
```

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
- The address book (password, checksum), Monero orders, and order checks against what was asked for.
- The transfer engine against a fake monero-wallet-rpc, Esplora and Ethereum RPC: Privacy Enhanced end to end (vault, churn, wait, second swap), release and change of the wait, relaying the saved transaction after a failed relay, the one-order-per-pair rule, permanent Monero/Bitcoin/Ethereum forwards (BIP84/BIP44 test vectors, exact amounts and inputs), collecting below the minimum, and no secrets in any API answer.

The previous Burner wallet app is kept in `archive/burner-v1/`.
