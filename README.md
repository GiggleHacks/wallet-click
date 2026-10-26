# Wallet Click

Get paid in **Bitcoin**, **Ethereum** or **Monero**: at a brand-new address every time, or at a **permanent address** you save in your phone wallet. Whatever arrives is swapped to **USDC on Base** and sent to **Coinbase** (or another USDC-on-Base address in your address book). **Send options** can route it through Monero first, make it wait before it goes on, and split it into 2–4 pieces sent at random times. You watch it all happen in a retro "copying files" style window, in one of four desktop themes.

**New here? Start with [HOW-TO.md](HOW-TO.md)**: a step-by-step guide from zero to your first payment.

## How it works

1. Click **Bitcoin**, **Ethereum** or **Monero**. With the default Send options (straight to USDC, no wait, one piece), the server creates a FixedFloat float-rate order and shows its deposit address as a QR code. Every order has its own address.
2. Someone pays any amount between FixedFloat's minimum and maximum, within 24 hours of the address being made. The minimum is about $10.
3. **The moment the payment is broadcast**, the app rings and opens the transfer window. The server watches each deposit address on-chain itself, through public Ethereum RPCs and mempool.space, and doesn't wait for FixedFloat to report the payment.
4. FixedFloat confirms the payment. In the window, the coin floats to the swap, turns into USDC, and the USDC floats to Coinbase.
5. Done: the USDC amount and the Basescan link for the payout are shown.

The server polls FixedFloat and the chain for every order, so payments are picked up even when no browser is open. Sounds need the page open, and the browser only allows sound after a first click on the page.

**How it works** (desktop icon, Start menu, or the button on the main window) plays the whole flow with fake data and every sound. No order is created and no money moves. Use it to show someone.

### Address Book

