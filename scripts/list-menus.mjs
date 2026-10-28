// Lists the menu names a school has on MealViewer or Nutrislice.
// Usage: npm run menus -- <MealViewer school ID or URL, or Nutrislice menu URL>

const input = (process.argv[2] ?? "").trim();

// Upstream text goes to the terminal, so strip control characters (e.g. ANSI escapes) first.
const clean = (value) => String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();

const nutrislice = input.match(/^(?:https?:\/\/)?([a-z0-9-]+)\.nutrislice\.com\/menu\/([a-z0-9-]+)(?:[/?#]|$)/i);
if (nutrislice) {
  await listNutrislice(nutrislice[1].toLowerCase(), nutrislice[2].toLowerCase());
} else {
  await listMealViewer(input.replace(/\/+$/, "").split("/").pop());
}

async function listMealViewer(schoolId) {
  if (!/^[A-Za-z0-9-]+$/.test(schoolId)) {
    console.error("Usage: npm run menus -- <MealViewer school ID or URL, or Nutrislice menu URL>");
    console.error("Example: npm run menus -- https://schools.mealviewer.com/school/LincolnES");
    console.error("Example: npm run menus -- https://lincolnisd.nutrislice.com/menu/lincoln-elementary");
    process.exit(1);
  }

  const mdy = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}`;
  const start = new Date();
  const end = new Date(start.getTime() + 35 * 24 * 60 * 60 * 1000);
  const api = `https://api.mealviewer.com/api/v4/school/${encodeURIComponent(schoolId)}/${mdy(start)}/${mdy(end)}/0`;

  const res = await fetch(api, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    console.error(`MealViewer returned ${res.status}. Check the school ID: ${schoolId}`);
    process.exit(1);
  }
  const data = await res.json();

  const names = new Set();
  for (const schedule of data.menuSchedules ?? []) {
    for (const block of schedule.menuBlocks ?? []) {
      const name = clean(block.blockName);
      if (name) names.add(name);
    }
  }

  const school = clean(data.physicalLocation?.name) || null;
  if (!names.size) {
    console.log(`No menus posted for ${school ?? schoolId} in the next 5 weeks. Check the ID, or try again once the school posts its menu.`);
  } else {
    console.log(`Menus for ${school ?? schoolId} (${schoolId}). Use one of these as MEAL:\n`);
    for (const name of [...names].sort()) console.log(`  ${name}`);
  }
}

async function listNutrislice(district, slug) {
  const api = `https://${district}.api.nutrislice.com/menu/api/schools/?format=json`;
  const res = await fetch(api, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    console.error(`Nutrislice returned ${res.status}. Check the link's district: ${district}`);
    process.exit(1);
  }
  const schools = await res.json();
  const school = Array.isArray(schools) && schools.find((s) => String(s?.slug ?? "").toLowerCase() === slug);
  if (!school) {
    console.error(`Nutrislice has no school "${slug}" in the "${district}" district. Open the school's menu on Nutrislice and copy that link.`);
    process.exit(1);
  }

  const name = clean(school.name) || slug;
  const menus = (school.active_menu_types ?? []).map((type) => [clean(type?.name), clean(type?.slug)]).filter(([, code]) => code);
  if (!menus.length) {
    console.log(`No menus listed for ${name}. Try again once the school posts its menu.`);
  } else {
    console.log(`Menus for ${name} (${district}/${slug}). Use one of these names (or the code in brackets) as MEAL:\n`);
    for (const [menuName, code] of menus) console.log(`  ${menuName || code} (${code})`);
  }
}
