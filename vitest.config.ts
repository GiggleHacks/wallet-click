import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  test: {
    root: '.',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Made-up payout addresses (see test/helpers.ts): the server won't start without one.
    env: {
      PAYOUT_ADDRESS_USDC_BASE: '0xBA5eba5EBa5EbA5eBA5EBA5eBa5EBa5ebA5ebA5E',
      PAYOUT_ADDRESS: '0x7E577e577e577E577e577E577E577E577e577E57',
    },
  },
});
