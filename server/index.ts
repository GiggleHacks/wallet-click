import { buildApp } from './app.js';
import { hasPassword } from './auth.js';
import { config } from './config.js';
import { startPoller, stopOrders } from './orders.js';
import { startTransfers, stopTransfers } from './transfers.js';
import { walletState } from './wallets/seed.js';

const app = await buildApp();
if (!hasPassword()) {
  app.log.error('Set APP_PASSWORD (8+ characters) in .env, then start again.');
  process.exit(1);
}
if (!config.ff.apiKey || !config.ff.apiSecret) app.log.warn('FF_API_KEY / FF_API_SECRET are not set: new addresses will fail.');
if (!config.monero.rpcUrl) app.log.warn('MONERO_RPC_URL is not set: Privacy Enhanced and permanent Monero addresses are off.');
const hot = walletState();
if (hot.error) app.log.error(hot.error);
else if (!hot.ready) app.log.warn('No hot wallet (WALLET_KEY + npm run wallet:init): permanent Bitcoin/Ethereum addresses are off.');
if (hot.backupPending) app.log.warn('data/seed-backup.txt still holds the hot wallet words: write them down, then delete it.');
const stopPoller = startPoller(app.log);
const stopEngine = startTransfers(app.log);
await app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stopPoller();
    stopEngine();
    stopTransfers();
    stopOrders();
    app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
app.log.info(`Wallet Click listening on http://${config.host}:${config.port}, paying out to ${config.payout.address}`);
