// test database settings; override with TEST_DATABASE_URL / TEST_MIGRATION_DATABASE_URL
export const TEST_ENV = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://propai_app:propai_app@localhost:5432/propai_test",
  MIGRATION_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL ?? "postgres://propai:propai@localhost:5432/propai_test",
  APP_URL: "http://localhost:3000",
  APP_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  MAIL_PROVIDER: "console",
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  FILE_STORAGE: "local",
  FILE_STORAGE_DIR: "/tmp/propai-test-uploads",
  // the SSO tests run a local OpenID Connect provider on http://127.0.0.1 (refused in production)
  OIDC_ALLOW_HTTP_ISSUERS: "true",
} as const;
