// Turns schools' MealViewer or Nutrislice menus into iCalendar feeds that Skylight, Google Calendar,
// Apple Calendar etc. can subscribe to. Settings come from the [vars] in wrangler.toml:
// each [vars.FEEDS.<name>] table becomes a feed at /<name>.ics, or without FEEDS the
// top-level settings make a single /lunch.ics feed.

const DAYS_BACK = 7;
const DAYS_AHEAD = 35;
const CACHE_SECONDS = 3600;
const FETCH_TIMEOUT_MS = 10_000;

const KEEP_TYPES = { ENTREES: "Entrées", VEGETABLE: "Veggies", "Breads/Grains": "Sides", FRUIT: "Fruit" };
const CONDIMENTS = new Set([
  "ketchup", "mustard", "ranch", "mayo", "mayonnaise", "margarine", "butter",
  "syrup", "salsa", "cream cheese", "sour cream", "jelly", "honey",
]);
// Standalone sauces/garnishes ("Sweet Chili Sauce"), but not dishes served with one
// ("Nachos with Cheese Sauce", "Biscuits and Gravy", "Chips & Dip").
const CONDIMENT_SUFFIX = /\b(sauce|dressing|dip|gravy|syrup)$/i;
const SERVED_WITH = /\bw\/|\bwith\b|\band\b|&/i;
const GARNISH = /\bgarnish$/i;
// Section headers, for menus typed entirely in capitals where case alone can't tell them apart.
const HEADER_NAME = /^(featured |daily )?(entrees?|vegetables?|fruits?|sides?|grains?|milk|options?|selections?|choice of \w+)$/i;
// Everyday staples (sunbutter & jelly sandwiches, bread rolls) stay in the notes but don't crowd
// the event title. "Egg Roll" and "Spring Roll" are mains, so only bread-type rolls match.
const TITLE_SKIP = /^(SBJ|WBJ|PBJ) Sandwich$|\b(dinner|bread|wheat|whole grain|wg|hawaiian) roll$/i;
// Nutrislice: second choices ("Vegetarian Option: Mac n Cheese") stay out of the title, and a dish
// written as "Chicken Tenders- Served with" loses the dangling "served with".
const ALTERNATE = /^(vegetarian|vegan|meatless|alternate|alt\.?)\s+(option|entr[eé]e|choice)\b/i;
const SERVED_WITH_TAIL = /\s*[-–—:,]?\s*(served|comes) with:?$/i;
// Nutrislice lists milk cartons as dishes ("Chocolate Milk"); "Cereal with Milk" is a real dish.
const MILK = /\bmilk$/i;
const WITH = /\bwith\b|\bw\//i;
// Notes longer than this ("Menu items are subject to change...") are disclaimers, not day themes.
const NOTE_MAX_LENGTH = 30;

