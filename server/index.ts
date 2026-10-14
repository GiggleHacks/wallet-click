import { buildApp } from './app.js';
import { hasPassword } from './auth.js';
import { config } from './config.js';
import { startPoller, stopOrders } from './orders.js';

const app = await buildApp();
if (!hasPassword()) {
  app.log.error('Set APP_PASSWORD (8+ characters) in .env, then start again.');
  process.exit(1);
}
if (!config.ff.apiKey || !config.ff.apiSecret) app.log.warn('FF_API_KEY / FF_API_SECRET are not set: new addresses will fail.');
const stopPoller = startPoller(app.log);
await app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stopPoller();
    stopOrders();
    app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
app.log.info(`Wallet Click listening on http://${config.host}:${config.port}, paying out to ${config.payout.address}`);
