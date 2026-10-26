# How to set up Wallet Click

This guide takes you from nothing to your first payment. It assumes no prior setup. For how each feature works under the hood, see the [README](README.md).

**What you end up with:** a private web page, behind your own password, with **Bitcoin**, **Ethereum** and **Monero** buttons. Click one and you get an address and QR code to give whoever pays you. Whatever arrives is swapped to **USDC on the Base network** and sent to your exchange account (Coinbase, Kraken, or any wallet that takes USDC on Base).

> **This handles real money.** Do your first payment with about $15, check that it lands, and only then use it for more. You run your own copy: nobody else can see it, fix it, or get your money back for you.

---

## 1. What you need

| Thing | Why | Where to get it |
|---|---|---|
| A computer that stays on | The server watches for payments around the clock. A small Linux VPS ($5/month) is ideal, but a home PC works for trying it out. | Any VPS host (Hetzner, DigitalOcean, …) |
| **Node.js 22.12+** *or* **Docker** | Runs the server. | [nodejs.org](https://nodejs.org) / [docker.com](https://www.docker.com) |
| A **FixedFloat** account with an API key | FixedFloat does the swaps. | [ff.io](https://ff.io), then *API management* |
| A **USDC-on-Base deposit address** | Where your money ends up. | Your exchange's *Deposit → USDC* page, with the **Base** network picked |
| *(optional)* **Tailscale** | Puts the page on HTTPS and lets you open it from your phone without opening ports. | [tailscale.com](https://tailscale.com) |

Monero features (Privacy Enhanced, permanent Monero addresses) also need a running `monero-wallet-rpc`. That's optional; see [step 8](#8-optional-extras).

## 2. Get your FixedFloat API key

1. Sign in at [ff.io](https://ff.io).
2. Open **API management** and create a key.
3. Copy the **API key** and the **API secret**. Keep them somewhere safe: anyone with them can make orders in your name.

## 3. Get your payout address

1. In your exchange (for example Coinbase), go to **Receive / Deposit**, pick **USDC**, and set the network to **Base**.
2. Copy the address. It starts with `0x` and has a mix of upper and lower case letters (that mix is a checksum, and Wallet Click checks it).

> **Pick Base, not Ethereum or another network.** USDC sent on the wrong network can be lost.

## 4. Download and configure

```bash
git clone https://github.com/GiggleHacks/wallet-click.git
cd wallet-click
cp .env.example .env
```

Open `.env` in a text editor and fill in these four lines:

```ini
APP_PASSWORD=pick-a-long-password-you-dont-use-anywhere-else
FF_API_KEY=your-fixedfloat-api-key
FF_API_SECRET=your-fixedfloat-api-secret
PAYOUT_ADDRESS_USDC_BASE=0xYourUsdcOnBaseAddress
```

Leave everything else as it is for now. **Never share or commit `.env`.** It is already listed in `.gitignore`.

## 5. Start it

Pick **one** of these.

### Option A: Docker (best for a VPS)

```bash
docker compose up -d --build
```

The server now listens on `http://127.0.0.1:8787`, on that machine only. To reach it from anywhere, go to step 6.

### Option B: Node.js (fine for a home PC)

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:8787> in your browser.

If the server stops right away, read the error. It almost always names the setting in `.env` that is missing or wrong.

## 6. Reach it from your phone (Tailscale)

Install Tailscale on the server and on your phone, sign in to both with the same account, then on the server run:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

Tailscale prints an address like `https://myserver.tail1234.ts.net:8443`. Open it on any of your devices. Then add these two lines to `.env` and restart (`docker compose up -d`, or stop `npm start` and run it again):

```ini
ALLOWED_HOSTS=myserver.tail1234.ts.net
COOKIE_SECURE=true
```

Want people *outside* your Tailscale network to open it? Use `tailscale funnel` instead of `tailscale serve`. The page is still behind your password, but it's on the public internet, so use a strong password.

## 7. Your first payment

1. Open the page and sign in with your `APP_PASSWORD`. Tick **Remember this device** on your own phone or computer.
2. Click **How it works** first. It plays the whole flow with fake data, so nothing real happens. It's a good way to see what to expect.
3. Click **Bitcoin** (or **Ethereum**). An address and QR code appear, with the minimum (about $10). Send a little more than the minimum (the page suggests a safe amount).
4. As soon as the payment is broadcast, the page rings and opens a transfer window. Within about 10 to 30 minutes it shows the USDC amount and a Basescan link.
5. Check that the USDC arrived in your exchange. Once it has, the setup is done.

Each address is single-use and only valid for 24 hours. Make a new one for every payment.

## 8. Optional extras

You don't need any of these to get paid. Turn each one on when you want it.

**Address Book:** add more USDC-on-Base destinations (a friend, another exchange), then pick one on the main window. Adding or removing one asks for your password again.

**Send options:** wait before paying out, split a payment into 2 to 4 pieces sent at random times, or route it through Monero for privacy. See the README's *Send options* section for what each one hides and what it costs.

**Permanent Bitcoin / Ethereum addresses** (an address you can save in your phone wallet and reuse). These need a hot wallet on the server:

```bash
echo "WALLET_KEY=$(openssl rand -hex 32)" >> .env
docker compose up -d
docker compose exec wallet-click node dist/server/cli/wallet-init.js
docker compose exec wallet-click cat /app/data/seed-backup.txt   # write these 24 words on paper
docker compose exec wallet-click rm /app/data/seed-backup.txt
docker compose restart
```

(Without Docker: add `WALLET_KEY` to `.env`, run `npm run wallet:init`, read `data/seed-backup.txt`, delete it, then restart.)

> The 24 words and `WALLET_KEY` together control the money in that wallet. Write the words down offline, then delete the file. Back up `WALLET_KEY` too: without it, the encrypted seed can't be opened.

**Monero (Privacy Enhanced, permanent Monero addresses):** run `monero-wallet-rpc` on the same machine (ideally with `--rpc-login user:password`), then set this in `.env`:

```ini
MONERO_RPC_URL=http://127.0.0.1:18083/json_rpc
MONERO_RPC_USER=user
MONERO_RPC_PASSWORD=password
```

Wallet Click uses its own account in that wallet and never touches account 0. Privacy Enhanced needs about **$110 or more** per payment, because that's FixedFloat's minimum for swaps into Monero.

**Tor (hide the server's address from FixedFloat and the blockchain APIs):** install Tor on the same machine (it listens on `127.0.0.1:9050`), then add to `.env`:

```ini
EGRESS_PROXY=socks5h://127.0.0.1:9050
```

and restart. Everything sent to FixedFloat, Esplora and the Ethereum RPCs, including your transaction broadcasts, then goes through Tor, and fails if Tor is down (it never goes out directly). If FixedFloat won't talk to Tor exits, add `EGRESS_VIA=chain` to keep only the blockchain APIs on Tor. Point monero-wallet-rpc at Tor too (`--proxy 127.0.0.1:9050`).

**Telegram pings** say only that money arrived or left (coin and your label). Set `NOTIFY_DETAIL=full` if you want amounts, addresses and links in them (Telegram keeps whatever it's sent).

## 9. Keeping it running

**Update to a new version:**

```bash
git pull
docker compose up -d --build        # or: npm install && npm run build && npm start
```

The version number is shown in the taskbar.

**Back up** the data folder (Docker: the `wc-data` volume; Node: `./data`), plus your `.env`. Together they hold your orders, address book, permanent addresses and the encrypted hot-wallet seed.

**Logs:** open **Logs** on the desktop, or run `docker compose logs -f`.

## 10. Troubleshooting

| What you see | What to do |
|---|---|
| Server exits with `PAYOUT_ADDRESS_USDC_BASE is not set` | Add your USDC-on-Base address to `.env` (step 3). |
| `... is not a valid checksummed address` | Copy the address again straight from the exchange. Don't retype it, and don't change its letter case. |
| `Unknown host` | `ALLOWED_HOSTS` doesn't match the name in your address bar. Use the bare hostname, without `https://` or the port. |
| Creating an address fails | Check `FF_API_KEY` / `FF_API_SECRET`, and that your FixedFloat API key is active. |
| Payment sent but below the minimum | It's refunded automatically when it came from an ordinary wallet. Otherwise, the transfer window asks you for a refund address. |
| "Locked out" after wrong passwords | Wait it out. The lockout doubles with each failed try, up to 1 hour. |

## Keeping your secrets safe

- **Never commit or share** `.env`, the `data/` folder, `seed-backup.txt`, your FixedFloat secret, or your `WALLET_KEY`.
- Use a unique, long `APP_PASSWORD`.
- Anything in flight (including Privacy funds during their wait) sits on the server. Keep the server updated and don't leave large amounts waiting.
