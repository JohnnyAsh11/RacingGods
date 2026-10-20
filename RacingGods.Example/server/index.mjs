import { createGateway } from './gateway.mjs';

const server = createGateway();
function stop() {
  server.shutdown();
  if (process.connected) process.disconnect();
}
server.on('error', () => {
  console.error('Cannot start the local API gateway on 127.0.0.1:8787. Check whether the port is in use.');
  stop();
  process.exitCode = 1;
});
server.listen(8787, '127.0.0.1', () => {
  console.log('OpenF1 dashboard gateway: http://127.0.0.1:8787');
  process.send?.({ type: 'ready' });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
process.on('message', (message) => {
  if (message?.type === 'shutdown') stop();
});
process.on('disconnect', stop);