// A Nutrislice menu link: https://<district>.nutrislice.com/menu/<school>[/<menu type>[/<date>]]
const NUTRISLICE_URL = /^(?:https?:\/\/)?([a-z0-9-]+)\.nutrislice\.com\/menu\/([a-z0-9-]+)(?:\/(?!\d{4}-\d{2}-\d{2}(?:[/?#]|$))([a-z0-9-]+))?(?:[/?#]|$)/i;
const SOURCE_NAMES = { mealviewer: "MealViewer", nutrislice: "Nutrislice" };

// A problem with the settings rather than with the menu site, shown to the user as is.
class SetupError extends Error {}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const feedPath = url.pathname.match(/^\/([A-Za-z0-9-]+)\.ics$/);
    if (!feedPath && url.pathname !== "/menus") {
      return new Response("Not found", { status: 404 });
    }

    let feeds;
    try {
      feeds = readFeeds(env);
    } catch (err) {
      return new Response(err.message, { status: 500 });
    }

    // Lists the menu names each configured school has, to help pick the right MEAL setting.
    if (url.pathname === "/menus") {
      const problems = [...feeds.values()].filter((feed) => feed.error).map((feed) => `Feed "${feed.feedName}": ${feed.error}\n`);
      const schools = new Map([...feeds.values()].filter((feed) => !feed.error).map((feed) => [feed.schoolId, feed]));
      // One school's outage shouldn't hide the others, so each is reported on its own.
      const sections = await Promise.all(
        [...schools.values()].map(async (feed) => {
          try {
            const { schoolName, menuNames } = await fetchMenuNames(feed);
            const school = schoolName ? `${schoolName} (${feed.schoolId})` : feed.schoolId;
            const hint = feed.source === "nutrislice" ? "Set MEAL to one of these names (or the code in brackets):" : "Set MEAL to one of these:";
            return menuNames.length
              ? `Menus for ${school}. ${hint}\n\n${menuNames.join("\n")}\n`
              : `No menus found for ${school} in the next few weeks. Check SCHOOL_ID, or try again once the school posts its menu.\n`;
          } catch (err) {
            if (err instanceof SetupError) return `${err.message}\n`;
            console.error("Failed to load menu names:", err);
            return `Couldn't reach ${SOURCE_NAMES[feed.source]} for ${feed.schoolId} right now. Try again in a few minutes.\n`;
          }
        }),
      );
      return new Response([...problems, ...sections].join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    const config = feeds.get(feedPath[1].toLowerCase());
    if (!config) {
      return new Response("Not found", { status: 404 });
    }
    if (config.error) {
      return new Response(config.error, { status: 500 });
    }

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/${config.feedName}.ics`);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let ics;
    try {
      const days = await fetchMenu(config);
      ics = buildCalendar(days, config);
    } catch (err) {
      if (err instanceof SetupError) return new Response(err.message, { status: 500 });
      console.error("Failed to load menu:", err);
      return new Response("Menu temporarily unavailable", { status: 502 });
    }

    const response = new Response(ics, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

// Returns a Map of feed name -> settings. Feeds inherit the top-level SCHOOL_ID, SCHOOL_NAME and
// TIMEZONE unless they set their own (e.g. a sibling at a different school). A feed with a bad
// setting is kept as { feedName, error } so a typo in one feed doesn't take the others down.
function readFeeds(env) {
  let defs = env.FEEDS;
  if (typeof defs === "string") {
    try {
      defs = JSON.parse(defs); // FEEDS set as a JSON variable in the Cloudflare dashboard
    } catch {
      throw new Error("FEEDS must be a table in wrangler.toml (or valid JSON).");
    }
  }
  if (Array.isArray(defs)) {
    throw new Error('FEEDS must be tables like [vars.FEEDS.lunch] with single brackets, not [[vars.FEEDS]].');
  }
  const fromFeeds = Boolean(defs && typeof defs === "object");
  const entries = fromFeeds
    ? Object.entries(defs)
    : [["lunch", { MEAL: env.MEAL, CALENDAR_NAME: env.CALENDAR_NAME, EVENT_PREFIX: env.EVENT_PREFIX }]];
  if (!entries.length) throw new Error("FEEDS is empty. Add at least one [vars.FEEDS.<name>] table.");

  const feeds = new Map();
  for (const [name, def] of entries) {
    const feedName = name.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(feedName)) {
      throw new Error(`Feed name "${name}" can only use letters, numbers and dashes.`);
    }
    if (feeds.has(feedName)) throw new Error(`Feed name "${name}" is used twice.`);
    try {
      if (!def || typeof def !== "object") throw new Error(`Feed "${name}" must be a table of settings.`);
      const inherited = { SCHOOL_ID: env.SCHOOL_ID, TIMEZONE: env.TIMEZONE };
      // The top-level school name only applies to feeds at the top-level school.
      if (!("SCHOOL_ID" in def)) inherited.SCHOOL_NAME = env.SCHOOL_NAME;
      // In FEEDS mode each feed names its menu; the legacy single-feed config may leave MEAL off.
      if (fromFeeds && !String(def.MEAL ?? "").trim()) {
        throw new Error(`MEAL is not set for the "${feedName}" feed. Add MEAL = "..." under [vars.FEEDS.${feedName}] (see /menus for the names).`);
      }
      feeds.set(feedName, readFeed(feedName, { ...inherited, ...def }));
    } catch (err) {
      feeds.set(feedName, { feedName, error: err.message });
    }
  }
  return feeds;
}

function readFeed(feedName, vars) {
  const schoolId = String(vars.SCHOOL_ID ?? "").trim();
  const nutrislice = schoolId.match(NUTRISLICE_URL);
  if (!nutrislice && /nutrislice\.com/i.test(schoolId)) {
    throw new Error(`SCHOOL_ID for the "${feedName}" feed looks like a Nutrislice link, but not a school's menu page. Open the school's menu on Nutrislice and copy that link (https://<district>.nutrislice.com/menu/<school>/...).`);
  }
  if (!nutrislice && (!/^[A-Za-z0-9-]+$/.test(schoolId) || schoolId === "YOUR-SCHOOL-ID")) {
    throw new Error(`SCHOOL_ID is not set for the "${feedName}" feed. Add it under [vars] or [vars.FEEDS.${feedName}] in wrangler.toml and redeploy.`);
  }
  const timezone = String(vars.TIMEZONE || "America/New_York");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`TIMEZONE "${timezone}" is not a valid IANA time zone name.`);
  }
  // A Nutrislice link can name the menu type itself (".../menu/lincoln-elementary/lunch"), so MEAL can be left out.
  const menuSlug = vars.MEAL ? null : nutrislice?.[3]?.toLowerCase();
  const meal = String(vars.MEAL || menuSlug || "Lunch");
  const { word, emoji } = mealLabel(meal);
  // An optional short school name ("Lincoln") goes into the labels, so several schools' calendars
  // can be told apart on one board: "Lincoln Lunch" / "🍽 Lincoln Lunch:".
  const schoolName = String(vars.SCHOOL_NAME ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  const label = schoolName ? `${schoolName} ${word}` : word;
  const source = nutrislice
    ? { source: "nutrislice", district: nutrislice[1].toLowerCase(), school: nutrislice[2].toLowerCase(), menuSlug }
    : { source: "mealviewer" };
  return {
    feedName,
    ...source,
    // Part of each event's UID, so it must stay the same for as long as the feed exists.
    schoolId: nutrislice ? `${source.district}-${source.school}` : schoolId,
    meal,
    timezone,
    calendarName: String(vars.CALENDAR_NAME || (schoolName ? label : `School ${word}`)),
    eventPrefix: String(vars.EVENT_PREFIX || `${emoji} ${label}:`),
  };
}

// Default labels so a breakfast feed doesn't say "Lunch" unless told otherwise.
function mealLabel(meal) {
  if (/breakfast/i.test(meal)) return { word: "Breakfast", emoji: "🥞" };
  if (/snack/i.test(meal)) return { word: "Snack", emoji: "🍎" };
  if (/supper|dinner/i.test(meal)) return { word: "Supper", emoji: "🍲" };
  return { word: "Lunch", emoji: "🍽" };
}

async function fetchJson(url, sourceName) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; mealviewer-calendar)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${sourceName} returned ${res.status}`);
  return res.json();
}

// The first and last day each feed covers, in the school's time zone.
function feedWindow(timezone) {
  const today = todayInTZ(timezone);
  return { start: addDays(today, -DAYS_BACK), end: addDays(today, DAYS_AHEAD) };
}

function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`));
}

