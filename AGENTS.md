# Instructions for AI agents

This repo is a Cloudflare Worker that turns a school's MealViewer or Nutrislice menu into `.ics` calendar feeds. There are two kinds of tasks: setting it up for a family, or changing the code.

## Setting it up for someone

The goal: one or more working calendar links (e.g. `https://school-lunch-calendar.<account>.workers.dev/lunch.ics`) that the person can subscribe to in Skylight, Google Calendar, Apple Calendar or Outlook.

### 1. Gather details

Ask for anything the user hasn't already given you:

- **School:** their school's MealViewer link (`https://schools.mealviewer.com/school/<SCHOOL_ID>`; the ID is usually a name like `LincolnES`, sometimes a number), or its Nutrislice menu link (`https://<district>.nutrislice.com/menu/<school>/...`), or the school's name. If they only give a name, ask whether the school uses MealViewer or Nutrislice and have them find the school's menu page and paste the link. Don't guess IDs.
- **Menus:** which menus they want (lunch, breakfast, snack…), and for which kids/schools. A family can have any number of schools.
- **School names in titles:** whether event titles should include a short school name ("🍽 Lincoln Lunch: …"). Recommend it when there's more than one school, since all calendars show together on one Skylight board.
- **Time zone:** a city or region is enough. Convert it to an IANA name like `America/Denver`.
- **Calendar app:** so you can give the right subscribe steps at the end.

### 2. Prerequisites

- Node.js 22 or newer (`node -v`). If it's missing, help the user install it from https://nodejs.org/ (or with their package manager) before continuing.
- Clone the repo if you're not already in it, then run `npm install`.

### 3. Find the exact menu names

For each school:

```bash
npm run menus -- <SCHOOL_ID, MealViewer URL or Nutrislice URL>
```

