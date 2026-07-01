// Quiets the app's own Logger (src/logger.ts) during tests — info/debug
// noise is suppressed, but warn/error still fire since some tests assert
// on them. Individual tests can still call logger.setLevel(...) to observe
// specific log calls (e.g. debug-level output).
process.env.LOG_LEVEL ??= 'warn';
