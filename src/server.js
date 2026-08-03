'use strict';

const app = require('./app');
const db = require('./db');

const PORT = parseInt(process.env.PORT || '3000', 10);

const server = app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT} (pid ${process.pid})`);
});

/**
 * Graceful shutdown on SIGTERM.
 *
 * Kubernetes sends SIGTERM when it wants the pod to stop. We stop accepting
 * new connections, drain in-flight requests, then close the database pool —
 * in that order — before the process exits. The terminationGracePeriodSeconds
 * in the Deployment manifest gives us up to 30 s to finish.
 */
async function shutdown(signal) {
  console.log(`[server] ${signal} received — shutting down gracefully`);
  server.close(async () => {
    try {
      await db.end();
      console.log('[server] database pool closed');
    } catch (err) {
      console.error('[server] error closing database pool', err.message);
    }
    console.log('[server] goodbye');
    process.exit(0);
  });

  // Safety net: if draining takes longer than 25 s, force exit so Kubernetes
  // does not have to hard-kill with SIGKILL.
  setTimeout(() => {
    console.error('[server] graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 25000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
