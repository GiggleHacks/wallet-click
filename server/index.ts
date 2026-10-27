import { buildApp } from './app.js';
import { hasPassword } from './auth.js';
import { config } from './config.js';
import { egressSummary } from './egress.js';
import { startPoller, stopOrders } from './orders.js';
import { fallbackSummary, fallbacks } from './providers/index.js';
import { startStash } from './stash/engine.js';
import { startTransfers, stopTransfers } from './transfers.js';
import { walletState } from './wallets/seed.js';

const app = await buildApp();
if (!hasPassword()) {
  app.log.error('Set APP_PASSWORD (8+ characters) in .env, then start again.');
  process.exit(1);
}
if (!config.ff.apiKey || !config.ff.apiSecret) app.log.warn(`FF_API_KEY / FF_API_SECRET are not set: new addresses ${fallbacks().length ? 'will use the fallbacks' : 'will fail'}.`);
app.log.info(`Swap providers: FixedFloat first; fallbacks: ${fallbackSummary()}.`);
if (!config.monero.rpcUrl) app.log.warn('MONERO_RPC_URL is not set: Privacy Enhanced and permanent Monero addresses are off.');
app.log.info(`Outbound traffic: ${egressSummary()}`);
if (!config.egress.proxy) app.log.warn('EGRESS_PROXY is not set: set it to a Tor SOCKS proxy (socks5h://127.0.0.1:9050) so FixedFloat and the blockchain APIs don\'t see this server\'s address.');
const hot = walletState();
if (hot.error) app.log.error(hot.error);
else if (!hot.ready) app.log.warn('No hot wallet (WALLET_KEY + npm run wallet:init): permanent Bitcoin/Ethereum addresses are off.');
if (hot.backupPending) app.log.warn('data/seed-backup.txt still holds the hot wallet words: write them down, then delete it.');
const stopPoller = startPoller(app.log);
const stopEngine = startTransfers(app.log);
const stopStash = startStash(app.log);
if (config.agentToken) app.log.info('OpenClaw access (AGENT_TOKEN) is on: /api/agent/*');
await app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stopPoller();
    stopEngine();
    stopStash();
    stopTransfers();
    stopOrders();
    app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
app.log.info(`Wallet Click listening on http://${config.host}:${config.port}, paying out to ${config.payoutBase.address}`);
