# bakery-delivery

Order entry, delivery route and production totals for GJ 06, as a single
page (`index.html`). Data is shared between devices through Supabase.

## Supabase setup (once)

1. **Create a project** at [supabase.com](https://supabase.com). Choose the
   **Sydney (ap-southeast-2)** region. It can't be changed later, and a
   distant region makes every request slower.
2. **Create the tables:** Dashboard → **SQL Editor** → New query → paste all
   of [`supabase/schema.sql`](supabase/schema.sql) → **Run**. It's safe to run
   again later; it never deletes data.
3. **Turn off public sign-ups:** Authentication → Sign In / Providers →
   switch off **Allow new users to sign up**. Leave the **Email** provider on.
4. **Create a login per person:** Authentication → Users → **Add user** →
   Create new user (email + password, tick **Auto Confirm User**).
5. **Make yourself admin** (everyone else stays staff): run in the SQL Editor
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'you@example.com');
   ```
   Optional display name (shown as the initial in the top bar):
   ```sql
   update public.profiles set full_name = 'Dan'
   where id = (select id from auth.users where email = 'dan@example.com');
   ```
6. **Connect the app:** Project Settings → API Keys, then copy the
   **Project URL** and the **anon** (or **publishable**) key into the two
   constants at the top of the script in `index.html`:
   ```js
   const SUPABASE_URL      = 'https://xxxx.supabase.co';
   const SUPABASE_ANON_KEY = '...';
   ```
   These two values are meant to be public. Access is protected by the
   database rules in `schema.sql` plus each person's login. **Never** put the
   `service_role` / secret key in this file.
7. **Moving from the old version:** sign in as an admin on the device that
   has the correct stores/products. The Orders page offers a one-time
   **Upload to shared data**.

## Roles

| | staff | admin |
|---|:---:|:---:|
| Enter / change order quantities | ✓ | ✓ |
| Route, Totals, Copy Table, Save PDF | ✓ | ✓ |
| Add / edit / remove stores and products, reorder stores | | ✓ |
| Clear all quantities for a date | | ✓ |

The database enforces these rules, so hiding a button is not the only
protection. Removing a store or product archives it, so past orders keep their
names. Each quantity records who last changed it (`updated_by`).

## Notes

- **Delivery date:** the app opens on today's deliveries before 12:00 and on
  tomorrow's after (`NEXT_DAY_FROM_HOUR` in `index.html`). Use ‹ › or tap the
  date to see or fix any other day. All days are kept.
- **Sync dot** on the account button: green = saved, amber = saving,
  red = retrying.
- **Free plan:** Supabase pauses a free project after about a week with no
  activity. Restore it from the dashboard, or use a paid plan.
- **Passwords:** reset or change them in Authentication → Users.
