import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The integration tests talk to the real agent-bus CLI and start child
    // processes; five seconds (the default) is too tight on a loaded machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Leave CPU for AiderDesk and whatever the agents are building.
    maxWorkers: 4,
  },
});