It prints the school's name, so confirm with the user that it's the right school, and lists the menu names. `MEAL` must match a name (capitals and spacing don't matter, the words do). For Nutrislice it also shows each menu's code in brackets, and `MEAL` can be either. Pick the one matching what the user asked for (e.g. "lunch" → "Elementary Lunch"). Ask if it's ambiguous, e.g. there's both "K-5 Lunch" and "Pre-K Lunch" and you don't know the kid's grade.

If no menus are listed, the school may not have posted any yet (common in summer). Tell the user, and set the feed up anyway with the names they expect. It starts working once menus are posted.

### 4. Write `wrangler.toml`

```bash
cp wrangler.example.toml wrangler.toml
```

(`copy` instead of `cp` in Windows Command Prompt.)

Then edit it. Use one `[vars.FEEDS.<name>]` table per calendar:

```toml
[vars]
SCHOOL_ID = "LincolnES"
SCHOOL_NAME = "Lincoln"
TIMEZONE = "America/Denver"

[vars.FEEDS.lunch]
MEAL = "Elementary Lunch"

[vars.FEEDS.breakfast]
MEAL = "Breakfast"

# Second kid at another school: give the feed its own SCHOOL_ID and SCHOOL_NAME
[vars.FEEDS.kid2-lunch]
SCHOOL_ID = "RooseveltMS"
SCHOOL_NAME = "Roosevelt"
MEAL = "Middle School Lunch"
```

- For a Nutrislice school, `SCHOOL_ID` is the menu link as the user pasted it, in quotes (`SCHOOL_ID = "https://lincolnisd.nutrislice.com/menu/lincoln-elementary/lunch/2026-10-26"`). The parts after the school's slug are ignored, so `MEAL` is still needed. MealViewer and Nutrislice schools can be mixed across feeds.
- Feed names (letters, numbers, dashes) become the link path: `/<name>.ics`.
- Feeds inherit the top-level `SCHOOL_ID`, `SCHOOL_NAME` and `TIMEZONE`. A feed that sets its own `SCHOOL_ID` does **not** inherit `SCHOOL_NAME`, so give it its own.
- `SCHOOL_NAME` is optional, and a short name works best ("Lincoln", not "Lincoln Elementary School"). It produces "Lincoln Lunch" / "🍽 Lincoln Lunch:". Leave it out for "School Lunch" / "🍽 Lunch:".
- `CALENDAR_NAME` and `EVENT_PREFIX` are optional and override the automatic labels.
- Feed names appear in public links. Suggest neutral names (`kid2-lunch`) over children's names, and put names in `CALENDAR_NAME` instead if the user wants them.
- If several people will deploy from one Cloudflare account, or the user wants a different address, change `name` at the top of the file.
- `wrangler.toml` is git-ignored on purpose. Never commit it or paste its contents anywhere public.

### 5. Sign in to Cloudflare and deploy

```bash
npx wrangler login
```

This opens a browser for the user to sign in to (or create) a free Cloudflare account. The user must do this step themselves. Never ask for their Cloudflare password or API token, and never type credentials for them. If the command can't open a browser, give the user the link it prints.

Then:

```bash
npm run deploy
```

The output includes the Worker's address (`https://<name>.<account>.workers.dev`). If Wrangler says the account has no workers.dev subdomain yet, have the user pick one in the Cloudflare dashboard (Workers & Pages), then deploy again.

### 6. Verify each feed

For every feed name:

```bash
curl -s https://<worker-address>/<feed>.ics | grep -c BEGIN:VEVENT
```

- A number above 0 means it works. Also check that one `SUMMARY:` line looks like a sensible meal.
- 0 events usually means `MEAL` doesn't match a menu name. Check `https://<worker-address>/menus`, fix `wrangler.toml`, and redeploy. Or the school hasn't posted menus yet.
- A text error instead of a calendar points to the problem, e.g. `SCHOOL_ID is not set`, or for Nutrislice `No menu called "Snack"` (it lists the right names).

### 7. Hand over

Give the user each calendar link and the subscribe steps for their app:

- **Skylight:** Skylight app → Calendar → Sync a new calendar → iCal / URL option → paste the link. If it rejects `https://`, use `webcal://`.
- **Google Calendar:** on the web, Other calendars → + → From URL.
- **Apple Calendar:** File → New Calendar Subscription.
- **Outlook:** Add calendar → Subscribe from web.

Mention that apps refresh every few hours, so events can take a while to show up, and that new weeks appear automatically with nothing to maintain. To change menus later, they edit `wrangler.toml` and run `npm run deploy` again.

## Changing the code

- All logic is in `src/index.js`. No runtime dependencies; keep it that way. `scripts/list-menus.mjs` is the `npm run menus` helper.
- Each source (MealViewer, Nutrislice) turns its API's data into `{ date, theme, title, description }` days, and `buildCalendar` only formats them. Keep source-specific heuristics inside the source.
- Run `npm test` after any change. It runs the Worker against the saved responses in `test/fixtures` with the clock fixed. If output changes on purpose, rerun with `UPDATE_GOLDEN=1` and check the `.ics` diff. Fixtures must use made-up schools and districts.
- Test locally with `npm run dev` and `curl http://localhost:8787/<feed>.ics`. Wrangler caches responses in `.wrangler/state`, so delete that folder between runs when comparing output.
- Event UIDs are `<feed>-<SCHOOL_ID>-<YYYYMMDD>@school-lunch` (for Nutrislice, `<feed>-<district>-<school>-<YYYYMMDD>@school-lunch`). Don't change that format, or every subscriber's calendar shows duplicates.
- A `wrangler.toml` without `FEEDS` (top-level `MEAL`) must keep serving `/lunch.ics`, for people on older configs.
- Output must stay valid RFC 5545: CRLF line endings, lines folded at 75 octets, and text escaped through `escapeText`.
- Never commit `wrangler.toml`, `wrangler.*.toml` (other than the example), real school IDs, or deployed Worker URLs.
