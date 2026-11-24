# Tests

Made-up data only: nothing here touches your Supabase project.

```
cd tests
npm install          # once: installs PGlite (Postgres in Node)
npm run test:db      # database rules in ../supabase/schema.sql
npm run test:app     # the app in headless Chrome, against a fake Supabase
```

- `db.test.mjs` runs `schema.sql` on a real Postgres engine (PGlite), with a
  small stand-in for Supabase's login system, and checks what each role
  (admin, baker, driver, no role, anonymous) can read and change.
- `e2e/run.mjs` builds a test copy of `index.html` that uses `e2e/mock_supabase.js`,
  runs `e2e/tests.js` in Chrome, and saves screenshots plus `invoices.pdf` (the
  printed invoices) to `e2e/out/`. If Chrome isn't in the usual place, set
  `CHROME` to its path.
