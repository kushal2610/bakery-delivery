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
5. **Give each person a role** (`admin`, `baker` or `driver`). New accounts
   have no role and see nothing until you set one. Run in the SQL Editor:
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'you@example.com');

   update public.profiles set role = 'driver'   -- or 'baker'
   where id = (select id from auth.users where email = 'dan@example.com');
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

**Updating:** when `supabase/schema.sql` changes, paste and run it again.
It upgrades the existing database in place (for example, accounts with the
old `staff` role become `driver`) and keeps all data.

## Roles

| | admin | baker | driver |
|---|:---:|:---:|:---:|
| See order quantities, route, Copy Table, Save PDF | ✓ | ✓ | ✓ |
| Enter / change order quantities | ✓ | | |
| Record what was baked (**Bake** tab) | ✓ | ✓ | |
| Price breakdown per product and day total, for invoices (**Bake** tab, Totals) | ✓ | ✓ | |
| Amount per stop and total for the day | ✓ | | ✓ |
| Prices, payment mode (Cash / Online / Unpaid), sales totals | ✓ | | |
| Add / edit / remove stores and products, reorder stores | ✓ | | |
| Clear all quantities for a date | ✓ | | |

Tabs: the admin sees all six. The baker starts on **Bake** and also gets
Orders, Route (read-only) and Totals. The driver gets Route and Totals.

If someone sees the wrong tabs, check their role: tap the initial in the top
bar, or run `select u.email, p.role from auth.users u join public.profiles p
on p.id = u.id;`. Accounts with the first version's `staff` role became
`driver`.

The database enforces these rules, so hiding a button is not the only
protection. Money is kept in admin-only tables, and drivers only get a total
per stop. Removing a store or product archives it, so past orders keep their
names. Every change records who made it (`updated_by`).

## Prices

- Set a product's **normal price** (inc. GST) in Products. Give a store a
  **special price** in Stores → edit store; leave it blank to use the normal
  price.
- Each order line keeps the price it was entered at. When you change a price,
  orders for **today and later** follow it, while **past days keep their
  price**. "Today" uses Sydney time (in `reprice_open_orders()` in
  `schema.sql`).
- Totals warns if any order line has no price (counted as $0).
- The WhatsApp table and the PDF never show prices.
- **Bake → Price Breakdown** lists each product as `qty × price = amount`.
  A store's special price gets its own line, and an item without a price is
  flagged. It ends with a subtotal per product and the day's total (Totals
  shows the same values on the product cards). The baker sees this for
  invoicing, but not store names with prices, store amounts or payments.

## Production check

The baker enters what was made on the **Bake** tab. Each product turns
**green** when baked ≥ ordered and **red** when short (with the difference),
and the line above sums it up: "✅ Production covers all orders", "⚠️ Short:
9 Pack -2", or what's still waiting to be entered. It updates live when an
order changes.

## Routes

- **Route 1** runs Mon · Wed · Fri, **Route 2** Tue · Thu · Sat. Set a
  store's route in Stores → edit store. Existing stores start on Route 1.
- The toggle on **Orders** and **Stores** shows one route's stores. It
  follows the delivery date (a Thursday shows Route 2). Tap it to switch;
  Sunday keeps the current one.
- Stops are numbered per route. "Edit order" and "Position in route" only
  reorder within that route.
- The **Route** tab and the PDF list every store with orders on the date,
  route 1's stops first.
- Route days are set in `ROUTES` in `index.html`.

## Notes

- **Delivery date:** the app opens on today's deliveries before 12:00 and on
  tomorrow's after (`NEXT_DAY_FROM_HOUR` in `index.html`). Use ‹ › or tap the
  date to see or fix any other day. All days are kept. Payments and baked
  quantities are kept per date too.
- **Drivers' amounts** update when an order changes. After a price change
  they refresh within a minute, or when the app is reopened.
- **Sync dot** on the account button: green = saved, amber = saving,
  red = retrying.
- **Free plan:** Supabase pauses a free project after about a week with no
  activity. Restore it from the dashboard, or use a paid plan.
- **Passwords:** reset or change them in Authentication → Users.
