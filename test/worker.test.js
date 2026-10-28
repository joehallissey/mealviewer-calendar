// Runs the Worker against saved API responses (test/fixtures) with the clock fixed, so the output
// is the same on every run. Run with `npm test`. Set UPDATE_GOLDEN=1 to rewrite the .ics snapshots
// after an intended output change, and check the diff before committing them.

import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import worker from "../src/index.js";

const NOW = "2026-10-25T15:00:00Z";
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const json = (name) => JSON.parse(fixture(name));

let requests;
let routes;

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: new Date(NOW) });
  mock.method(console, "error", () => {});
  requests = [];
  routes = [];
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    requests.push(url);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) return new Response("Not found", { status: 404 });
    const body = typeof route[1] === "function" ? route[1](url) : route[1];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

async function get(path, env) {
  const res = await worker.fetch(new Request(`https://cal.example${path}`), env, { waitUntil() {} });
  return { status: res.status, type: res.headers.get("Content-Type"), text: await res.text() };
}

function assertGolden(name, text) {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  if (process.env.UPDATE_GOLDEN) writeFileSync(url, text);
  assert.equal(text, readFileSync(url, "utf8"));
}

function events(ics) {
  return ics.replace(/\r\n /g, "").split("BEGIN:VEVENT").slice(1).map((block) => {
    const field = (name) => block.match(new RegExp(`^${name}[;:](.*)$`, "m"))?.[1].replace(/\r$/, "");
    return { uid: field("UID"), date: field("DTSTART").replace("VALUE=DATE:", ""), summary: field("SUMMARY"), description: field("DESCRIPTION") };
  });
}

function assertValidIcs(ics) {
  assert.ok(ics.endsWith("\r\n"));
  for (const line of ics.split("\r\n").slice(0, -1)) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `line over 75 octets: ${line}`);
  }
  assert.ok(!/[^\r]\n/.test(ics), "bare LF");
}

// MealViewer

const MEALVIEWER = /^https:\/\/api\.mealviewer\.com\/api\/v4\/school\/LincolnES\//;

const mealviewerEnv = {
  SCHOOL_ID: "LincolnES",
  SCHOOL_NAME: "Lincoln",
  TIMEZONE: "America/Denver",
  FEEDS: { lunch: { MEAL: "elementary lunch" }, breakfast: { MEAL: "Breakfast" }, snack: { MEAL: "Afternoon Snack" } },
};

test("MealViewer feeds match the saved output", async () => {
  routes.push([MEALVIEWER, json("mealviewer.json")]);
  for (const feed of ["lunch", "breakfast", "snack"]) {
    const res = await get(`/${feed}.ics`, mealviewerEnv);
    assert.equal(res.status, 200);
    assert.equal(res.type, "text/calendar; charset=utf-8");
    assertValidIcs(res.text);
    assertGolden(`mealviewer-${feed}.ics`, res.text);
  }
  assert.equal(requests[0], "https://api.mealviewer.com/api/v4/school/LincolnES/10-18-2026/11-29-2026/0");
});

test("MealViewer: legacy config without FEEDS serves /lunch.ics", async () => {
  routes.push([MEALVIEWER, json("mealviewer.json")]);
  const res = await get("/lunch.ics", { SCHOOL_ID: "LincolnES", TIMEZONE: "America/Denver", MEAL: "Elementary Lunch" });
  assert.equal(res.status, 200);
  const [first] = events(res.text);
  assert.equal(first.uid, "lunch-LincolnES-20261019@school-lunch");
  assert.equal(first.summary, "🍽 Lunch: Holiday Meal! Roast Turkey");
});

test("MealViewer /menus lists menu names", async () => {
  routes.push([MEALVIEWER, json("mealviewer.json")]);
  const res = await get("/menus", mealviewerEnv);
  assert.equal(res.text, "Menus for LINCOLN ELEMENTARY (LincolnES). Set MEAL to one of these:\n\nAfternoon Snack\nBreakfast\nElementary Lunch\n");
});

test("an upstream failure returns 502", async () => {
  routes.push([MEALVIEWER, new Response("down", { status: 503 })]);
  const res = await get("/lunch.ics", mealviewerEnv);
  assert.equal(res.status, 502);
});

// Config

test("a bad feed reports its own error without breaking the others", async () => {
  routes.push([MEALVIEWER, json("mealviewer.json")]);
  const env = { ...mealviewerEnv, FEEDS: { lunch: { MEAL: "Elementary Lunch" }, broken: { SCHOOL_ID: "YOUR-SCHOOL-ID", MEAL: "Lunch" } } };
  assert.equal((await get("/lunch.ics", env)).status, 200);
  const broken = await get("/broken.ics", env);
  assert.equal(broken.status, 500);
  assert.match(broken.text, /SCHOOL_ID is not set for the "broken" feed/);
});