// Each source returns the feed's days as { date, theme, title, description }.
function fetchMenu(config) {
  return config.source === "nutrislice" ? fetchNutrisliceMenu(config) : fetchMealViewerMenu(config);
}

function fetchMenuNames(config) {
  return config.source === "nutrislice" ? fetchNutrisliceMenuNames(config) : fetchMealViewerMenuNames(config);
}

// MealViewer

async function fetchSchedules({ schoolId, timezone }) {
  const { start, end } = feedWindow(timezone);
  const api = `https://api.mealviewer.com/api/v4/school/${encodeURIComponent(schoolId)}/${mdy(start)}/${mdy(end)}/0`;
  const data = await fetchJson(api, "MealViewer");
  return {
    schoolName: cleanText(data?.physicalLocation?.name),
    schedules: Array.isArray(data?.menuSchedules) ? data.menuSchedules : [],
  };
}

// Cleans text from the menu sites: control characters out, whitespace collapsed.
function cleanText(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

// Menu names are matched loosely ("Lunch " == "lunch"), since the menu data has stray spaces.
function sameName(a, b) {
  return cleanText(a).toLowerCase() === cleanText(b).toLowerCase();
}

async function fetchMealViewerMenuNames(config) {
  const { schoolName, schedules } = await fetchSchedules(config);
  const names = new Set();
  for (const schedule of schedules) {
    for (const block of schedule.menuBlocks ?? []) {
      const name = cleanText(block.blockName);
      if (name) names.add(name);
    }
  }
  return { schoolName, menuNames: [...names].sort() };
}

function isAllCaps(name) {
  return name === name.toUpperCase() && /[A-Z]/.test(name);
}

// Drops section headers and condiments from one day's items, and tidies dishes typed in capitals.
function tidyItems(items) {
  // Section headers like "FEATURED ENTREES" are in capitals. Some schools type every dish in
  // capitals too, so only treat capitals as a header when most of the menu isn't in capitals.
  const capsCount = items.filter((item) => isAllCaps(item.name)).length;
  const capsIsHeader = capsCount * 2 < items.length;

  const kept = [];
  for (const item of items) {
    let { name } = item;
    if (isAllCaps(name)) {
      if (capsIsHeader || HEADER_NAME.test(name)) continue;
      name = titleCase(name);
    }
    if (!isCondiment(name)) kept.push({ ...item, name });
  }
  return kept;
}

async function fetchMealViewerMenu(config) {
  const { meal } = config;
  const { schedules } = await fetchSchedules(config);

  const days = [];
  for (const schedule of schedules) {
    const date = String(schedule.dateInformation?.dateFull ?? "").slice(0, 10);
    const block = (schedule.menuBlocks ?? []).find((b) => sameName(b.blockName, meal));
    // A malformed date (e.g. month 13) skips just that day rather than failing the whole feed.
    if (!isValidDate(date) || !block) continue;

    const items = [];
    let theme = null;
    for (const line of block.cafeteriaLineList?.data ?? []) {
      for (const item of line.foodItemList?.data ?? []) {
        const name = cleanText(item.item_Name);
        const themeMatch = name.match(/^\*(.+)\*$/); // e.g. "*HOLIDAY MEAL!*"
        if (themeMatch) {
          theme = titleCase(themeMatch[1]);
          continue;
        }
        if (name && Object.hasOwn(KEEP_TYPES, item.item_Type)) items.push({ type: item.item_Type, name });
      }
    }

    const groups = Object.fromEntries(Object.keys(KEEP_TYPES).map((type) => [type, []]));
    for (const { type, name } of tidyItems(items)) {
      if (!groups[type].includes(name)) groups[type].push(name);
    }
    if (!Object.values(groups).some((group) => group.length)) continue;

    const mains = groups.ENTREES.filter((name) => !TITLE_SKIP.test(name));
    // Fall back through the groups so a snack that's only fruit still gets a title.
    const title = [mains, ...Object.values(groups)].find((items) => items.length).join(" / ");
    const description = Object.entries(KEEP_TYPES)
      .filter(([type]) => groups[type].length)
      .map(([type, label]) => `${label}: ${groups[type].join(", ")}`)
      .join("\n");
    days.push({ date, theme, title, description });
  }
  return days;
}

// Nutrislice

async function fetchNutrisliceSchool({ district, school, feedName }) {
  const schools = await fetchJson(`https://${district}.api.nutrislice.com/menu/api/schools/?format=json`, "Nutrislice");
  const found = Array.isArray(schools) && schools.find((s) => String(s?.slug ?? "").toLowerCase() === school);
  if (!found) {
    throw new SetupError(`Nutrislice has no school "${school}" in the "${district}" district. Check the SCHOOL_ID link for the "${feedName}" feed.`);
  }
  const menuTypes = (Array.isArray(found.active_menu_types) ? found.active_menu_types : [])
    .map((type) => ({ name: cleanText(type?.name), slug: String(type?.slug ?? "").toLowerCase() }))
    .filter((type) => /^[a-z0-9-]+$/.test(type.slug));
  return { schoolName: cleanText(found.name), menuTypes };
}

async function fetchNutrisliceMenuNames(config) {
  const { schoolName, menuTypes } = await fetchNutrisliceSchool(config);
  return { schoolName, menuNames: menuTypes.map((type) => `${type.name || type.slug} (${type.slug})`) };
}

// The menu type's code in Nutrislice links ("ele-menu"), from the link itself or by looking MEAL up.
async function nutrisliceMenuSlug(config) {
  if (config.menuSlug) return config.menuSlug;
  const { menuTypes } = await fetchNutrisliceSchool(config);
  const match = menuTypes.find((type) => sameName(type.name, config.meal) || sameName(type.slug, config.meal));
  if (match) return match.slug;
  // Between school years a school may list no menus at all. The feed stays empty until it posts them.
  if (!menuTypes.length) return null;
  const names = menuTypes.map((type) => type.name || type.slug).join(", ");
  throw new SetupError(`No menu called "${config.meal}" for the "${config.feedName}" feed. Set MEAL to one of: ${names}.`);
}

async function fetchNutrisliceMenu(config) {
  const { district, school, timezone } = config;
  const slug = await nutrisliceMenuSlug(config);
  if (!slug) return [];

  // Nutrislice serves a week at a time: the week containing the date asked for. Dates seven days
  // apart from the first day through the last cover every week in between, however the district's
  // weeks start. If any week fails the whole feed fails, since a calendar app given a feed with a
  // week missing would delete that week's events.
  const { start, end } = feedWindow(timezone);
  const dates = [];
  for (let date = start; ; date = addDays(date, 7)) {
    dates.push(date);
    if (date >= end) break;
  }
  const weeks = await Promise.all(
    dates.map((date) => {
      const [y, m, d] = date.split("-");
      return fetchJson(`https://${district}.api.nutrislice.com/menu/api/weeks/school/${school}/menu-type/${slug}/${y}/${m}/${d}/?format=json`, "Nutrislice");
    }),
  );

  const days = new Map();
  for (const week of weeks) {
    for (const day of Array.isArray(week?.days) ? week.days : []) {
      const parsed = nutrisliceDay(day);
      if (parsed && parsed.date >= start && parsed.date <= end) days.set(parsed.date, parsed);
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Nutrislice tags dishes as "entree" or "side" unreliably (the main dish is often untagged), so the
// title uses the tagged entrées when there are any besides alternates, else the first dish served.
// The description lists every dish in the order served.
function nutrisliceDay(day) {
  const date = String(day?.date ?? "");
  if (!isValidDate(date)) return null;

  let theme = null;
  const foods = [];
  for (const row of Array.isArray(day.menu_items) ? day.menu_items : []) {
    // Holidays ("Holiday Break"), headings and station names aren't dishes.
    if (!row || row.is_holiday || row.is_section_title || row.is_station_header) continue;
    if (!row.food) {
      // A note before the first dish ("Early Release") leads the title, like MealViewer's "*HOLIDAY MEAL!*".
      const note = cleanText(row.text);
      if (note && note.length <= NOTE_MAX_LENGTH && !foods.length && !theme) theme = isAllCaps(note) ? titleCase(note) : note;
      continue;
    }
    const name = cleanText(row.food.name).replace(SERVED_WITH_TAIL, "");
    if (!name || (MILK.test(name) && !WITH.test(name))) continue;
    const category = String(row.category || row.food.food_category || "").toLowerCase();
    foods.push({ name, entree: category === "entree" || category === "main" });
  }

  const items = [];
  for (const item of tidyItems(foods)) {
    const seen = items.find((other) => other.name === item.name);
    if (!seen) items.push(item);
    else seen.entree ||= item.entree;
  }
  if (!items.length) return null;

  const mains = items.filter((item) => item.entree && !ALTERNATE.test(item.name) && !TITLE_SKIP.test(item.name));
  const title = (mains.length ? mains : [items.find((item) => !TITLE_SKIP.test(item.name)) ?? items[0]])
    .map((item) => item.name)
    .join(" / ");
  return { date, theme, title, description: items.map((item) => item.name).join("\n") };
}

function buildCalendar(days, { feedName, schoolId, timezone, calendarName, eventPrefix }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//mealviewer-calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${timezone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  for (const { date, theme, title: dishes, description } of days) {
    const ymd = date.replace(/-/g, "");
    const next = addDays(date, 1).replace(/-/g, "");
    const title = theme ? `${theme} ${dishes}` : dishes;

    lines.push(
      "BEGIN:VEVENT",
      `UID:${feedName}-${schoolId}-${ymd}@school-lunch`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd}`,
      `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${escapeText(`${eventPrefix} ${title}`)}`,
      `DESCRIPTION:${escapeText(description)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function isCondiment(name) {
  const lower = name.toLowerCase();
  if (CONDIMENTS.has(lower) || GARNISH.test(name)) return true;
  return CONDIMENT_SUFFIX.test(name) && !SERVED_WITH.test(name);
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function escapeText(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")
    .replace(/[\x00-\x1f\x7f]/g, ""); // any remaining control characters would break the line structure
}

// RFC 5545: lines longer than 75 octets are split, continuation lines start with a space.
function fold(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const len = encoder.encode(ch).length;
    const limit = parts.length ? 74 : 75; // continuation lines lose one octet to the leading space
    if (size + len > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += len;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function todayInTZ(timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date()); // YYYY-MM-DD
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mdy(ymd) {
  const [y, m, d] = ymd.split("-");
  return `${m}-${d}-${y}`;
}
