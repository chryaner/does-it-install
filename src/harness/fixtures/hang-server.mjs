// Accepts requests and never answers: exercises the handshake timeout and the
// teardown path. The interval keeps the process alive after stdin closes.
process.stdin.resume();
process.stdin.on('data', () => {});
setInterval(() => {}, 60_000);
