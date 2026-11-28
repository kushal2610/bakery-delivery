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
7. **Business details for invoices:** run `business_details.sql` (kept next
   to this folder, **not** in this public repository, because it holds your
   bank details) in the SQL Editor. Re-run it after changing any detail.
8. **Moving from the old version:** sign in as an admin on the device that
   has the correct stores/products. The Orders page offers a one-time
   **Upload to shared data**.

**Updating:** when `supabase/schema.sql` changes, paste and run it again.
It upgrades the existing database in place (for example, accounts with the
old `staff` role become `driver`) and keeps all data.

## Roles

| | admin | baker | driver |
|---|:---:|:---:|:---:|
| See order quantities, route, Save PDF | ✓ | ✓ | ✓ |
| Print invoices (Route tab) | ✓ | ✓ | ✓ |
| **Invoices** tab: find, save and print invoices, give credits | ✓ | ✓ | |
| Set when invoice tracking starts, unlock an invoice, remove a credit | ✓ | | |
| Enter / change order quantities | ✓ | | |
| Record what was baked (**Bake** tab) | ✓ | ✓ | |
| Store invoices: each store's products, prices and total, plus the day total (**Bake** tab) | ✓ | ✓ | |
| Amount per stop and total for the day | ✓ | | ✓ |
| Prices, each store's payment mode (Cash / Online), sales totals | ✓ | | |
| Add / edit / remove stores and products, reorder stores | ✓ | | |
| Clear all quantities for a date | ✓ | | |

Tabs: the admin sees all seven (on a phone the tab bar scrolls sideways).
The baker starts on **Bake** and also gets Orders, Route (read-only), Totals
and Invoices. The driver gets Route and Totals.

If someone sees the wrong tabs, check their role: tap the initial in the top
bar, or run `select u.email, p.role from auth.users u join public.profiles p
on p.id = u.id;`. Accounts with the first version's `staff` role became
`driver`.

The database enforces these rules, so hiding a button is not the only
protection. Money is kept in admin-only tables, and drivers only get a total
per stop. Removing a store or product archives it, so past orders keep their
names. Every change records who made it (`updated_by`).

## Prices

- All products are **GST-free**. Set a product's **normal price** in Products. Give a store a
  **special price** in Stores → edit store; leave it blank to use the normal
  price.
- Each order line keeps the price it was entered at. When you change a price,
  orders for **today and later** follow it, while **past days keep their
  price**. "Today" uses Sydney time (in `reprice_open_orders()` in
  `schema.sql`).
- Totals warns if any order line has no price (counted as $0).
- The delivery PDF (Save PDF) never shows prices.
- **Bake → Store Invoices** lists every store that ordered, in delivery
  order, with one line per product: `qty × product @ price = amount`
  (using that store's special price if it has one). Each store shows its
  total, and the list ends with the overall total. An item without a price is
  flagged and counted as $0. The baker sees this for invoicing; the price
  lists stay admin-only. Totals still shows the value per
  product on the product cards.

## Invoices

**Route → 🖨 Print invoices** makes one PDF with an **A4 invoice per store**
with orders on the selected date, in delivery order.

- **Computer:** the print dialog opens with the PDF (if the browser can't, the
  PDF is downloaded instead).
- **iPhone / iPad / Android:** the PDF is saved. Open it, then **Share →
  Print**.

Printing a PDF (not the web page) means Safari doesn't add the web address,
date and page numbers.

- **Invoice number** = delivery date + store number: 25 Nov 2026 for store #3
  is `261125-003`. It's unique per store and day, and a reprint gets the same
  number.
- **Your details** (name, address, phone, ABN, bank) come from the database
  (see setup step 7). The logo is `gj06-logo.png`; replace that file to change
  it.
- **Billed To** uses the store's contact name, name, address, phone and ABN.
  Fill these in at Stores → edit store. An ABN must be 11 digits.
- **Delivery charges** (GST-free) are added after the sub-total, and are part
  of each stop's amount on the Route, Totals and Bake tabs:
  - **Freight** (`freight_fee`, default $5) when a store's products come to
    less than `freight_under` (default $50)
  - **Fuel levy** (`fuel_levy`, default off) on every delivery

  Change them in Supabase → SQL Editor, for example to stop the fuel levy:
  `update public.business_settings set fuel_levy = 0 where id = 1;`
  (0 turns a charge off). The app picks up the change when it's next opened.
  An invoice not yet saved uses the current setting; a saved invoice keeps
  the charges it was saved with (see Saved invoices below).
- **Tax** prints as "Tax (GST-free) $0.00", and the due date is **C.O.D.**
- **Payment mode:** each store is Cash or Online (Stores → edit store; new
  and existing stores start on Cash). It prints in a dark bar under Balance
  due. The balance due is always the full amount; Totals splits the day's
  sales into Cash and Online by each store's payment mode.
- If any line has no price, the app asks before printing (it prints as $0.00).

### Saved invoices and the Invoices tab

- **Start date.** In **Invoices**, the admin sets the date invoice tracking
  starts (the cut-over from MYOB). Days before it are never saved and count as
  settled.
- **Saving ("issued").** From the start date, an invoice is saved the first
  time it's printed or saved as a PDF (from Route or Invoices). Until then it
  follows the order (**Not issued**). Once saved (**Issued**) it keeps its
  lines, prices and charges, even if the order, a price or a product name
  changes later.
- **Order changed.** If an order changes after its invoice was saved, the
  invoice is flagged **Order changed** and still prints as saved. Fix it with
  a credit, or (admin) **Unlock** it so it follows the order again until it's
  next printed. Route → Print invoices also warns before printing these.
- **Credits** (admin and baker): open an invoice, type the amount and a reason
  (e.g. "2 packs returned"). Credits print on the invoice and reduce its
  balance. A credit can't be more than the balance. Only the admin can remove
  one. Unlocking keeps the credits.
- **Find invoices** by date range (This week / Last week / This month or any
  dates), store name and status. **Save PDF** / **Print** make one PDF of the
  whole list as shown (oldest day first, each day in delivery order); the
  button on one invoice saves just that invoice.

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
  date to see or fix any other day. All days are kept. Baked quantities are
  kept per date too.
- **Drivers' amounts** update when an order changes. After a price change
  they refresh within a minute, or when the app is reopened.
- **Sync dot** on the account button: green = saved, amber = saving,
  red = retrying.
- **Free plan:** Supabase pauses a free project after about a week with no
  activity. Restore it from the dashboard, or use a paid plan.
- **Passwords:** reset or change them in Authentication → Users.