test("FEEDS mode requires MEAL", async () => {
  const res = await get("/lunch.ics", { SCHOOL_ID: "LincolnES", FEEDS: { lunch: {} } });
  assert.equal(res.status, 500);
  assert.match(res.text, /MEAL is not set for the "lunch" feed/);
});

test("unknown paths are 404", async () => {
  assert.equal((await get("/nope.ics", mealviewerEnv)).status, 404);
  assert.equal((await get("/", mealviewerEnv)).status, 404);
});

// Nutrislice

const NS_SCHOOLS = /^https:\/\/exampleisd\.api\.nutrislice\.com\/menu\/api\/schools\/\?format=json$/;
const NS_WEEKS = /^https:\/\/exampleisd\.api\.nutrislice\.com\/menu\/api\/weeks\/school\/lincoln-elementary\/menu-type\/ele-menu\/(\d{4})\/(\d{2})\/(\d{2})\/\?format=json$/;
const NS_URL = "https://exampleisd.nutrislice.com/menu/lincoln-elementary";

function nutrisliceRoutes() {
  routes.push([NS_SCHOOLS, json("nutrislice-schools.json")]);
  routes.push([NS_WEEKS, (url) => {
    const date = url.match(NS_WEEKS).slice(1).join("-");
    if (date >= "2026-10-25" && date <= "2026-10-31") return json("nutrislice-week.json");
    if (date >= "2026-11-22" && date <= "2026-11-28") return json("nutrislice-holiday-week.json");
    return { days: [] };
  }]);
}

const nutrisliceEnv = {
  SCHOOL_ID: `${NS_URL}/ele-menu/2026-10-26`,
  SCHOOL_NAME: "Lincoln",
  TIMEZONE: "America/Chicago",
  FEEDS: { lunch: { MEAL: "Lunch" } },
};

test("Nutrislice feed matches the saved output", async () => {
  nutrisliceRoutes();
  const res = await get("/lunch.ics", nutrisliceEnv);
  assert.equal(res.status, 200);
  assertValidIcs(res.text);
  assertGolden("nutrislice-lunch.ics", res.text);
});

test("Nutrislice: titles, descriptions, themes and holidays", async () => {
  nutrisliceRoutes();
  const days = events((await get("/lunch.ics", nutrisliceEnv)).text);
  assert.deepEqual(days.map((day) => [day.date, day.summary]), [
    // Untagged main dish with only an alternate tagged: the first dish, minus "served with".
    ["20261026", "🍽 Lincoln Lunch: Chicken Tenders"],
    ["20261027", "🍽 Lincoln Lunch: Penne w/ Beef Meatballs & Marinara"],
    // A short note before the dishes leads the title; a long disclaimer doesn't.
    ["20261028", "🍽 Lincoln Lunch: Early Release Cheeseburger"],
    ["20261029", "🍽 Lincoln Lunch: Turkey Sausage & French Toast"],
    ["20261030", "🍽 Lincoln Lunch: Cheese Pizza Slice / Pepperoni Pizza Slice"],
    // A "main" counts as an entrée; the bread roll stays out of the title. Holiday days have no event.
    ["20261123", "🍽 Lincoln Lunch: Turkey & Gravy"],
  ]);
  assert.equal(days[0].uid, "lunch-exampleisd-lincoln-elementary-20261026@school-lunch");
  // Milk is left out, but not a dish served with milk.
  assert.equal(days[0].description, "Chicken Tenders\\nMac n Cheese\\nVegetarian Option: Mac n Cheese\\nGreen Beans\\nGrapes");
  assert.equal(days[3].description, "Turkey Sausage & French Toast\\nCereal with Milk\\nHashbrown\\nMixed Fruit");
  // Condiments, section titles and station headers are left out; repeated dishes appear once.
  assert.equal(days[1].description, "Penne w/ Beef Meatballs & Marinara\\nVegetarian Option: Penne w/ Marinara\\nGarlic Breadstick\\nApple Slices");
  assert.equal(days[4].description, "Cheese Pizza Slice\\nPepperoni Pizza Slice\\nWatermelon\\nCarrots");
});

test("Nutrislice: fetches each week of the window once", async () => {
  nutrisliceRoutes();
  await get("/lunch.ics", nutrisliceEnv);
  const weeks = requests.filter((url) => NS_WEEKS.test(url)).map((url) => url.match(NS_WEEKS).slice(1).join("-"));
  assert.deepEqual(weeks, ["2026-10-18", "2026-10-25", "2026-11-01", "2026-11-08", "2026-11-15", "2026-11-22", "2026-11-29"]);
});