The addresses swaps may pay out to. Everything pays out **USDC on Base**: **Coinbase (USDC on Base)** is built in (its address is your `PAYOUT_ADDRESS_USDC_BASE`, which is required), and you can add more. Adding or removing one asks for the password again, and the address must carry its EIP-55 checksum (copy it from the exchange's USDC-on-Base deposit page: an address on the wrong network can lose the money). Pick the destination for new addresses on the main window. FixedFloat pays USDC on Base as `USDCBASE`, and every order is checked to pay exactly that, on Base, to exactly the saved address.

Base network fees are much lower than Ethereum's, so this is usually the cheaper payout, most of all with pieces (each piece is its own payout).

**USDT on Ethereum is no longer offered.** You can't pick it or add a USDT address any more, and the old built-in id `coinbase` now means the Base destination. What was already set up keeps working until it is done: a permanent address made for USDT, a transfer in progress, and old orders keep paying and showing USDT (with Etherscan links), because each carries its own copy of its destination. Only new money is affected.

### Send options

The **Send options** box on the main window says what the coin buttons do now (for example "Through Monero · wait 4 h · 4 pieces"); **Change…** sets it, and the browser remembers it. Each permanent address has its own copy.

- **Route**: *Straight to USDC*, or *Through Monero* (Privacy Enhanced, below).
- **Wait**: none, or about 4, 12, 24 or 42 hours. The choice is the *typical* length: each payment's real wait is drawn at random (from a quarter of it up to three times it, averaging a bit under the choice), so the time between your money going into FixedFloat and the USDC coming out isn't one of four fixed values. Change wait draws a new one.
- **Pieces**: 1–4. The amounts are random and unequal (each at least 1.5 × FixedFloat's minimum; with too little, it's fewer pieces). Piece 1 goes when the wait is over; each next one a random 5 minutes to 2 hours after the one before has finished (FixedFloat only takes one order per direction at a time, so they never overlap). Each piece is its own FixedFloat order, so it pays its own FixedFloat and network fees.
- **How much to send**: pieces raise the minimum (3 pieces straight to USDC need about 3 × 1.5 × FixedFloat's ≈ $10). Send options, the receive windows and My Addresses show that minimum from FixedFloat's live rates, and suggest sending about 30% more, rounded up, to be safe. Less goes in fewer pieces, or waits for more.

Where it happens:

| | Wait | Pieces |
|---|---|---|
| Through Monero (Bitcoin/Ethereum) | in Monero, after the first swap | one Monero transaction splits it into a fresh subaddress per piece; each piece then moves once more by itself, at a random time, and swaps to USDC on its own |
| A Monero payment | in your Monero wallet | the same Monero split |
| Bitcoin, straight | at your own address, before the swap | one transaction to a fresh address of yours per piece (BIP84 change chain, `m/84'/0'/0'/1/i`); each forwards by itself |
| Ethereum, straight | at your own address, before the swap | each piece forwards its share from the same address, one after another |

**How private is it?** Inside Monero the pieces can't be tied to each other or to the payment. Straight Bitcoin/Ethereum pieces only hide the amounts and the timing from Coinbase: on the blockchain anyone can still follow them from your address to FixedFloat. Use **Through Monero** (or get paid in Monero) for the real thing.

With a wait or pieces and *Straight to USDC*, a coin button gives you a **one-time address of your own wallet** instead of a FixedFloat address: the payment lands in the server's hot wallet, waits, then goes on like a permanent address's. One-time addresses aren't listed under My Addresses, and are watched for 30 days.

### Privacy Enhanced

*Through Monero* in Send options: click Bitcoin or Ethereum and pay the address it shows.

1. FixedFloat swaps the payment to **Monero**, paid to a fresh subaddress of the VPS's own Monero wallet.
2. Once it has unlocked (10 blocks, about 20 minutes), the server moves it once to another fresh subaddress of its own, so FixedFloat's outputs never go straight back to FixedFloat.
3. It waits a random time around the chosen hours (counted from the moment it unlocked).
4. A second FixedFloat order swaps exactly that Monero to USDC for the destination, and the wallet pays it.

With pieces, step 2 is the split, and steps 3–4 happen for each piece. The transfer window shows every step, every piece, a countdown, and **Change wait…**, **Release now** and **Retry** (Release now skips the wait; the pieces keep their random gaps).

Limits: FixedFloat only swaps **about $110 or more into Monero**, so smaller privacy payments can't go through (they're sent back). Two swaps cost two FixedFloat fees (0.5% each) plus small network fees. It hides the link between your coins and the USDC from outside chain analysis; FixedFloat itself still sees both swaps (the same API key makes them).

### Permanent addresses

**My Addresses** (desktop icon, Start menu or main window): addresses you save in your phone wallet once and pay any time, like a saved contact.

- **Monero**: a subaddress of the VPS's Monero wallet.
- **Bitcoin / Ethereum**: from the server's own hot wallet (a 24-word seed, encrypted on disk).
- Each one goes **straight to USDC** or through **Privacy Enhanced**, to a destination that's **fixed for life**: a saved address always lands in the same place. It has its own wait and pieces (Send options), which can change for the next payments; the name can change too.

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
- The payout address is fixed on the server: `PAYOUT_ADDRESS_USDC_BASE`. The server won't start without it, and its EIP-55 checksum is checked at boot. (`PAYOUT_ADDRESS`, the old USDT address, is only kept to read old records.)
- The browser only ever says "BTC" or "ETH".
- Every new FixedFloat order is checked before its address is shown. It must be a float-rate order from the coin you picked, paying USDC on Base, on the Base network, to exactly that address. Anything else is refused.
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
- The server can only send to the deposit address of a FixedFloat order it has just created and checked (right coin in, USDC on Base to a saved destination or XMR to our own subaddress, float rate), to one of its own Monero subaddresses, or (a Bitcoin split) to its own change-chain addresses, each derived from the seed and checked before signing. No API takes an outbound address.
- A Monero split takes the fee out of the pieces, so nothing is left as change at the account's main address. It needs monero-wallet-rpc **0.18.3.1 or newer**; an older one can't do that, and the split is refused (nothing is sent) rather than signed any other way.
- Every send is signed and saved to disk before it's broadcast. After a crash the same transaction is broadcast again; a second one is never built. Bitcoin forwards spend exactly the quoted coins; Ethereum keeps gas back.
- FixedFloat's rule that a new order in the same direction waits for the previous one is followed: one order per pair at a time.
- Refunds of orders the hot wallet paid go back to the hot wallet's own address.
- Monero: Wallet Click keeps to its own "wallet-click" account (never account 0) and subaddresses it made.
- The BTC/ETH seed is encrypted with `WALLET_KEY` (scrypt + AES-GCM). The browser never receives seeds, signed transactions or FixedFloat tokens.
- What can be stolen if the VPS is compromised: whatever is in flight at the time, including Privacy funds during their wait. Turning on `--rpc-login` for monero-wallet-rpc is recommended: without it, any process on the VPS can spend from that wallet.

**Privacy:** the payer only ever sees a one-time FixedFloat deposit address (or your permanent address). FixedFloat sees both sides, and Coinbase sees a deposit from FixedFloat.

**Outbound traffic (optional, recommended):** set `EGRESS_PROXY=socks5h://127.0.0.1:9050` (a local Tor) and every call to FixedFloat and to the public Esplora / Ethereum RPC APIs (scans, deposit watching, broadcasts) goes through it, so none of them sees the VPS's address or can tie your addresses together by it. There is no direct fallback: with the proxy down those calls fail rather than go out directly. `EGRESS_VIA=chain` (or `ff`) limits it to one of them, for example if FixedFloat's front door refuses Tor exits. monero-wallet-rpc is local and talks to its Monero node itself, so give *it* the proxy: `--proxy 127.0.0.1:9050` (and a node you trust, ideally your own over Tor/I2P), otherwise the node's operator sees where your transactions come from.

## Run it locally

```bash
npm install
cp .env.example .env   # set APP_PASSWORD, FF_API_KEY, FF_API_SECRET, PAYOUT_ADDRESS_USDC_BASE
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

### Telegram pings (optional)

When money arrives (a fresh address, a permanent one), leaves the hot wallet for a swap, or is paid out or refunded,
the server appends one line per event to `data/telegram-outbox.jsonl`; each event pings once, even across restarts.
A ping says only that it happened, the coin and your own label ("📥 Received · BTC · Phone"): Telegram keeps what it's sent,
so no amounts, addresses or links go out. `NOTIFY_DETAIL=full` puts them back.
The server never holds a bot token: a small host process delivers the lines. With the `openclaw` CLI
set up on the host, install `scripts/wallet-click-notify.service` and give it your chat id in a local override
(see the comments in the file).

## Tests

`npm test` covers:
- FixedFloat request signing.
- Payouts always going to the configured payout address, whatever the browser sends.
- Refusing foreign payout addresses and tokens.
- The token never reaching the browser.
- Emergency handling: continue, retries, below-minimum refunds, the "not safe to refund" cases, RPC outages, and new deposits.
- On-chain detection with baselines.
- %-encoded path bypass attempts, parallel password guessing, per-address lockouts and forged `X-Forwarded-For`.
- jsdom runs of the real flow and the demo, checking the sounds, plus switching themes and backgrounds.
- The address book (password, checksum, USDC on Base only; the old USDT entries hidden and refused), Monero orders, and order checks against what was asked for (USDC on Base, the right network, exactly the saved address), plus older USDT permanent addresses and transfers still finishing as USDT.
- The transfer engine against a fake monero-wallet-rpc, Esplora and Ethereum RPC: Privacy Enhanced end to end (vault, churn, wait, second swap), release and change of the wait, relaying the saved transaction after a failed relay, the one-order-per-pair rule, permanent Monero/Bitcoin/Ethereum forwards (BIP84/BIP44 test vectors, exact amounts and inputs), collecting below the minimum, and no secrets in any API answer.
- Waits and pieces: random unequal amounts, the Monero split (fee out of the pieces, refused on an old wallet) with each piece moving and swapping on its own, the random gaps after each piece, fewer pieces when there's too little, Change wait and Release now reaching the pieces, the direct wait taking in later payments, the Bitcoin split to change-chain addresses (BIP84 change test vector), Ethereum pieces from one address, and one-time addresses (hidden, expiring).

