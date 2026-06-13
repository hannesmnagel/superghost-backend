// Test environment defaults so any accidental `config` import doesn't crash the runner,
// and integration tests have a valid JWT secret. No real database is used by default —
// tests run against the in-memory repositories.
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test'
process.env.JWT_SECRET ??= 'test-secret-key-at-least-16-chars-long'
process.env.BOT_FILL_MS ??= '50'
process.env.TURN_TIMEOUT_MS ??= '2000'