test("Nutrislice: MEAL matches the menu's name or its code", async () => {
  nutrisliceRoutes();
  for (const meal of ["lunch", "ELE-MENU"]) {
    const res = await get("/lunch.ics", { ...nutrisliceEnv, FEEDS: { lunch: { MEAL: meal } } });
    assert.equal(events(res.text).length, 6, meal);
  }
});

test("Nutrislice: a link that names the menu needs no MEAL in the legacy config", async () => {
  nutrisliceRoutes();
  const res = await get("/lunch.ics", { SCHOOL_ID: `${NS_URL}/ele-menu/2026-10-26`, TIMEZONE: "America/Chicago" });
  assert.equal(res.status, 200);
  assert.equal(events(res.text).length, 6);
  assert.ok(!requests.some((url) => NS_SCHOOLS.test(url)), "no school lookup needed");
  assert.match(res.text, /X-WR-CALNAME:School Lunch/);
});

test("Nutrislice: an unknown MEAL lists the school's menus", async () => {
  nutrisliceRoutes();
  const res = await get("/lunch.ics", { ...nutrisliceEnv, FEEDS: { lunch: { MEAL: "Snack" } } });
  assert.equal(res.status, 500);
  assert.equal(res.text, 'No menu called "Snack" for the "lunch" feed. Set MEAL to one of: Lunch, Breakfast.');
});

test("Nutrislice: a school with no menus listed gives an empty calendar", async () => {
  nutrisliceRoutes();
  const res = await get("/lunch.ics", { ...nutrisliceEnv, SCHOOL_ID: "https://exampleisd.nutrislice.com/menu/summer-camp" });
  assert.equal(res.status, 200);
  assert.equal(events(res.text).length, 0);
});

test("Nutrislice: an unknown school is reported", async () => {
  nutrisliceRoutes();
  const res = await get("/lunch.ics", { ...nutrisliceEnv, SCHOOL_ID: "https://exampleisd.nutrislice.com/menu/nowhere" });
  assert.equal(res.status, 500);
  assert.match(res.text, /no school "nowhere" in the "exampleisd" district/);
});

test("Nutrislice: one failed week fails the whole feed", async () => {
  routes.push([/\/2026\/11\/08\//, new Response("down", { status: 503 })]);
  nutrisliceRoutes();
  const res = await get("/lunch.ics", nutrisliceEnv);
  assert.equal(res.status, 502);
});

test("Nutrislice /menus lists menu names with their codes, alongside MealViewer schools", async () => {
  nutrisliceRoutes();
  routes.push([MEALVIEWER, json("mealviewer.json")]);
  const env = { ...nutrisliceEnv, FEEDS: { lunch: { MEAL: "Lunch" }, breakfast: { MEAL: "Breakfast" }, kid2: { SCHOOL_ID: "LincolnES", MEAL: "Breakfast" } } };
  const res = await get("/menus", env);
  assert.equal(
    res.text,
    "Menus for Lincoln Elementary (exampleisd-lincoln-elementary). Set MEAL to one of these names (or the code in brackets):\n\nLunch (ele-menu)\nBreakfast (breakfast)\n" +
      "\nMenus for LINCOLN ELEMENTARY (LincolnES). Set MEAL to one of these:\n\nAfternoon Snack\nBreakfast\nElementary Lunch\n",
  );
});

test("Nutrislice links are read in any of their usual forms", async () => {
  nutrisliceRoutes();
  for (const link of [
    "https://exampleisd.nutrislice.com/menu/lincoln-elementary/ele-menu",
    "https://ExampleISD.nutrislice.com/menu/lincoln-elementary/ele-menu/2026-10-26/",
    "exampleisd.nutrislice.com/menu/lincoln-elementary/ele-menu?mode=week",
  ]) {
    const res = await get("/lunch.ics", { SCHOOL_ID: link, TIMEZONE: "America/Chicago" });
    assert.equal(events(res.text)[0]?.uid, "lunch-exampleisd-lincoln-elementary-20261026@school-lunch", link);
  }
  // Without the menu type, the legacy config falls back to the "Lunch" menu.
  const res = await get("/lunch.ics", { SCHOOL_ID: `${NS_URL}/2026-10-26`, TIMEZONE: "America/Chicago" });
  assert.equal(events(res.text).length, 6);
});

test("a Nutrislice link that isn't a school's menu is a setup error", async () => {
  const res = await get("/lunch.ics", { SCHOOL_ID: "https://exampleisd.nutrislice.com/", TIMEZONE: "America/Chicago" });
  assert.equal(res.status, 500);
  assert.match(res.text, /looks like a Nutrislice link, but not a school's menu page/);
});
