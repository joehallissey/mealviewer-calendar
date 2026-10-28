# MealViewer / Nutrislice → Calendar

Get your kid's school lunch menu onto the family calendar. Works with [Skylight](https://refer.skylightframe.com/wphpa29n) (Referral Code), Google Calendar, Apple Calendar, Outlook, or any calendar app that can subscribe to a link.

If your school posts its menu on **[MealViewer](https://schools.mealviewer.com/)** or **[Nutrislice](https://www.nutrislice.com/)**, this small, free [Cloudflare Worker](https://workers.cloudflare.com/) turns that menu into a calendar feed you can subscribe to. Once it's set up there's nothing else to do: new weeks appear on your calendar as the school posts them.

![A family wall-calendar display in week view for November 9–13, 2026. Each school day shows breakfast and lunch menus as colored all-day events — one color per calendar — with Wednesday marked as a school holiday, and family events like soccer practice and piano lessons on the timed grid below.](images/hero-wall-display.png)

Each school day becomes one all-day event:

> **🍽 Lunch: Chicken Tenders / Toasted Grilled Cheese**
> Entrées: Chicken Tenders, Toasted Grilled Cheese, Sunbutter & Jelly Sandwich
> Veggies: Seasoned Corn, Fresh Cucumber Slices
> Fruit: Fresh Apple, Raisins

<img src="images/event-detail.png" alt="A phone calendar app showing a lunch event opened: an all-day event with the full title, the calendar name 'Lincoln Lunch', and the menu broken into Entrées, Veggies, Sides and Fruit." width="280">

A few details:

- Milk, ketchup, ranch and other condiments are left out, along with headings like "FEATURED ENTREES".
- Nutrislice menus don't sort dishes into groups reliably, so their events list every dish in the order the school posts them. Second choices like "Vegetarian Option: …" stay out of the title.
- Special days like "Holiday Meal!" show up in the title.
- Days with no menu, like holidays and weekends, simply have no event.
- You can set up breakfast, snacks, or lunch at more than one school. Each gets its own calendar.
- The calendar shows the past week and the next five weeks.

> This is a personal project, not affiliated with MealViewer, Nutrislice or Skylight. It reads the same public menu that the MealViewer or Nutrislice website shows. If either changes their website, this may stop working until someone updates the code.

## Let an AI assistant set it up

If you use an AI tool that can run commands on your computer, such as [Claude Code](https://claude.ai/referral/6X4R68E8dQ?s=claude_ai) (Referral Code), Codex, Cursor, or GitHub Copilot in agent mode, you can hand it this and fill in the blanks:

```text
Set up https://github.com/joehallissey/mealviewer-calendar for me so my kid's school
menu shows up on my family calendar. Clone it and follow the instructions in its AGENTS.md.

- My school's menu page: [paste the schools.mealviewer.com/school/... or <district>.nutrislice.com/menu/... link]
- Menus I want: [e.g. lunch only / lunch and breakfast / lunch and afternoon snack]
- Other kids at different schools (optional): [their menu links and menus]
- Show the school's name in event titles? [yes, e.g. "Lincoln" / no]
- My time zone: [e.g. Denver]
- My calendar app: [e.g. Skylight / Google Calendar / Apple Calendar]
```

It will do the steps below and give you the calendar links when it's done. At one point a browser window will open asking you to sign in to Cloudflare. That part is yours to do.

A chat-only assistant (one that can't run anything on your computer) can't do the setup for you, but it can help you through the steps below.

## Set it up yourself

### What you need

- A school that uses MealViewer or Nutrislice
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up). No credit card needed.
- [Node.js](https://nodejs.org/) version 22 or newer. This is what runs the setup commands.
- About 10 minutes

You'll be typing a few commands into the Terminal app (Mac) or Command Prompt (Windows). Each one is shown in a box below. Copy it, paste it, and press Enter.

### 1. Download the code

```bash
git clone https://github.com/joehallissey/mealviewer-calendar.git
```

```bash
cd mealviewer-calendar && npm install
```

### 2. Find your school's ID and menu names

**If your school uses Nutrislice**, open its menu in a browser (the address looks like `https://<district>.nutrislice.com/menu/<school>/...`) and copy the address from the address bar. That whole link is your `SCHOOL_ID`. Then check which menus your school posts:

```bash
npm run menus -- https://lincolnisd.nutrislice.com/menu/lincoln-elementary/lunch/2026-10-26
```

```
Menus for Lincoln Elementary (lincolnisd/lincoln-elementary). Use one of these names (or the code in brackets) as MEAL:

  Lunch (lunch)
  Breakfast (breakfast)
```

**If your school uses MealViewer**, look up your school at [schools.mealviewer.com](https://schools.mealviewer.com/). The last part of its page's web address is the school's ID. It's usually the school's name squashed together, though some districts use a number:

```
https://schools.mealviewer.com/school/LincolnES
                                      ^^^^^^^^^ this part
```

If your district's link lands on a district page, click through to your school first.

Then run this to see which menus your school posts (use your own link):

```bash
npm run menus -- https://schools.mealviewer.com/school/LincolnES
```

```
Menus for LINCOLN ELEMENTARY (LincolnES). Use one of these as MEAL:

  Afternoon Snack
  Breakfast
  Elementary Lunch
```

Every school names its menus a little differently, so write down the ones you want as shown. Capitals and extra spaces don't matter, but the words do.

### 3. Fill in your school's details

Make your settings file. On a Mac, or in PowerShell on Windows:

```bash
cp wrangler.example.toml wrangler.toml
```

In Windows Command Prompt, use this instead:

```bash
copy wrangler.example.toml wrangler.toml
```

Open `wrangler.toml` in any text editor and fill it in. For a single lunch calendar it looks like this:

```toml
[vars]
SCHOOL_ID = "LincolnES"
TIMEZONE = "America/Denver"

[vars.FEEDS.lunch]
MEAL = "Elementary Lunch"
```

| Line | What to put |
| --- | --- |
| `SCHOOL_ID` | The ID from step 2, or the whole Nutrislice link |
| `TIMEZONE` | Your time zone, like `"America/Denver"`. [Here's the full list.](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) |
| `[vars.FEEDS.lunch]` | Starts one calendar. The word after `FEEDS.` becomes the end of its link, so this one will be `/lunch.ics` |
| `MEAL` | One of the menu names from step 2 |

For a Nutrislice school, put the link in quotes:

```toml
[vars]
SCHOOL_ID = "https://lincolnisd.nutrislice.com/menu/lincoln-elementary"
TIMEZONE = "America/Chicago"

[vars.FEEDS.lunch]
MEAL = "Lunch"
```

Whatever comes after the school's name in the link (the menu and the date) is ignored, so it doesn't matter which day you copied it from.

`wrangler.toml` is git-ignored, so your school's details never get committed.

Want breakfast too, or kids at different schools? See [Breakfast, snacks, and more than one kid](#breakfast-snacks-and-more-than-one-kid) below. You can also come back and add those later.

### 4. Deploy

Sign in to Cloudflare. This opens a browser window:

```bash
npx wrangler login
```

Then deploy:

```bash
npm run deploy
```

When it finishes, it prints your Worker's address, like `https://school-lunch-calendar.<your-account>.workers.dev`. Your calendar link is that address with `/lunch.ics` on the end:

```
https://school-lunch-calendar.<your-account>.workers.dev/lunch.ics
```

Paste it into a browser to check. It should download a small calendar file.

### 5. Add it to your calendar app

<img src="images/phone-agenda.png" alt="A phone calendar in agenda view listing each day of the week with its breakfast and lunch menus, with Wednesday shown as a school holiday." width="280">

- **Skylight:** open the Skylight app, go to Calendar, then Sync a new calendar, choose the iCal / URL option, and paste your link. If it won't accept a link starting with `https://`, change that part to `webcal://`.
- **Google Calendar:** on a computer, next to "Other calendars" click **+**, then "From URL".
- **Apple Calendar:** File menu, then "New Calendar Subscription".
- **Outlook:** "Add calendar", then "Subscribe from web".

Calendar apps check for updates every few hours, so give it a little while for the first events to appear.

## Breakfast, snacks, and more than one kid

Each `[vars.FEEDS.something]` section in your settings file is one feed: a separate calendar with its own link. Add as many as you want, then run `npm run deploy` again. Because each is a separate calendar, you can turn them on and off one at a time in your calendar app.

### Lunch and breakfast at the same school

```toml
[vars]
SCHOOL_ID = "LincolnES"
TIMEZONE = "America/Denver"

[vars.FEEDS.lunch]
MEAL = "Elementary Lunch"

[vars.FEEDS.breakfast]
MEAL = "Breakfast"
```

Now you have two links: one ending in `/lunch.ics` and one ending in `/breakfast.ics`.

### Kids at different schools

Give a feed its own `SCHOOL_ID` to point it at a different school. Feeds without one inherit the top-level `SCHOOL_ID`. Run `npm run menus` with the other school's link first, since its menus will probably have different names.

```toml
[vars]
SCHOOL_ID = "LincolnES"        # Lincoln Elementary
SCHOOL_NAME = "Lincoln"
TIMEZONE = "America/Denver"

[vars.FEEDS.lunch]
MEAL = "Elementary Lunch"

[vars.FEEDS.breakfast]
MEAL = "Breakfast"

[vars.FEEDS.kid2-lunch]
SCHOOL_ID = "RooseveltMS"        # Roosevelt Middle
SCHOOL_NAME = "Roosevelt"
MEAL = "Middle School Lunch"
```

That's three calendars: lunch and breakfast from Lincoln, and `/kid2-lunch.ics` from Roosevelt. Add more schools the same way. MealViewer and Nutrislice schools can be mixed: a feed's `SCHOOL_ID` can be a MealViewer ID or a Nutrislice link. If a school is in a different time zone, set `TIMEZONE` on its feed.

### Showing the school's name in the title

![Two calendars for the same day side by side. On the left, without a school name, both lunches read '🍽 Lunch:' in the same color and can't be told apart. On the right, with a school name, they read '🍽 Lincoln Lunch:' and '🍽 Roosevelt Lunch:' in two different colors.](images/school-names-compare.png)

When several calendars share one screen, it helps to see whose lunch is whose. Add a `SCHOOL_NAME` line with a short name, and it goes into the titles:

```toml
SCHOOL_NAME = "Lincoln"
```

Events now read **🍽 Lincoln Lunch: Chicken Tenders / Toasted Grilled Cheese**, and the calendar is called "Lincoln Lunch".

A top-level `SCHOOL_NAME` applies to every feed using the top-level `SCHOOL_ID`. A feed with its own `SCHOOL_ID` doesn't inherit it, so give that feed its own `SCHOOL_NAME`, as in the example above. Without it, titles just say "🍽 Lunch:" and the calendar is called "School Lunch".

### Your own wording

Calendars get sensible names on their own: a breakfast menu becomes "School Breakfast" with titles starting "🥞 Breakfast:", a snack menu gets "🍎 Snack:", and so on. If you'd rather write your own, add either of these lines to a feed:

```toml
CALENDAR_NAME = "Sam's Breakfast"
EVENT_PREFIX = "🥯 Sam's breakfast:"
```

### Every setting in one place

| Setting | Where | What it does |
| --- | --- | --- |
| `SCHOOL_ID` | top level or feed | Which school's menu to use: a MealViewer ID, or a Nutrislice menu link |
| `TIMEZONE` | top level or feed | Your time zone, like `"America/Denver"` |
| `SCHOOL_NAME` | top level or feed | Optional. A short school name for the titles |
| `MEAL` | feed | The menu name, exactly as `npm run menus` shows it (for Nutrislice, the name or the code in brackets) |
| `CALENDAR_NAME` | feed | Optional. What the calendar is called in your app |
| `EVENT_PREFIX` | feed | Optional. The words before the dishes in each title |

Feed names (the part after `FEEDS.`) can have letters, numbers and dashes.

Forgot a menu's exact name? Open your Worker's address with `/menus` on the end to see them all.

**Set this up before the multi-calendar version?** A `wrangler.toml` with `MEAL` directly under `[vars]` and no `FEEDS` still works and serves `/lunch.ics`. Switch to `FEEDS` when you want a second calendar. Keep a feed named `lunch` and your existing link keeps working.

## A note on privacy

Anyone who has your calendar link can see that menu. The link also includes your Cloudflare account name and your feed names. The menus are public on MealViewer and Nutrislice anyway, but if you share screenshots or code, leave the links out. If you'd rather not have kids' names in links, name the feeds something like `kid1-lunch` and use `CALENDAR_NAME` for the friendly name.

## For tinkerers

### Changing what gets filtered

Everything is in [`src/index.js`](src/index.js):

- **What counts as a condiment:** `CONDIMENTS` (exact names) and `CONDIMENT_SUFFIX` (anything ending in "sauce", "dressing", etc.)
- **Which food groups are included (MealViewer):** `KEEP_TYPES`. Add `MILK: "Milk"` to include milk.
- **Everyday items kept out of the title:** `TITLE_SKIP`
- **Second choices kept out of the title (Nutrislice):** `ALTERNATE`
- **How far ahead and back:** `DAYS_AHEAD` and `DAYS_BACK`

Run `npm run deploy` after changing anything, and `npm test` to check nothing else broke. The tests run the Worker against saved menus in `test/fixtures` with no network access.

### Trying it on your computer first

```bash
npm run dev
```

Then open http://localhost:8787/lunch.ics (or any of your feed names) or http://localhost:8787/menus.

### How it works

The Worker asks MealViewer's or Nutrislice's public menu API for your school's menu, keeps the meal each feed asks for, drops condiments and headings, and returns a standard `.ics` calendar file. Nutrislice serves a week at a time, so a Nutrislice calendar takes about seven requests. Cloudflare caches each calendar for an hour, so the menu site gets at most one round of requests per hour per calendar no matter how often your apps check.

## Related projects and references

- [mealviewer-to-ICS](https://github.com/Meandmybadself/mealviewer-to-ICS) by Meandmybadself: the same idea, built independently in 2024. The author hosts one copy that anyone can subscribe to by putting their school ID in the link, so there's nothing to set up. It shows lunch or breakfast only, puts the dishes in the event notes rather than the title, and doesn't filter out milk or condiments.
- [ann-arbor-lunch-cal](https://github.com/georgeh/ann-arbor-lunch-cal) by georgeh: lunch calendars for every school in a Nutrislice district, published to GitHub Pages by a daily GitHub Action. Fork it and set your district to make your own.
- The MealViewer menu API isn't documented by MealViewer. The address this project uses is the one the MealViewer website itself requests when it shows a menu. The same goes for Nutrislice's menu API (`<district>.api.nutrislice.com/menu/api/...`).
- [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545) is the iCalendar standard the `.ics` output follows.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/) run and deploy it.

## License

[MIT](LICENSE)
