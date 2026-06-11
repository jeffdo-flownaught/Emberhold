import React, { useState, useEffect, useRef, useCallback } from "react";

/* ============ EMBERHOLD v10 — playable prototype ============
   New in v10:
   • Sever reduced to 3× damage; Quickdraw reduced to 3s.
   • Thornwild attack speed up: spd 13 (0.52 attacks/sec).
   • Map guarantees ≥1 waygate besides the converge gate and
     ≥1 shrine (relic) — enforced after the 60%-combat pass.
   • Legend documents waygate healing (30%) & revival (20%).
   Carried from v6: two regions (Forgotten Marshland → Ogre
   Forest), descent modifiers, attack-speed gauges, Taunt,
   Fenwick (Ranger — hero haste), Thornwild (Druid — enemy
   slow), party selection, boss-only equipment.
============================================================ */

const FONT = `@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700;900&family=Alegreya+Sans:wght@400;500;700&display=swap');`;

/* persistent save (localStorage) — survives the run/battle state isn't saved,
   only your Hold progression: resources, building levels, runs done, the
   Ogre Forest unlock, items collected, equipped items, and the chosen party. */
const SAVE_KEY = "emberhold-save-v1";
const loadSave = () => {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
};
const usePersistent = (key, initial) => {
  const saved = loadSave();
  const [v, setV] = useState(saved && saved[key] !== undefined ? saved[key] : initial);
  useEffect(() => {
    try {
      const prev = loadSave() || {};
      localStorage.setItem(SAVE_KEY, JSON.stringify({ ...prev, [key]: v }));
    } catch {}
  }, [key, v]);
  return [v, setV];
};
const clearSave = () => { try { localStorage.removeItem(SAVE_KEY); } catch {} };

const C = {
  bg: "#16121f", panel: "#211a2e", panel2: "#2a2138",
  ember: "#f08c3a", gold: "#e3b85c", umbral: "#43c5b2",
  text: "#e9dfc8", dim: "#9a8fa8", red: "#e2604f", green: "#7fc36b", blue: "#6aa7e8",
};

const TICK_MS = 250;            // engine tick
const ENEMY_HP_MUL = 3;
const ULT_PER_ATTACK = 20;      // ult charge gained per attack swing
const COLS = 8;                 // encounter columns; +converge waygate +boss = 10 depths

/* ---------- heroes (6) ---------- */
const HERO_DEFS = [
  { id: "bran", name: "Branwen", cls: "Vanguard", icon: "🛡️", baseHp: 130, atk: 10, def: 12, matk: 4, mdef: 10, crit: 5, eva: 5, acc: 90, spd: 10, ultName: "Taunt", ultDesc: "Enemies attack Branwen for 2s; his defenses are doubled" },
  { id: "kael", name: "Kaelis", cls: "Blade", icon: "⚔️", baseHp: 85, atk: 18, def: 6, matk: 4, mdef: 5, crit: 20, eva: 12, acc: 95, spd: 16, ultName: "Sever", ultDesc: "Strike focused enemy 3× damage" },
  { id: "syra", name: "Syrene", cls: "Pyromancer", icon: "🔥", baseHp: 70, atk: 6, def: 4, matk: 16, mdef: 12, crit: 12, eva: 8, acc: 92, spd: 12, ultName: "Cinder Nova", ultDesc: "Magic damage to ALL enemies" },
  { id: "prie", name: "Liora", cls: "Priest", icon: "🙏", baseHp: 75, atk: 5, def: 5, matk: 12, mdef: 14, crit: 5, eva: 8, acc: 92, spd: 11, ultName: "Sanctuary", ultDesc: "Heal the party 15 HP" },
  { id: "rang", name: "Fenwick", cls: "Ranger", icon: "🏹", baseHp: 80, atk: 14, def: 5, matk: 3, mdef: 6, crit: 15, eva: 14, acc: 97, spd: 18, ultName: "Quickdraw", ultDesc: "Fenwick gains +60% attack speed for 3s" },
  { id: "drui", name: "Thornwild", cls: "Druid", icon: "🌿", baseHp: 90, atk: 8, def: 8, matk: 12, mdef: 10, crit: 8, eva: 8, acc: 90, spd: 13, ultName: "Entangle", ultDesc: "-50% attack speed on the focused enemy for 4s" },
];

/* ---------- enemies ---------- */
const E = (name, icon, hp, atk, def, matk, mdef, crit, eva, acc, spd) => ({ name, icon, hp, atk, def, matk, mdef, crit, eva, acc, spd });

/* ---------- regions: ≥10 basics, 3 elites, 1 boss, 6 relics, 6 events each ---------- */
const REGIONS = {
  marsh: {
    id: "marsh", name: "The Forgotten Marshland", emoji: "🌫️",
    basics: [
      E("Mire Thrall", "👤", 50, 6, 4, 2, 3, 5, 5, 85, 10),
      E("Bog Hound", "🐺", 38, 8, 2, 0, 2, 12, 15, 90, 14),
      E("Hollow Shade", "👻", 60, 3, 3, 8, 10, 8, 10, 88, 10),
      E("Marsh Leech", "🪱", 45, 7, 3, 1, 4, 5, 5, 86, 12),
      E("Fen Witch", "🧙", 55, 3, 3, 9, 11, 10, 8, 90, 9),
      E("Rot Crawler", "🦂", 48, 7, 5, 1, 3, 8, 6, 87, 11),
      E("Drowned One", "🧟", 70, 8, 6, 2, 5, 4, 3, 84, 8),
      E("Will-o-Gloom", "💡", 35, 2, 2, 9, 8, 10, 20, 92, 12),
      E("Reed Stalker", "🦗", 42, 9, 3, 1, 3, 14, 12, 91, 13),
      E("Mud Golem", "🗿", 85, 7, 10, 1, 6, 3, 2, 82, 7),
    ],
    elites: [
      E("Blightbrute", "👹", 110, 11, 8, 2, 4, 8, 3, 85, 9),
      E("Marsh Hag", "🧌", 95, 4, 5, 12, 11, 10, 8, 90, 10),
      E("Bog Serpent", "🐍", 100, 12, 5, 2, 5, 15, 10, 92, 12),
    ],
    boss: E("Herald of Gloaming", "💀", 240, 12, 8, 10, 8, 12, 6, 92, 9),
    relics: [
      { id: "fang", name: "Ashen Fang", icon: "🗡️", desc: "+25% hero attack", mod: { atkPct: 25 } },
      { id: "idol", name: "Warding Idol", icon: "🗿", desc: "Enemies deal -15% damage", mod: { enemyAtkPct: -15 } },
      { id: "chalice", name: "Ember Chalice", icon: "🏆", desc: "+30 HP heal after each fight", mod: { healAfterFight: 30 } },
      { id: "hourglass", name: "Hourglass of Sol", icon: "⏳", desc: "Ultimates charge 40% faster", mod: { ultPct: 40 } },
      { id: "coinpurse", name: "Bottomless Purse", icon: "💰", desc: "+50% gold from fights", mod: { goldPct: 50 } },
      { id: "phoenix", name: "Phoenix Feather", icon: "🪶", desc: "First fallen hero revives at 30%", mod: { phoenix: 1 } },
    ],
    events: [
      { text: "A wounded pilgrim begs for coin. Her eyes glint strangely in the gloom.", a: { label: "Give 20 gold", needGold: 20, fn: s => ({ ...s, gold: s.gold - 20, atkMod: s.atkMod + 0.1, blessing: "She whispers a war-blessing: +10% attack this run." }) }, b: { label: "Walk past", fn: s => ({ ...s, blessing: "You walk past. Her eyes follow you into the dark. Nothing happens." }) } },
      { text: "A shrine of the old Worldflame flickers above the black water.", a: { label: "Touch the flame", fn: s => Math.random() > 0.4 ? { ...s, atkMod: s.atkMod + 0.2, blessing: "The flame accepts you! +20% attack this run." } : { ...s, teamDmg: 20, blessing: "The flame rejects you. Burned: the party loses 20 HP." } }, b: { label: "Bow and leave", fn: s => ({ ...s, gold: s.gold + 15, blessing: "You bow and find a 15 gold offering at the shrine's base." }) } },
      { text: "An abandoned supply cart sits half-swallowed by marsh roots.", a: { label: "Loot it quickly", fn: s => ({ ...s, wood: s.wood + 30, blessing: "You grab what you can: +30 wood salvaged." }) }, b: { label: "Search thoroughly (risky)", fn: s => Math.random() > 0.5 ? { ...s, wood: s.wood + 30, embers: s.embers + 3, blessing: "Hidden compartment! +30 wood and +3 embers!" } : { ...s, teamDmg: 25, blessing: "Bog hounds were waiting. Ambushed: -25 HP to the party." } } },
      { text: "A drowned chest glimmers beneath the black water.", a: { label: "Dive for it", fn: s => Math.random() > 0.5 ? { ...s, gold: s.gold + 60, blessing: "You wrench it free: +60 gold!" } : { ...s, teamDmg: 20, blessing: "Something pulls back. You escape, but the party loses 20 HP." } }, b: { label: "Leave it", fn: s => ({ ...s, blessing: "Some treasures are bait. You move on, unharmed." }) } },
      { text: "A fen witch offers a bubbling draught from her hut on stilts.", a: { label: "Drink it", fn: s => Math.random() > 0.5 ? { ...s, teamHeal: 40, blessing: "Warmth floods your veins: the party heals 40 HP." } : { ...s, teamDmg: 15, blessing: "It was swamp bile. The party loses 15 HP." } }, b: { label: "Refuse politely", fn: s => ({ ...s, blessing: "She cackles and waves you off. Nothing happens." }) } },
      { text: "Ghost-lights beckon you off the safe path.", a: { label: "Follow the lights", fn: s => Math.random() > 0.5 ? { ...s, embers: s.embers + 3, blessing: "They lead you to a dying flame shard: +3 embers!" } : { ...s, teamDmg: 15, blessing: "A trick of the mire. You stumble through thorns: -15 HP." } }, b: { label: "Stay on the path", fn: s => ({ ...s, gold: s.gold + 10, blessing: "You keep your footing and find a traveler's lost purse: +10 gold." }) } },
    ],
  },
  forest: {
    id: "forest", name: "The Ogre Forest", emoji: "🌲",
    basics: [
      E("Ogre Whelp", "👺", 70, 9, 6, 1, 4, 6, 4, 85, 9),
      E("Timber Wolf", "🐺", 55, 11, 3, 0, 3, 14, 14, 91, 15),
      E("Thorn Sprite", "🧚", 45, 3, 3, 11, 9, 10, 16, 92, 12),
      E("Bark Fiend", "🪵", 80, 9, 9, 2, 6, 5, 4, 84, 8),
      E("Ogre Grunt", "🪓", 90, 11, 7, 1, 5, 7, 3, 85, 9),
      E("Forest Wraith", "👻", 60, 3, 4, 12, 11, 9, 12, 90, 10),
      E("Bramble Beast", "🦔", 75, 10, 7, 2, 5, 8, 6, 86, 10),
      E("Ogre Shaman", "🪄", 65, 4, 4, 13, 12, 10, 7, 91, 9),
      E("Dire Boar", "🐗", 85, 12, 6, 0, 4, 10, 5, 87, 11),
      E("Moss Troll", "🧌", 110, 10, 11, 2, 7, 4, 2, 82, 7),
    ],
    elites: [
      E("Ogre Brute", "👹", 150, 14, 10, 2, 6, 9, 3, 86, 9),
      E("Elder Treant", "🌳", 140, 8, 9, 14, 12, 8, 4, 88, 8),
      E("Twin-Head Ogre", "👬", 160, 13, 8, 3, 5, 10, 4, 85, 10),
    ],
    boss: E("The Ogre King", "👑", 300, 15, 10, 4, 7, 12, 4, 90, 9),
    relics: [
      { id: "wolfsblood", name: "Wolfsblood Vial", icon: "🧪", desc: "Heroes +20% attack speed", mod: { spdPct: 20 } },
      { id: "ironbark", name: "Ironbark Hide", icon: "🛡️", desc: "Heroes +4 defense", mod: { defFlat: 4 } },
      { id: "tanglecharm", name: "Tanglevine Charm", icon: "🌿", desc: "Enemies 15% slower", mod: { enemySpdPct: -15 } },
      { id: "hunterseye", name: "Hunter's Eye", icon: "🎯", desc: "Heroes +8 accuracy", mod: { accFlat: 8 } },
      { id: "luckyacorn", name: "Lucky Acorn", icon: "🌰", desc: "+30% gold from fights", mod: { goldPct: 30 } },
      { id: "mossheart", name: "Moss Heart", icon: "💚", desc: "+40 HP heal after each fight", mod: { healAfterFight: 40 } },
    ],
    events: [
      { text: "An ogre cookpot bubbles unattended over a great fire.", a: { label: "Steal the stew", fn: s => Math.random() > 0.4 ? { ...s, teamHeal: 30, blessing: "Hearty and hot! The party heals 30 HP." } : { ...s, teamDmg: 20, blessing: "The cook returns mid-bite. You flee with bruises: -20 HP." } }, b: { label: "Tip it over and run", fn: s => ({ ...s, blessing: "Distant roars of ogre fury echo behind you. Worth it." }) } },
      { text: "A wounded wolf pup whimpers in a snare.", a: { label: "Free and tend it (10 gold)", needGold: 10, fn: s => ({ ...s, gold: s.gold - 10, atkMod: s.atkMod + 0.1, blessing: "The pack watches from the shadows, then howls. Pack-blessed: +10% attack." }) }, b: { label: "Leave it", fn: s => ({ ...s, blessing: "Its cries fade behind you. The forest remembers." }) } },
      { text: "An elder treant blocks the path with a riddle.", a: { label: "Answer the riddle", fn: s => Math.random() > 0.4 ? { ...s, embers: s.embers + 4, blessing: "Correct! Its bark splits to reveal +4 embers." } : { ...s, teamDmg: 10, blessing: "Wrong. A branch swats the party: -10 HP." } }, b: { label: "Go around (slow)", fn: s => ({ ...s, wood: s.wood + 10, blessing: "You gather fallen branches on the detour: +10 wood." }) } },
      { text: "Ogres have built a toll bridge over a ravine.", a: { label: "Pay the toll (30 gold)", needGold: 30, fn: s => ({ ...s, gold: s.gold - 30, blessing: "The ogres grunt and let you pass unharmed." }) }, b: { label: "Fight through", fn: s => ({ ...s, teamDmg: 20, gold: s.gold + 20, blessing: "You batter through and loot their toll box: -20 HP, +20 gold." }) } },
      { text: "Golden acorns gleam on a high branch.", a: { label: "Climb for them", fn: s => Math.random() > 0.5 ? { ...s, gold: s.gold + 50, blessing: "A pouch's worth! +50 gold." } : { ...s, teamDmg: 15, blessing: "The branch snaps. -15 HP and wounded pride." } }, b: { label: "Shake the trunk", fn: s => ({ ...s, gold: s.gold + 10, blessing: "A few drop loose: +10 gold." }) } },
      { text: "You find an old hunter's cache beneath a hollow log.", a: { label: "Take the supplies", fn: s => ({ ...s, wood: s.wood + 40, blessing: "Dry timber and rope: +40 wood." }) }, b: { label: "Dig deeper (risky)", fn: s => Math.random() > 0.5 ? { ...s, wood: s.wood + 40, embers: s.embers + 3, blessing: "A buried flame shard! +40 wood, +3 embers." } : { ...s, teamDmg: 15, blessing: "A spring-trap snaps shut: -15 HP." } } },
    ],
  },
};

/* random modifier applied to all enemy encounters after descending deeper */
const DESCENT_MODS = [
  { id: "frenzy", name: "Frenzied Umbral", desc: "Enemies attack 25% faster", mod: { enemySpdPct2: 25 } },
  { id: "hardened", name: "Hardened Hides", desc: "Enemies have +30% HP", mod: { enemyHpPct: 30 } },
  { id: "savage", name: "Savage Hunger", desc: "Enemies deal +20% damage", mod: { enemyAtkPct2: 20 } },
  { id: "mists", name: "Cloying Mists", desc: "Heroes lose 8 accuracy", mod: { heroAccFlat: -8 } },
];

/* equipment — drops ONLY from bosses */
const ITEMS = [
  { id: "blade", name: "Heraldbane Blade", icon: "🗡️", desc: "+6 Attack", mod: { atk: 6 } },
  { id: "aegis", name: "Gloamward Aegis", icon: "🛡️", desc: "+5 Defense, +5 Magic Def", mod: { def: 5, mdef: 5 } },
  { id: "amulet", name: "Emberheart Amulet", icon: "📿", desc: "+30 Max HP", mod: { hp: 30 } },
  { id: "eye", name: "Eye of the Worldflame", icon: "🔮", desc: "+8 Magic Attack", mod: { matk: 8 } },
  { id: "boots", name: "Boots of the Wisp", icon: "🥾", desc: "+10 Evasion", mod: { eva: 10 } },
  { id: "sigil", name: "Sigil of Precision", icon: "🎯", desc: "+8 Accuracy, +8 Critical", mod: { acc: 8, crit: 8 } },
  { id: "band", name: "Quicksilver Band", icon: "💍", desc: "+4 Attack Speed", mod: { spd: 4 } },
];

/* ---------- helpers ---------- */
const rnd = a => a[Math.floor(Math.random() * a.length)];
const shuffle = a => [...a].sort(() => Math.random() - 0.5);
const aggRelics = relics => relics.reduce((a, r) => { for (const k in r.mod) a[k] = (a[k] || 0) + r.mod[k]; return a; }, {});

function makeRunGrid() {
  const grid = Array.from({ length: 3 }, () => Array(COLS).fill("fight"));
  const gapCols = shuffle(Array.from({ length: COLS - 1 }, (_, i) => i + 1)).slice(0, 3);
  shuffle([0, 1, 2]).forEach((row, i) => { if (Math.random() < 0.75) grid[row][gapCols[i]] = null; });
  const [shrineCol, eventCol] = shuffle([1, 2, 3, 4, 5, 6]).slice(0, 2);
  for (let r = 0; r < 3; r++) {
    if (grid[r][shrineCol]) grid[r][shrineCol] = "shrine";
    if (grid[r][eventCol]) grid[r][eventCol] = "event";
  }
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 1; c < COLS; c++) if (grid[r][c] === "fight") cells.push({ r, c });
  const usedCols = new Set();
  shuffle(cells).forEach(({ r, c }) => {
    if (usedCols.size < 3 && !usedCols.has(c)) { grid[r][c] = "waygate"; usedCols.add(c); }
  });
  /* sprinkle variety — shrines may never appear in adjacent columns, so two
     relic picks can never happen back to back */
  const shrineCols = new Set([shrineCol]);
  for (let r = 0; r < 3; r++) for (let c = 0; c < COLS; c++) {
    if (grid[r][c] !== "fight") continue;
    const roll = Math.random();
    if (c >= 4 && roll < 0.3) grid[r][c] = "elite";
    else if (roll < 0.42 && c > 0) {
      const wantShrine = Math.random() < 0.5;
      const shrineOk = !shrineCols.has(c - 1) && !shrineCols.has(c + 1);
      if (wantShrine && shrineOk) { grid[r][c] = "shrine"; shrineCols.add(c); }
      else grid[r][c] = "event";
    }
  }

  /* enforce: ≥60% of encounters are fights or elites.
     Counting all encounters incl. the converge waygate and boss.
     Convert sprinkled shrines/events first (never the guaranteed
     shrine/event columns), then surplus waygates (keep ≥1). */
  const isCombat = t => t === "fight" || t === "elite";
  const count = () => {
    let combat = 1, total = 2; // boss (combat) + converge waygate (non-combat)
    for (let r = 0; r < 3; r++) for (let c = 0; c < COLS; c++) {
      if (!grid[r][c]) continue;
      total++; if (isCombat(grid[r][c])) combat++;
    }
    return { combat, total };
  };
  const convertibles = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < COLS; c++) {
    const t = grid[r][c];
    if ((t === "shrine" || t === "event") && c !== shrineCol && c !== eventCol) convertibles.push({ r, c });
  }
  const waygates = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] === "waygate") waygates.push({ r, c });
  const pool = [...shuffle(convertibles), ...shuffle(waygates).slice(0, Math.max(0, waygates.length - 1))];
  let { combat, total } = count();
  while (combat / total < 0.6 && pool.length) {
    const { r, c } = pool.shift();
    grid[r][c] = "fight";
    combat++;
  }

  /* hard guarantees (defensive — structurally these always hold):
     ≥1 waygate on the map besides the converge gate, and ≥1 shrine */
  const has = type => grid.some(row => row.some(t => t === type));
  if (!has("waygate")) {
    outer: for (const c of shuffle(Array.from({ length: COLS - 1 }, (_, i) => i + 1))) {
      for (const r of shuffle([0, 1, 2])) {
        if (grid[r][c] === "fight" && c !== shrineCol && c !== eventCol) { grid[r][c] = "waygate"; break outer; }
      }
    }
  }
  if (!has("shrine")) {
    for (const r of [0, 1, 2]) if (grid[r][shrineCol]) { grid[r][shrineCol] = "shrine"; break; }
  }
  return grid;
}

function makeEnemies(regionId, type, depth, modifier) {
  const reg = REGIONS[regionId];
  /* base depth scaling, then a random ~2% compounding bump per depth
     (each depth multiplies difficulty by 1.01–1.03, centered on 2%) */
  let scale = 1 + depth * 0.15;
  for (let d = 0; d < depth; d++) scale *= 1 + 0.02 * (0.5 + Math.random());
  /* descent modifiers multiply the fully depth-scaled stats */
  const hpMod = 1 + ((modifier?.mod.enemyHpPct || 0) / 100);
  const atkMod = 1 + ((modifier?.mod.enemyAtkPct2 || 0) / 100);
  const mk = base => {
    const hp = Math.round(base.hp * ENEMY_HP_MUL * scale * hpMod);
    return {
      ...base, key: base.name + Math.random().toString(36).slice(2),
      hp, maxHp: hp, gauge: 0,
      atk: Math.round(base.atk * scale * atkMod), matk: Math.round(base.matk * scale * atkMod),
      def: Math.round(base.def * scale), mdef: Math.round(base.mdef * scale),
    };
  };
  if (type === "boss") return [mk(reg.boss)];
  if (type === "elite") return [mk(rnd(reg.elites)), mk(rnd(reg.basics))];
  const n = depth < 3 ? 2 : 3;
  return Array.from({ length: n }, () => mk(rnd(reg.basics)));
}

function rollHit(attacker, defender) {
  const chance = Math.min(0.98, Math.max(0.5, (attacker.acc - defender.eva) / 100));
  return Math.random() < chance;
}
function rollDamage(attacker, defender, powerMul = 1) {
  const magic = attacker.matk > attacker.atk;
  const pow = magic ? attacker.matk : attacker.atk;
  const mit = magic ? defender.mdef : defender.def;
  let dmg = Math.max(1, Math.round(pow * powerMul - mit * 0.35));
  const crit = Math.random() * 100 < attacker.crit;
  if (crit) dmg = Math.round(dmg * 1.5);
  return { dmg, crit, magic };
}

/* ---------- UI atoms ---------- */
const Bar = ({ val, max, color, h = 8 }) => (
  <div style={{ background: "#0d0a14", borderRadius: 4, height: h, overflow: "hidden" }}>
    <div style={{ width: `${Math.max(0, Math.min(100, (val / max) * 100))}%`, height: "100%", background: color, transition: "width .15s linear" }} />
  </div>
);

const Btn = ({ children, onClick, disabled, color = C.ember, full, small }) => (
  <button onClick={onClick} disabled={disabled} style={{
    background: disabled ? "#3a3346" : color, color: disabled ? "#766d85" : "#1a1020",
    border: "none", borderRadius: 10, padding: small ? "8px 12px" : "13px 18px",
    fontFamily: "'Alegreya Sans',sans-serif", fontWeight: 700, fontSize: small ? 13 : 15,
    width: full ? "100%" : "auto", cursor: disabled ? "default" : "pointer",
  }}>{children}</button>
);

const Res = ({ res }) => (
  <div style={{ display: "flex", gap: 14, fontSize: 14, fontWeight: 700 }}>
    <span style={{ color: C.gold }}>🪙 {res.gold}</span>
    <span style={{ color: "#b08968" }}>🪵 {res.wood}</span>
    <span style={{ color: C.ember }}>✨ {res.embers}</span>
  </div>
);

const STAT_ROWS = [
  ["HP", u => `${u.hp ?? u.maxHp}/${u.maxHp}`],
  ["Attack", u => u.atk],
  ["Defense", u => u.def],
  ["Magic Atk", u => u.matk],
  ["Magic Def", u => u.mdef],
  ["Atk Speed", u => u.spd],
  ["Critical", u => `${u.crit}%`],
  ["Evasion", u => `${u.eva}%`],
  ["Accuracy", u => `${u.acc}%`],
];

function StatCard({ unit, idKey, pinned, setPinned, hovered, setHovered, children, style, onClick, dir = "up", clickOnly = false }) {
  const show = pinned === idKey || (!clickOnly && hovered === idKey);
  const place = dir === "down" ? { top: "calc(100% + 6px)" } : { bottom: "calc(100% + 6px)" };
  return (
    <div onClick={onClick} style={{ position: "relative", ...style }}>
      {children}
      <div
        onMouseEnter={() => { if (!clickOnly) setHovered(idKey); }}
        onMouseLeave={() => { if (!clickOnly) setHovered(h => (h === idKey ? null : h)); }}
        onClick={e => { e.stopPropagation(); setPinned(p => (p === idKey ? null : idKey)); }}
        style={{ position: "absolute", top: 2, right: 4, fontSize: 13, color: show ? C.gold : C.dim, cursor: "pointer", padding: "2px 4px", lineHeight: 1 }}
        title="Show stats"
      >ⓘ</div>
      {show && (
        <div style={{
          position: "absolute", ...place, left: "50%", transform: "translateX(-50%)",
          background: "#0d0a14", border: `1px solid ${C.gold}66`, borderRadius: 10, padding: "10px 12px",
          zIndex: 50, width: 150, boxShadow: "0 6px 18px #000a", pointerEvents: "none",
        }}>
          <div style={{ fontFamily: "'Cinzel',serif", fontWeight: 700, fontSize: 12, color: C.gold, marginBottom: 6, textAlign: "center" }}>{unit.name}</div>
          {STAT_ROWS.map(([label, fn]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.text, lineHeight: 1.7 }}>
              <span style={{ color: C.dim }}>{label}</span><span>{fn(unit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================= MAIN ================= */
export default function Emberhold() {
  /* persistent (saved to localStorage) */
  const [screen, setScreen] = useState("base");
  const [res, setRes] = usePersistent("res", { gold: 100, wood: 60, embers: 4 });
  const [bld, setBld] = usePersistent("bld", { forge: 1, barracks: 1, arcanum: 1, shard: 1 });
  const [runsDone, setRunsDone] = usePersistent("runsDone", 0);
  const [forestUnlocked, setForestUnlocked] = usePersistent("forestUnlocked", false);
  const [items, setItems] = usePersistent("items", []);
  const [equips, setEquips] = usePersistent("equips", {});
  const [party, setParty] = usePersistent("party", ["bran", "kael", "syra"]);
  const [equipPicker, setEquipPicker] = useState(null);

  /* run state */
  const [run, setRun] = useState(null);
  const [battle, setBattle] = useState(null);
  const [pendingRelics, setPendingRelics] = useState(null);
  const [eventCard, setEventCard] = useState(null);
  const [eventResult, setEventResult] = useState(null);
  const [summary, setSummary] = useState(null);
  const [floats, setFloats] = useState([]);
  const [legendOpen, setLegendOpen] = useState(true);
  const [pinned, setPinned] = useState(null);
  const [hovered, setHovered] = useState(null);

  const BUILDINGS = [
    { id: "forge", name: "Forge", icon: "⚒️", desc: "+12% hero attack & magic attack / depth", cost: l => ({ gold: 60 * l, wood: 30 * l }) },
    { id: "barracks", name: "Barracks", icon: "🏰", desc: "+15% hero HP / depth", cost: l => ({ gold: 50 * l, wood: 40 * l }) },
    { id: "arcanum", name: "Arcanum", icon: "🔮", desc: "+8% ult charge speed / depth", cost: l => ({ gold: 80 * l, embers: 2 * l }) },
    { id: "shard", name: "Worldflame Shard", icon: "🔥", desc: "+10% all loot / depth", cost: l => ({ embers: 4 * l, wood: 50 * l }) },
  ];

  const heroStats = useCallback(() => HERO_DEFS.map(h => {
    const uid = equips[h.id];
    const inst = items.find(it => it.uid === uid);
    const def = inst ? ITEMS.find(d => d.id === inst.id) : null;
    const m = def ? def.mod : {};
    return {
      ...h,
      maxHp: Math.round(h.baseHp * (1 + 0.15 * (bld.barracks - 1))) + (m.hp || 0),
      atk: Math.round(h.atk * (1 + 0.12 * (bld.forge - 1))) + (m.atk || 0),
      matk: Math.round(h.matk * (1 + 0.12 * (bld.forge - 1))) + (m.matk || 0),
      def: h.def + (m.def || 0), mdef: h.mdef + (m.mdef || 0),
      crit: h.crit + (m.crit || 0), eva: h.eva + (m.eva || 0), acc: h.acc + (m.acc || 0),
      spd: h.spd + (m.spd || 0),
      item: def ? { ...def, uid } : null,
    };
  }), [bld, items, equips]);

  const addFloat = (text, color) => {
    const id = Math.random();
    setFloats(f => [...f.slice(-5), { id, text, color, x: 20 + Math.random() * 60 }]);
    setTimeout(() => setFloats(f => f.filter(x => x.id !== id)), 1200);
  };

  /* ----- start a run ----- */
  const startRun = () => {
    if (party.length !== 3) return;
    const heroes = heroStats().filter(h => party.includes(h.id)).map(h => ({ ...h, hp: h.maxHp, ult: 0, gauge: 0, alive: true }));
    setRun({
      regionId: "marsh", modifier: null, drops: [],
      grid: makeRunGrid(), pos: null, visited: [],
      heroes, gold: 0, wood: 0, embers: 0, relics: [], atkMod: 0, phoenixUsed: false,
    });
    setScreen("map");
  };

  const depthOf = r => (r.pos ? (r.pos.boss ? COLS + 1 : r.pos.converge ? COLS : r.pos.col) : -1);

  const candidatesOf = r => {
    if (!r.pos) return [0, 1, 2].filter(row => r.grid[row][0]).map(row => ({ row, col: 0 }));
    if (r.pos.boss) return [];
    if (r.pos.converge) return [{ boss: true }];
    if (r.pos.col === COLS - 1) return [{ converge: true }];
    return [r.pos.row - 1, r.pos.row, r.pos.row + 1]
      .filter(row => row >= 0 && row < 3 && r.grid[row][r.pos.col + 1])
      .map(row => ({ row, col: r.pos.col + 1 }));
  };

  const chooseNode = cand => {
    setPinned(null);
    const r = runRef.current;
    const type = cand.boss ? "boss" : cand.converge ? "waygate" : r.grid[cand.row][cand.col];
    /* backup guard: never allow a relic pick immediately after a relic pick */
    if (type === "shrine" && r.lastType === "shrine") return;
    const visited = r.pos && !r.pos.boss && !r.pos.converge ? [...r.visited, `${r.pos.row}-${r.pos.col}`] : r.visited;
    const r2 = { ...r, pos: cand, visited, lastType: type };
    setRun(r2);
    const depth = cand.boss ? COLS + 1 : cand.converge ? COLS : cand.col;

    if (type === "fight" || type === "elite" || type === "boss") {
      const enemies = makeEnemies(r2.regionId, type, depth, r2.modifier);
      setBattle({ enemies, type, log: ["The enemy blocks your path. Steel yourselves..."], focus: enemies[0].key, surge: null, tick: 0, started: false, tauntUntil: 0, hasteUntil: 0, slowUntil: 0, slowedKey: null });
      setScreen("battle");
    } else if (type === "shrine") {
      const pool = REGIONS[r2.regionId].relics.filter(x => !r2.relics.find(y => y.id === x.id));
      const opts = [];
      while (opts.length < Math.min(2, pool.length)) { const x = rnd(pool); if (!opts.includes(x)) opts.push(x); }
      setPendingRelics(opts); setScreen("relic");
    } else if (type === "event") {
      setEventCard(rnd(REGIONS[r2.regionId].events)); setScreen("event");
    } else if (type === "waygate") {
      /* the gate's light mends the party: living heal 30% max HP,
         the fallen are revived at 20% max HP */
      const heroes = r2.heroes.map(h => h.alive
        ? { ...h, hp: Math.min(h.maxHp, h.hp + Math.round(h.maxHp * 0.3)) }
        : { ...h, alive: true, hp: Math.max(1, Math.round(h.maxHp * 0.2)), gauge: 0 });
      setRun({ ...r2, heroes });
      setScreen("waygate");
    }
  };

  const backToMap = (r = runRef.current) => {
    setRun(r);
    setScreen("map");
  };

  /* ----- battle engine: attack-speed gauges ----- */
  const battleRef = useRef(); battleRef.current = battle;
  const runRef = useRef(); runRef.current = run;

  useEffect(() => {
    if (screen !== "battle" || !battle || !battle.started) return;

    const iv = setInterval(() => {
      const b = battleRef.current, r = runRef.current;
      if (!b || !r || !b.started) return;
      const ag = aggRelics(r.relics);
      const dm = r.modifier?.mod || {};
      let heroes = r.heroes.map(h => ({ ...h }));
      let enemies = b.enemies.map(e => ({ ...e }));
      let log = [...b.log];
      let surge = b.surge ? { ...b.surge } : null;
      const tick = b.tick + 1;
      let phoenixUsed = r.phoenixUsed;

      const atkMul = (1 + r.atkMod) * (1 + (ag.atkPct || 0) / 100);
      const eAtkMul = 1 + (ag.enemyAtkPct || 0) / 100; /* descent atk modifier is baked into enemy stats multiplicatively */
      const ultGain = ULT_PER_ATTACK * (1 + 0.08 * (bld.arcanum - 1)) * (1 + (ag.ultPct || 0) / 100);
      const heroSpdBase = 1 + (ag.spdPct || 0) / 100;
      const enemySpdBase = (1 + (ag.enemySpdPct || 0) / 100) * (1 + (dm.enemySpdPct2 || 0) / 100);
      const accAdj = (ag.accFlat || 0) + (dm.heroAccFlat || 0);
      const defAdj = ag.defFlat || 0;

      /* heroes: attack when gauge fills; each attack SWING charges the ult.
         Quickdraw haste applies ONLY to Fenwick */
      const focusTarget = () => enemies.find(e => e.key === b.focus && e.hp > 0) || enemies.find(e => e.hp > 0);
      heroes.forEach(h => {
        if (!h.alive) return;
        const haste = h.id === "rang" && tick < b.hasteUntil ? 1.6 : 1;
        h.gauge = (h.gauge || 0) + h.spd * heroSpdBase * haste;
        if (h.gauge >= 100) {
          h.gauge -= 100;
          h.ult = Math.min(100, h.ult + ultGain);
          const t = focusTarget();
          if (t) {
            if (rollHit({ ...h, acc: h.acc + accAdj }, t)) {
              const { dmg, crit } = rollDamage({ ...h, atk: Math.round(h.atk * atkMul), matk: Math.round(h.matk * atkMul) }, t, 1);
              t.hp -= dmg;
              if (crit) addFloat(`CRIT -${dmg}`, C.gold);
            } else addFloat("MISS", C.dim);
          }
        }
      });

      /* enemies: attack gauge; Entangle slows ONLY the marked target; taunt redirects to Branwen */
      enemies.filter(e => e.hp > 0).forEach(e => {
        const slowed = e.key === b.slowedKey && tick < b.slowUntil ? 0.5 : 1;
        e.gauge = (e.gauge || 0) + e.spd * enemySpdBase * slowed;
        if (e.gauge >= 100) {
          e.gauge -= 100;
          const live = heroes.filter(h => h.alive);
          if (!live.length) return;
          const bran = heroes.find(h => h.id === "bran" && h.alive);
          const t = (tick < b.tauntUntil && bran) ? bran : rnd(live);
          const td = { ...t, def: t.def + defAdj };
          if (t.id === "bran" && tick < b.tauntUntil) { td.def *= 2; td.mdef *= 2; } /* Taunt doubles his defenses */
          if (rollHit(e, td)) {
            const { dmg, crit } = rollDamage({ ...e, atk: Math.round(e.atk * eAtkMul), matk: Math.round(e.matk * eAtkMul) }, td, 1);
            t.hp -= dmg;
            if (crit) addFloat(`-${dmg} CRIT!`, C.red);
          } else addFloat("DODGED", C.umbral);
        }
      });

      /* UMBRAL SURGE quick-time event */
      if (surge) {
        surge.ticksLeft -= 1;
        if (surge.ticksLeft <= 0) {
          const src = enemies.find(e => e.key === surge.enemyKey && e.hp > 0);
          if (src) {
            const live = heroes.filter(h => h.alive);
            if (live.length) {
              const bran = heroes.find(h => h.id === "bran" && h.alive);
              const t = (tick < b.tauntUntil && bran) ? bran : rnd(live);
              const td = { ...t, def: t.def + defAdj };
              if (t.id === "bran" && tick < b.tauntUntil) { td.def *= 2; td.mdef *= 2; } /* Taunt doubles his defenses */
              const { dmg: raw } = rollDamage({ ...src, atk: Math.round(src.atk * eAtkMul), matk: Math.round(src.matk * eAtkMul), crit: 0 }, td, 3);
              const dmg = surge.braced ? Math.round(raw * 0.3) : raw;
              t.hp -= dmg;
              log.push(surge.braced ? `🛡️ BRACED! ${t.name} takes only ${dmg}` : `💥 Surge hits ${t.name} for ${dmg}!`);
              addFloat(surge.braced ? `-${dmg} 🛡️` : `-${dmg}!`, surge.braced ? C.umbral : C.red);
            }
          }
          surge = null;
        }
      } else if (tick > 16 && tick % 36 === 0) {
        const live = enemies.filter(e => e.hp > 0);
        if (live.length) {
          surge = { enemyKey: rnd(live).key, ticksLeft: 8, braced: false };
          log.push("⚠️ An enemy is winding up a heavy attack — BRACE!");
        }
      }

      /* deaths */
      heroes.forEach(h => {
        if (h.alive && h.hp <= 0) {
          if (ag.phoenix && !phoenixUsed) {
            h.hp = Math.round(h.maxHp * 0.3); phoenixUsed = true;
            log.push(`🪶 ${h.name} rises from the ashes!`);
          } else { h.alive = false; h.hp = 0; log.push(`☠️ ${h.name} has fallen!`); }
        }
      });
      enemies.forEach(e => { e.hp = Math.max(0, e.hp); });

      const won = enemies.every(e => e.hp <= 0);
      const lost = heroes.every(h => !h.alive);

      setRun({ ...r, heroes, phoenixUsed });
      setBattle({ ...b, enemies, log: log.slice(-3), surge, tick });

      if (won) { clearInterval(iv); winFight({ ...r, heroes, phoenixUsed }, heroes, b.type); }
      else if (lost) { clearInterval(iv); finishRun({ ...r, heroes }, false); }
    }, TICK_MS);
    return () => clearInterval(iv);
  }, [screen, battle?.type, battle?.started]); // eslint-disable-line

  /* --- player actions --- */
  const startFight = () => {
    const b = battleRef.current;
    if (b) setBattle({ ...b, started: true, log: ["⚔️ The clash begins!"] });
  };

  const setFocus = key => {
    const b = battleRef.current;
    if (!b) return;
    const e = b.enemies.find(x => x.key === key);
    if (e && e.hp > 0) setBattle({ ...b, focus: key });
  };

  const brace = () => {
    const b = battleRef.current;
    if (!b || !b.surge || b.surge.braced) return;
    setBattle({ ...b, surge: { ...b.surge, braced: true } });
  };

  const fireUlt = i => {
    const r = runRef.current, b = battleRef.current;
    if (!r || !b || !b.started) return;
    const h = r.heroes[i];
    if (!h.alive || h.ult < 100) return;
    let heroes = r.heroes.map(x => ({ ...x }));
    let enemies = b.enemies.map(e => ({ ...e }));
    let log = [...b.log];
    let { tauntUntil, hasteUntil, slowUntil, slowedKey } = b;
    const ag = aggRelics(r.relics);
    const atkMul = (1 + r.atkMod) * (1 + (ag.atkPct || 0) / 100);
    /* ultimates scale +2% per depth (damage, healing, and durations) */
    const ultScale = 1 + 0.02 * Math.max(0, depthOf(r));

    if (h.id === "bran") { tauntUntil = b.tick + Math.round(8 * ultScale); log.push("🛡️ TAUNT! All eyes on Branwen — defenses doubled"); addFloat("🛡️ TAUNT", C.blue); }
    if (h.id === "kael") {
      const live = enemies.filter(e => e.hp > 0);
      if (live.length) {
        const t = enemies.find(e => e.key === b.focus && e.hp > 0) || live.reduce((a, c) => a.hp > c.hp ? a : c);
        const { dmg } = rollDamage({ ...h, atk: Math.round(h.atk * atkMul) }, t, 3 * ultScale);
        t.hp = Math.max(0, t.hp - dmg);
        log.push(`⚔️ Sever! ${dmg} damage`); addFloat(`-${dmg} ⚔️`, C.ember);
      }
    }
    if (h.id === "syra") {
      enemies = enemies.map(e => {
        if (e.hp <= 0) return e;
        const { dmg } = rollDamage({ ...h, matk: Math.round(h.matk * atkMul) }, e, 2 * ultScale);
        return { ...e, hp: Math.max(0, e.hp - dmg) };
      });
      log.push("🔥 Cinder Nova engulfs all foes!"); addFloat("🔥 NOVA", C.ember);
    }
    if (h.id === "prie") {
      const heal = Math.round(15 * ultScale);
      heroes = heroes.map(x => x.alive ? { ...x, hp: Math.min(x.maxHp, x.hp + heal) } : x);
      log.push(`🙏 Sanctuary! Party healed +${heal}`); addFloat(`+${heal} ❤️`, C.green);
    }
    if (h.id === "rang") { hasteUntil = b.tick + Math.round(12 * ultScale); log.push("🏹 Quickdraw! Fenwick attacks 60% faster"); addFloat("🏹 HASTE", C.blue); }
    if (h.id === "drui") {
      const live = enemies.filter(e => e.hp > 0);
      const t = enemies.find(e => e.key === b.focus && e.hp > 0) || live[0];
      if (t) {
        slowedKey = t.key; slowUntil = b.tick + Math.round(16 * ultScale);
        log.push(`🌿 Entangle! ${t.name} slowed 50%`); addFloat("🌿 SLOW", C.umbral);
      }
    }

    heroes[i] = { ...heroes[i], ult: 0 };
    setRun({ ...r, heroes });
    setBattle({ ...b, enemies, log: log.slice(-3), tauntUntil, hasteUntil, slowUntil, slowedKey });
  };

  const winFight = (r, heroes, type) => {
    const depth = depthOf(r);
    const ag = aggRelics(r.relics);
    const regionMul = r.regionId === "forest" ? 1.6 : 1;
    const mult = (type === "boss" ? 4 : type === "elite" ? 2 : 1) * (1 + 0.1 * (bld.shard - 1)) * regionMul;
    const goldMul = 1 + (ag.goldPct || 0) / 100;
    let hs = heroes;
    if (ag.healAfterFight) hs = hs.map(h => h.alive ? { ...h, hp: Math.min(h.maxHp, h.hp + ag.healAfterFight) } : h);
    let r2 = {
      ...r, heroes: hs,
      gold: r.gold + Math.round((20 + depth * 8) * mult * goldMul),
      wood: r.wood + Math.round((10 + depth * 4) * mult),
      embers: r.embers + (type === "boss" ? 8 : type === "elite" ? 2 : Math.random() > 0.6 ? 1 : 0),
    };
    setBattle(null);

    if (type === "boss") {
      /* bosses are the ONLY source of equipment */
      const drop = rnd(ITEMS);
      const uid = Math.random().toString(36).slice(2);
      setItems(p => [...p, { uid, id: drop.id }]);
      r2 = { ...r2, drops: [...r2.drops, { ...drop, uid }] };
      if (r2.regionId === "marsh") {
        if (!forestUnlocked) setForestUnlocked(true);
        setRun(r2);
        setScreen("descend");
        return;
      }
      finishRun(r2, true, true);
      return;
    }
    backToMap(r2);
  };

  /* descend deeper into the Ogre Forest with a random modifier */
  const descend = () => {
    const r = runRef.current;
    const m = rnd(DESCENT_MODS);
    const heroes = r.heroes.map(h => h.alive ? { ...h, hp: Math.min(h.maxHp, h.hp + Math.round(h.maxHp * 0.3)), gauge: 0, ult: 0 } : h);
    setRun({ ...r, regionId: "forest", modifier: m, grid: makeRunGrid(), pos: null, visited: [], heroes });
    setScreen("modifier");
  };

  /* equip a fresh boss drop onto a hero in the CURRENT party, mid-run:
     updates persistent equips AND live run hero stats (delta vs old item) */
  const equipToRunHero = (heroId, drop) => {
    setEquips(p => ({ ...p, [heroId]: drop.uid }));
    const r = runRef.current;
    const heroes = r.heroes.map(h => {
      if (h.id !== heroId) return h;
      const oldMod = h.item?.mod || {};
      const d = k => (drop.mod[k] || 0) - (oldMod[k] || 0);
      const maxHp = h.maxHp + d("hp");
      return {
        ...h, maxHp, hp: Math.max(1, Math.min(maxHp, h.hp + d("hp"))),
        atk: h.atk + d("atk"), matk: h.matk + d("matk"),
        def: h.def + d("def"), mdef: h.mdef + d("mdef"),
        crit: h.crit + d("crit"), eva: h.eva + d("eva"),
        acc: h.acc + d("acc"), spd: h.spd + d("spd"),
        item: { ...drop },
      };
    });
    const drops = r.drops.map(x => x.uid === drop.uid ? { ...x, equippedTo: heroId } : x);
    setRun({ ...r, heroes, drops });
  };

  /* equip a drop from the post-run summary (persistent only) */
  const equipFromSummary = (heroId, drop) => {
    setEquips(p => ({ ...p, [heroId]: drop.uid }));
    setSummary(s => ({ ...s, drops: s.drops.map(x => x.uid === drop.uid ? { ...x, equippedTo: heroId } : x) }));
  };

  const finishRun = (r, extracted, bossKill = false) => {
    const k = extracted ? 1 : 0.5;
    const gained = { gold: Math.round(r.gold * k), wood: Math.round(r.wood * k), embers: Math.round(r.embers * k) };
    setRes(p => ({ gold: p.gold + gained.gold, wood: p.wood + gained.wood, embers: p.embers + gained.embers }));
    setRunsDone(n => n + 1);
    setSummary({ extracted, bossKill, gained, depth: depthOf(r) + 1, drops: r.drops, regionId: r.regionId, ogreKill: bossKill && r.regionId === "forest" });
    setRun(null); setBattle(null);
    setScreen("summary");
  };

  const upgrade = b => {
    const lvl = bld[b.id], cost = b.cost(lvl);
    if ((cost.gold || 0) > res.gold || (cost.wood || 0) > res.wood || (cost.embers || 0) > res.embers) return;
    setRes(p => ({ gold: p.gold - (cost.gold || 0), wood: p.wood - (cost.wood || 0), embers: p.embers - (cost.embers || 0) }));
    setBld(p => ({ ...p, [b.id]: p[b.id] + 1 }));
  };

  const toggleParty = id => {
    setParty(p => p.includes(id) ? p.filter(x => x !== id) : p.length < 3 ? [...p, id] : p);
  };

  /* ---------- render ---------- */
  const corruption = run ? ((depthOf(run) + 1) / (COLS + 2)) * (run.regionId === "forest" ? 1 : 0.6) : 0;
  const glow = run
    ? `radial-gradient(ellipse 90% 55% at 50% -10%, rgba(67,197,178,${0.10 + corruption * 0.25}), transparent 60%)`
    : `radial-gradient(ellipse 90% 55% at 50% -10%, rgba(240,140,58,.22), transparent 60%)`;

  const Shell = ({ children, title, sub }) => (
    <div style={{ minHeight: "100vh", background: `${glow}, ${C.bg}`, color: C.text, fontFamily: "'Alegreya Sans',sans-serif", maxWidth: 480, margin: "0 auto", padding: "20px 16px 32px", position: "relative" }}>
      <style>{FONT}{`
        @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.07)} }
        @keyframes floatUp { 0%{opacity:1; transform:translateY(0)} 100%{opacity:0; transform:translateY(-46px)} }
        @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
        @keyframes glowPulse { 0%,100%{box-shadow:0 0 5px ${C.gold}44} 50%{box-shadow:0 0 14px ${C.gold}aa} }
      `}</style>
      <div style={{ fontFamily: "'Cinzel',serif", fontWeight: 900, fontSize: 13, letterSpacing: 4, color: run ? C.umbral : C.ember, textAlign: "center" }}>EMBERHOLD</div>
      {title && <h1 style={{ fontFamily: "'Cinzel',serif", fontSize: 24, fontWeight: 700, textAlign: "center", margin: "10px 0 2px" }}>{title}</h1>}
      {sub && <div style={{ textAlign: "center", color: C.dim, fontSize: 13, marginBottom: 14 }}>{sub}</div>}
      {children}
      <div style={{ position: "absolute", top: "38%", left: 0, right: 0, pointerEvents: "none" }}>
        {floats.map(f => (
          <div key={f.id} style={{ position: "absolute", left: `${f.x}%`, fontWeight: 900, fontSize: 18, color: f.color, animation: "floatUp 1.2s ease-out forwards", textShadow: "0 2px 6px #000" }}>{f.text}</div>
        ))}
      </div>
    </div>
  );

  /* BASE */
  if (screen === "base") {
    const heroes = heroStats();
    return (
      <Shell title="Your Hold" sub={`The Worldflame burns. Expeditions: ${runsDone}${forestUnlocked ? " · 🌲 Ogre Forest unlocked" : ""}`}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}><Res res={res} /></div>
        <div style={{ display: "grid", gap: 10, marginBottom: 18 }}>
          {BUILDINGS.map(b => {
            const lvl = bld[b.id], cost = b.cost(lvl);
            const can = (cost.gold || 0) <= res.gold && (cost.wood || 0) <= res.wood && (cost.embers || 0) <= res.embers;
            return (
              <div key={b.id} style={{ background: C.panel, borderRadius: 14, padding: 14, display: "flex", alignItems: "center", gap: 12, border: `1px solid ${C.panel2}` }}>
                <div style={{ fontSize: 26 }}>{b.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>{b.name} <span style={{ color: C.gold }}>Depth {lvl}</span></div>
                  <div style={{ fontSize: 12, color: C.dim }}>{b.desc}</div>
                </div>
                <Btn small disabled={!can} onClick={() => upgrade(b)}>
                  {Object.entries(cost).map(([k, v]) => `${k === "gold" ? "🪙" : k === "wood" ? "🪵" : "✨"}${v}`).join(" ")}
                </Btn>
              </div>
            );
          })}
        </div>

        <div style={{ background: C.panel, borderRadius: 14, padding: 14, marginBottom: 18, border: `1px solid ${C.panel2}` }}>
          <div style={{ fontFamily: "'Cinzel',serif", fontWeight: 700, marginBottom: 4 }}>Your Heroes</div>
          <div style={{ fontSize: 11, color: party.length === 3 ? C.dim : C.ember, marginBottom: 10 }}>
            ☑ Select exactly 3 to bring into the Umbral ({party.length}/3 selected) · hover or tap ⓘ for stats
          </div>
          {heroes.map(h => {
            const inParty = party.includes(h.id);
            const available = items.filter(it => {
              const holder = Object.entries(equips).find(([, uid]) => uid === it.uid);
              return !holder || holder[0] === h.id;
            });
            return (
              <StatCard key={h.id} unit={{ ...h, hp: h.maxHp }} idKey={`base-${h.id}`} pinned={pinned} setPinned={setPinned} hovered={hovered} setHovered={setHovered}
                style={{ fontSize: 13, color: C.dim, marginBottom: 10, padding: "6px 22px 6px 6px", borderRadius: 8, background: inParty ? "#241a30" : "#1c1628", border: `1px solid ${inParty ? C.ember + "66" : C.panel2}` }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" checked={inParty} onChange={() => toggleParty(h.id)}
                    style={{ width: 16, height: 16, accentColor: C.ember, cursor: "pointer" }} />
                  <span>{h.icon}</span><span style={{ color: C.text, fontWeight: 700 }}>{h.name}</span>
                  <span>{h.cls}</span><span style={{ marginLeft: "auto" }}>❤️{h.maxHp} ⚔️{h.atk} 🔮{h.matk} 💨{h.spd}</span>
                </div>
                <div style={{ fontSize: 12, color: C.ember, marginTop: 4 }}>
                  ⚡ {h.ultName} <span style={{ color: C.dim }}>— {h.ultDesc}</span>
                </div>
                <div onClick={() => setEquipPicker(p => (p === h.id ? null : h.id))}
                  style={{ marginTop: 5, fontSize: 12, cursor: "pointer", color: h.item ? C.gold : C.dim, background: C.panel, borderRadius: 8, padding: "5px 8px", border: `1px dashed ${h.item ? C.gold : C.panel2}66`, display: "inline-block" }}>
                  {h.item ? `${h.item.icon} ${h.item.name} (${h.item.desc})` : "▫️ Empty equipment slot"} <span style={{ color: C.dim }}>▾</span>
                </div>
                {equipPicker === h.id && (
                  <div style={{ marginTop: 6, display: "grid", gap: 5 }}>
                    {available.length === 0 && <div style={{ fontSize: 11, color: C.dim }}>No items yet — equipment drops only from bosses!</div>}
                    {available.map(it => {
                      const d = ITEMS.find(x => x.id === it.id);
                      const equippedHere = equips[h.id] === it.uid;
                      return (
                        <div key={it.uid} onClick={() => { setEquips(p => ({ ...p, [h.id]: it.uid })); setEquipPicker(null); }}
                          style={{ fontSize: 12, padding: "6px 8px", borderRadius: 8, cursor: "pointer", background: equippedHere ? "#3a2412" : C.panel, border: `1px solid ${equippedHere ? C.ember : C.panel2}` }}>
                          {d.icon} <span style={{ color: C.text, fontWeight: 700 }}>{d.name}</span> <span style={{ color: C.dim }}>· {d.desc}</span>{equippedHere && <span style={{ color: C.ember }}> · equipped</span>}
                        </div>
                      );
                    })}
                    {h.item && (
                      <div onClick={() => { setEquips(p => { const q = { ...p }; delete q[h.id]; return q; }); setEquipPicker(null); }}
                        style={{ fontSize: 12, padding: "6px 8px", borderRadius: 8, cursor: "pointer", background: C.panel, border: `1px solid ${C.panel2}`, color: C.dim }}>
                        ✖ Unequip
                      </div>
                    )}
                  </div>
                )}
              </StatCard>
            );
          })}
        </div>
        <Btn full disabled={party.length !== 3} onClick={startRun}>
          {party.length === 3 ? "🌫️ Venture into the Forgotten Marshland" : `Select ${3 - party.length} more hero${3 - party.length === 1 ? "" : "es"}`}
        </Btn>
        <div style={{ textAlign: "center", marginTop: 14 }}>
          <button onClick={() => {
            if (confirm("Reset your Hold? This wipes all progress (resources, buildings, items, unlocks) and cannot be undone.")) {
              clearSave(); location.reload();
            }
          }} style={{ background: "transparent", color: C.dim, border: `1px solid ${C.panel2}`, borderRadius: 8, padding: "6px 14px", fontSize: 11, cursor: "pointer", fontFamily: "'Alegreya Sans',sans-serif" }}>
            ⚠️ Reset Hold (wipes save)
          </button>
        </div>
      </Shell>
    );
  }

  /* MAP */
  if (screen === "map" && run) {
    const region = REGIONS[run.regionId];
    const icons = { fight: "⚔️", elite: "👹", event: "❓", shrine: "✨", waygate: "🌀", boss: "💀" };
    const bossIcon = region.boss.icon;
    const LEGEND = [
      ["⚔️", "Fight — battle Umbral creatures"],
      ["👹", "Elite — tougher fight, better loot"],
      ["✨", "Shrine — choose a relic for this run"],
      ["❓", "Event — story choice, risk & reward"],
      ["🌀", "Waygate — heal 30%, revive fallen at 20%, extract or continue"],
      [bossIcon, `Boss — ${region.boss.name}`],
    ];
    const cands = candidatesOf(run);
    const isCand = (r2, c2) => cands.some(x => !x.boss && !x.converge && x.row === r2 && x.col === c2);
    const convergeCand = cands.some(x => x.converge);
    const bossCand = cands.some(x => x.boss);
    /* a relic was just chosen: shrine candidates are blocked while any
       non-shrine option exists (no back-to-back relic picks) */
    const lastWasShrine = run.lastType === "shrine";
    const candHasNonShrine = cands.some(x => x.boss || x.converge || run.grid[x.row][x.col] !== "shrine");
    const shrineBlocked = lastWasShrine && candHasNonShrine;
    const SZ = 36;

    return (
      <Shell title={region.name} sub={`Depth ${depthOf(run) + 1} of ${COLS + 2} · Corruption ${Math.round(corruption * 100)}%${run.modifier ? ` · ${run.modifier.name}` : ""} · choose your next step`}>
        <div style={{ overflowX: "auto", paddingBottom: 6, marginBottom: 12 }}>
          <div style={{
            display: "grid", gap: 6, justifyContent: "center",
            gridTemplateColumns: `repeat(${COLS + 2}, ${SZ}px)`,
            gridTemplateRows: `repeat(3, ${SZ}px)`,
            minWidth: (SZ + 6) * (COLS + 2),
          }}>
            {run.grid.map((rowArr, r2) => rowArr.map((t, c2) => {
              if (!t) return null;
              const here = run.pos && !run.pos.boss && !run.pos.converge && run.pos.row === r2 && run.pos.col === c2;
              const was = run.visited.includes(`${r2}-${c2}`);
              const rawCand = isCand(r2, c2);
              const blocked = rawCand && t === "shrine" && shrineBlocked;
              const cand = rawCand && !blocked;
              return (
                <div key={`${r2}-${c2}`} onClick={() => cand && chooseNode({ row: r2, col: c2 })}
                  title={blocked ? "You just chose a relic — shrines can't be picked back to back" : undefined}
                  style={{
                    gridRow: r2 + 1, gridColumn: c2 + 1,
                    borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
                    background: here ? C.ember : was ? "#1c1628" : cand ? C.panel2 : C.panel,
                    opacity: was ? 0.35 : blocked ? 0.4 : cand || here ? 1 : 0.55,
                    border: here ? `2px solid ${C.gold}` : cand ? `2px solid ${C.gold}` : blocked ? `2px dashed ${C.dim}` : `1px solid ${C.panel2}`,
                    cursor: cand ? "pointer" : "default",
                    animation: cand ? "glowPulse 1.2s infinite" : "none",
                  }}>{blocked ? "🚫" : icons[t]}</div>
              );
            }))}
            {/* converge waygate */}
            <div onClick={() => convergeCand && chooseNode({ converge: true })} style={{
              gridRow: 2, gridColumn: COLS + 1,
              borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17,
              background: run.pos?.converge ? C.ember : convergeCand ? C.panel2 : C.panel,
              border: convergeCand ? `2px solid ${C.umbral}` : `1px solid ${C.umbral}55`,
              cursor: convergeCand ? "pointer" : "default",
              animation: convergeCand ? "glowPulse 1.2s infinite" : "none",
            }}>🌀</div>
            {/* boss */}
            <div onClick={() => bossCand && chooseNode({ boss: true })} style={{
              gridRow: 2, gridColumn: COLS + 2,
              borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
              background: run.pos?.boss ? C.ember : bossCand ? C.panel2 : C.panel,
              border: bossCand ? `2px solid ${C.red}` : `1px solid ${C.red}55`,
              cursor: bossCand ? "pointer" : "default",
              animation: bossCand ? "glowPulse 1.2s infinite" : "none",
            }}>{bossIcon}</div>
          </div>
        </div>

        <div style={{ background: C.panel, borderRadius: 12, marginBottom: 12, border: `1px solid ${C.panel2}`, overflow: "hidden" }}>
          <div onClick={() => setLegendOpen(o => !o)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", cursor: "pointer" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.dim, letterSpacing: 1 }}>MAP LEGEND</span>
            <span style={{ color: C.dim, fontSize: 12 }}>{legendOpen ? "▲ hide" : "▼ show"}</span>
          </div>
          {legendOpen && (
            <div style={{ padding: "0 12px 10px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 10px" }}>
              {LEGEND.map(([icon, label]) => (
                <div key={label} style={{ fontSize: 11, color: C.dim, display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <span style={{ fontSize: 14 }}>{icon}</span><span>{label}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ background: C.panel, borderRadius: 14, padding: 14, marginBottom: 14, border: `1px solid ${C.panel2}` }}>
          {run.heroes.map(h => (
            <div key={h.id} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", fontSize: 13, marginBottom: 3 }}>
                <span style={{ opacity: h.alive ? 1 : 0.35 }}>{h.icon} {h.name}</span>
                <span style={{ marginLeft: "auto", color: C.dim }}>{h.hp}/{h.maxHp}</span>
              </div>
              <Bar val={h.hp} max={h.maxHp} color={h.alive ? C.green : C.red} />
            </div>
          ))}
        </div>
        {(run.atkMod > 0 || run.modifier || run.relics.length > 0) && (
          <div style={{ background: "#1c1628", borderRadius: 12, padding: "8px 12px", marginBottom: 10, border: `1px solid ${C.panel2}`, fontSize: 12 }}>
            <div style={{ color: C.dim, fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>ACTIVE EFFECTS</div>
            {run.atkMod > 0 && <div style={{ color: C.green }}>🌟 Event blessing: +{Math.round(run.atkMod * 100)}% attack this run</div>}
            {run.modifier && <div style={{ color: C.red }}>🌑 {run.modifier.name}: {run.modifier.desc}</div>}
            {run.relics.length > 0 && <div style={{ color: C.gold }}>Relics: {run.relics.map(r => r.icon + " " + r.name).join(" · ")}</div>}
          </div>
        )}
        <div style={{ textAlign: "center", fontSize: 13, color: C.gold }}>
          Run loot: 🪙{run.gold} 🪵{run.wood} ✨{run.embers}
        </div>
      </Shell>
    );
  }

  /* BATTLE */
  if (screen === "battle" && battle && run) {
    const surging = battle.surge && !battle.surge.braced;
    const tauntOn = battle.tick < battle.tauntUntil;
    const hasteOn = battle.tick < battle.hasteUntil;
    const slowOn = battle.tick < battle.slowUntil;
    return (
      <Shell title={battle.type === "boss" ? REGIONS[run.regionId].boss.name.toUpperCase() : battle.type === "elite" ? "Elite Encounter" : "Ambush"}
        sub={battle.started ? "Tap an enemy to focus fire · Tap ⓘ for stats · Tap glowing ults to cast" : "Tap ⓘ to inspect your foes, then begin when ready"}>
        {/* enemies */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 10, flexWrap: "wrap" }}>
          {battle.enemies.map(e => {
            const focused = battle.focus === e.key && e.hp > 0;
            const isSurger = battle.surge?.enemyKey === e.key;
            return (
              <StatCard key={e.key} unit={e} idKey={e.key} dir="down" clickOnly pinned={pinned} setPinned={setPinned} hovered={hovered} setHovered={setHovered}
                onClick={() => setFocus(e.key)}
                style={{
                  background: C.panel, borderRadius: 12, padding: 10, width: 96, textAlign: "center",
                  opacity: e.hp > 0 ? 1 : 0.25, cursor: e.hp > 0 ? "pointer" : "default",
                  border: focused ? `2px solid ${C.gold}` : isSurger ? `2px solid ${C.red}` : `1px solid ${C.umbral}33`,
                  boxShadow: focused ? `0 0 10px ${C.gold}55` : "none",
                  animation: isSurger && surging ? "shake .4s infinite" : "none",
                }}>
                <div style={{ fontSize: 26 }}>{isSurger && surging ? "⚠️" : e.icon}</div>
                <div style={{ fontSize: 10, color: C.dim, height: 24 }}>{e.name}{slowOn && battle.slowedKey === e.key ? " 🌿" : ""}</div>
                <Bar val={e.hp} max={e.maxHp} color={C.umbral} h={6} />
                <div style={{ margin: "3px 0" }}><Bar val={e.gauge || 0} max={100} color={C.blue} h={4} /></div>
                <div style={{ fontSize: 11 }}>{e.hp}</div>
                {focused && <div style={{ fontSize: 10, color: C.gold, fontWeight: 700 }}>🎯 FOCUS</div>}
              </StatCard>
            );
          })}
        </div>

        {/* active buffs */}
        <div style={{ minHeight: 18, textAlign: "center", fontSize: 12, marginBottom: 4 }}>
          {tauntOn && <span style={{ color: C.blue, marginRight: 10 }}>🛡️ Taunt active</span>}
          {hasteOn && <span style={{ color: C.blue, marginRight: 10 }}>🏹 Fenwick hasted</span>}
          {slowOn && <span style={{ color: C.umbral }}>🌿 {battle.enemies.find(e => e.key === battle.slowedKey)?.name || "Enemy"} entangled</span>}
        </div>

        {/* Fight! (inline) */}
        <div style={{ height: 52, display: "flex", justifyContent: "center", alignItems: "center", marginBottom: 6 }}>
          {!battle.started ? (
            <button onClick={startFight} style={{
              background: C.ember, color: "#1a1020", border: "none", borderRadius: 12, padding: "12px 44px",
              fontFamily: "'Cinzel',serif", fontWeight: 900, fontSize: 20, cursor: "pointer",
              animation: "pulse 1.2s infinite", boxShadow: `0 0 20px ${C.ember}88`,
            }}>⚔️ FIGHT!</button>
          ) : battle.surge?.braced ? (
            <div style={{ color: C.umbral, fontWeight: 700, fontSize: 14 }}>🛡️ Braced — hold fast!</div>
          ) : null}
        </div>

        {/* BRACE — fixed bottom, above everything */}
        {surging && (
          <div style={{ position: "fixed", bottom: 18, left: 0, right: 0, display: "flex", justifyContent: "center", zIndex: 100, pointerEvents: "none" }}>
            <button onClick={brace} style={{
              background: C.red, color: "#fff", border: "none", borderRadius: 14, padding: "16px 56px",
              fontFamily: "'Cinzel',serif", fontWeight: 900, fontSize: 20, cursor: "pointer", pointerEvents: "auto",
              animation: "pulse .45s infinite", boxShadow: `0 0 26px ${C.red}cc`,
            }}>🛡️ BRACE!</button>
          </div>
        )}

        <div style={{ minHeight: 48, textAlign: "center", fontSize: 13, color: C.gold, marginBottom: 8 }}>
          {battle.log.map((l, i) => <div key={i}>{l}</div>)}
        </div>

        {/* heroes: HP bar, attack gauge bar, ult bar + button */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          {run.heroes.map((h, i) => {
            const ready = battle.started && h.alive && h.ult >= 100;
            return (
              <StatCard key={h.id} unit={h} idKey={`b-${h.id}`} clickOnly pinned={pinned} setPinned={setPinned} hovered={hovered} setHovered={setHovered}
                style={{
                  background: C.panel, borderRadius: 12, padding: 10, width: 106, textAlign: "center",
                  opacity: h.alive ? 1 : 0.3, border: `1px solid ${h.id === "bran" && tauntOn ? C.blue : C.panel2}`,
                }}>
                <div style={{ fontSize: 22 }}>{h.icon}</div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{h.name}</div>
                <Bar val={h.hp} max={h.maxHp} color={C.green} h={6} />
                <div style={{ margin: "3px 0" }}><Bar val={h.gauge || 0} max={100} color={C.blue} h={4} /></div>
                <div style={{ margin: "3px 0" }}><Bar val={h.ult} max={100} color={C.ember} h={5} /></div>
                <button onClick={e => { e.stopPropagation(); fireUlt(i); }} disabled={!ready} style={{
                  width: "100%", border: "none", borderRadius: 8, padding: "7px 4px",
                  fontFamily: "'Alegreya Sans',sans-serif", fontWeight: 700, fontSize: 11,
                  background: ready ? C.ember : "#352c44", color: ready ? "#1a1020" : C.dim,
                  cursor: ready ? "pointer" : "default",
                  animation: ready ? "pulse .7s infinite" : "none",
                  boxShadow: ready ? `0 0 12px ${C.ember}88` : "none",
                }}>{ready ? `⚡ ${h.ultName}` : battle.started ? `${Math.round(h.ult)}%` : h.ultName}</button>
              </StatCard>
            );
          })}
        </div>
        <div style={{ textAlign: "center", fontSize: 10, color: C.dim, marginTop: 8 }}>
          bars: <span style={{ color: C.green }}>HP</span> · <span style={{ color: C.blue }}>attack charge</span> · <span style={{ color: C.ember }}>ultimate</span>
        </div>
      </Shell>
    );
  }

  /* RELIC pick */
  if (screen === "relic" && pendingRelics && run) return (
    <Shell title="A Shrine Hums" sub="Choose one relic — it lasts only this run">
      <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
        {pendingRelics.map(r => (
          <div key={r.id} onClick={() => { const r2 = { ...run, relics: [...run.relics, r] }; setPendingRelics(null); backToMap(r2); }}
            style={{ background: C.panel, borderRadius: 14, padding: 16, cursor: "pointer", border: `1px solid ${C.gold}44`, display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ fontSize: 28 }}>{r.icon}</div>
            <div><div style={{ fontWeight: 700, color: C.gold }}>{r.name}</div><div style={{ fontSize: 13, color: C.dim }}>{r.desc}</div></div>
          </div>
        ))}
      </div>
    </Shell>
  );

  /* EVENT — choice */
  if (screen === "event" && eventCard && run) {
    const resolve = choice => {
      let r2 = choice.fn({ ...run });
      if (r2.teamDmg) r2 = { ...r2, heroes: r2.heroes.map(h => h.alive ? { ...h, hp: Math.max(1, h.hp - r2.teamDmg) } : h), teamDmg: 0 };
      if (r2.teamHeal) r2 = { ...r2, heroes: r2.heroes.map(h => h.alive ? { ...h, hp: Math.min(h.maxHp, h.hp + r2.teamHeal) } : h), teamHeal: 0 };
      setEventCard(null);
      setEventResult({ text: r2.blessing || "Nothing came of it. The road continues.", run: r2 });
      setScreen("eventResult");
    };
    return (
      <Shell title="A Strange Encounter">
        <div style={{ background: C.panel, borderRadius: 14, padding: 18, fontSize: 15, lineHeight: 1.6, marginBottom: 16, fontStyle: "italic", border: `1px solid ${C.panel2}` }}>
          “{eventCard.text}”
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <Btn full onClick={() => resolve(eventCard.a)} disabled={eventCard.a.needGold && run.gold < eventCard.a.needGold}>{eventCard.a.label}</Btn>
          <Btn full color={C.panel2} onClick={() => resolve(eventCard.b)}><span style={{ color: C.text }}>{eventCard.b.label}</span></Btn>
        </div>
      </Shell>
    );
  }

  /* EVENT — outcome */
  if (screen === "eventResult" && eventResult) {
    const good = !/loses|Burned|Ambushed|-\d+ HP|snaps|bile|bruises|swats/i.test(eventResult.text);
    return (
      <Shell title={good ? "Fortune Smiles" : "A Costly Choice"}>
        <div style={{ background: C.panel, borderRadius: 14, padding: 20, textAlign: "center", margin: "10px 0 16px", border: `1px solid ${good ? C.umbral : C.red}55` }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>{good ? "🌟" : "💢"}</div>
          <div style={{ fontSize: 15, lineHeight: 1.6 }}>{eventResult.text}</div>
        </div>
        <Btn full onClick={() => { const r2 = eventResult.run; setEventResult(null); backToMap(r2); }}>Continue down the path</Btn>
      </Shell>
    );
  }

  /* WAYGATE */
  if (screen === "waygate" && run) {
    const isConverge = run.pos?.converge;
    const region = REGIONS[run.regionId];
    return (
      <Shell title={isConverge ? "🌀 The Last Waygate" : "🌀 A Waygate"}
        sub={isConverge ? `Every path leads here. Beyond this gate, only ${region.boss.name} remains.` : "A shimmering door home. Beyond it, the dark deepens."}>
        <div style={{ background: C.panel, borderRadius: 14, padding: 16, textAlign: "center", marginBottom: 16, border: `1px solid ${C.umbral}55` }}>
          <div style={{ fontSize: 13, color: C.green, marginBottom: 8 }}>✨ The gate's light mends the party: +30% HP, and the fallen rise again at 20%.</div>
          <div style={{ fontSize: 13, color: C.dim, marginBottom: 6 }}>Loot secured if you extract now</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.gold }}>🪙{run.gold} 🪵{run.wood} ✨{run.embers}</div>
          <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>If your party falls deeper in, you keep only half.</div>
          {isConverge && <div style={{ fontSize: 12, color: C.gold, marginTop: 6 }}>⚔️ Bosses drop equipment — items can be won nowhere else.</div>}
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <Btn full color={C.umbral} onClick={() => finishRun(run, true)}>🏠 Extract — keep everything</Btn>
          <Btn full onClick={() => backToMap()}>{isConverge ? `${region.boss.icon} Face ${region.boss.name}` : "⚔️ Continue — greater rewards ahead"}</Btn>
        </div>
      </Shell>
    );
  }

  /* DESCEND — after killing the Marshland boss */
  if (screen === "descend" && run) {
    return (
      <Shell title="The Herald Falls!" sub="Behind its corpse, the marsh floor splits open — a rift descending into deeper Umbral.">
        <div style={{ background: C.panel, borderRadius: 14, padding: 16, marginBottom: 14, border: `1px solid ${C.gold}55` }}>
          <div style={{ fontSize: 13, color: C.dim, marginBottom: 6, textAlign: "center" }}>Equipment claimed — equip it now, before going deeper:</div>
          {run.drops.map(d => (
            <div key={d.uid} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.gold, textAlign: "center" }}>{d.icon} {d.name} <span style={{ fontSize: 12, color: C.text, fontWeight: 400 }}>· {d.desc}</span></div>
              {d.equippedTo ? (
                <div style={{ fontSize: 12, color: C.umbral, textAlign: "center", marginTop: 4 }}>✓ Equipped to {HERO_DEFS.find(x => x.id === d.equippedTo)?.name}</div>
              ) : (
                <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 6 }}>
                  {run.heroes.map(h => (
                    <button key={h.id} onClick={() => equipToRunHero(h.id, d)} style={{
                      background: C.panel2, color: C.text, border: `1px solid ${C.gold}44`, borderRadius: 8,
                      padding: "6px 10px", fontSize: 12, cursor: "pointer", fontFamily: "'Alegreya Sans',sans-serif",
                    }}>{h.icon} {h.name}{h.item ? ` (swap ${h.item.icon})` : ""}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div style={{ fontSize: 13, color: C.gold, marginTop: 8, textAlign: "center" }}>Current loot: 🪙{run.gold} 🪵{run.wood} ✨{run.embers}</div>
        </div>
        <div style={{ background: "#1a2420", borderRadius: 14, padding: 16, marginBottom: 16, border: `1px solid ${C.umbral}66` }}>
          <div style={{ fontFamily: "'Cinzel',serif", fontWeight: 700, color: C.umbral, marginBottom: 6 }}>🌲 The Ogre Forest beckons</div>
          <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.6 }}>
            Descend to face the Ogre King — stronger foes, 60% richer loot, and a second equipment drop.
            The party recovers 30% HP on descent, but a <span style={{ color: C.red }}>random Umbral modifier</span> will
            empower all remaining enemy encounters this expedition. If you fall, half your loot is lost.
          </div>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <Btn full color={C.umbral} onClick={() => finishRun(run, true, true)}>🏠 Extract — return victorious</Btn>
          <Btn full onClick={descend}>🌲 Descend into the Ogre Forest</Btn>
        </div>
      </Shell>
    );
  }

  /* MODIFIER reveal after descending */
  if (screen === "modifier" && run && run.modifier) return (
    <Shell title="The Umbral Twists" sub="Descending has stirred the dark. A modifier now empowers every enemy ahead.">
      <div style={{ background: C.panel, borderRadius: 14, padding: 22, textAlign: "center", margin: "12px 0 16px", border: `1px solid ${C.red}66` }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>🌑</div>
        <div style={{ fontFamily: "'Cinzel',serif", fontWeight: 700, fontSize: 18, color: C.red }}>{run.modifier.name}</div>
        <div style={{ fontSize: 14, color: C.text, marginTop: 6 }}>{run.modifier.desc}</div>
        <div style={{ fontSize: 12, color: C.dim, marginTop: 10 }}>Applies to all enemy encounters for the rest of this expedition.</div>
      </div>
      <Btn full onClick={() => setScreen("map")}>🌲 Enter the Ogre Forest</Btn>
    </Shell>
  );

  /* SUMMARY */
  if (screen === "summary" && summary) return (
    <Shell title={summary.ogreKill ? "👑 The Ogre King Falls!" : summary.bossKill ? "🏆 Victory!" : summary.extracted ? "Safely Home" : "The Party Has Fallen"}
      sub={summary.extracted ? "Your hold grows stronger." : "Survivors limp home with half the spoils."}>
      <div style={{ background: C.panel, borderRadius: 14, padding: 18, textAlign: "center", margin: "14px 0", border: `1px solid ${C.panel2}` }}>
        <div style={{ fontSize: 13, color: C.dim, marginBottom: 8 }}>
          {REGIONS[summary.regionId].emoji} {REGIONS[summary.regionId].name} · depth {summary.depth} of {COLS + 2} · loot returned:
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: C.gold }}>
          🪙 +{summary.gained.gold} &nbsp; 🪵 +{summary.gained.wood} &nbsp; ✨ +{summary.gained.embers}
        </div>
        {summary.drops.length > 0 && (
          <div style={{ marginTop: 12, padding: "10px 12px", background: "#3a2412", borderRadius: 10, border: `1px solid ${C.gold}66` }}>
            <div style={{ fontSize: 12, color: C.dim, marginBottom: 4 }}>Equipment claimed from bosses — equip now or later at Your Hold:</div>
            {summary.drops.map((d, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.gold }}>{d.icon} {d.name} <span style={{ fontSize: 12, color: C.text, fontWeight: 400 }}>· {d.desc}</span></div>
                {d.equippedTo ? (
                  <div style={{ fontSize: 12, color: C.umbral, marginTop: 2 }}>✓ Equipped to {HERO_DEFS.find(x => x.id === d.equippedTo)?.name}</div>
                ) : (
                  <div style={{ display: "flex", gap: 4, justifyContent: "center", marginTop: 4, flexWrap: "wrap" }}>
                    {HERO_DEFS.map(h => (
                      <button key={h.id} onClick={() => equipFromSummary(h.id, d)} style={{
                        background: C.panel2, color: C.text, border: `1px solid ${C.gold}44`, borderRadius: 8,
                        padding: "4px 8px", fontSize: 11, cursor: "pointer", fontFamily: "'Alegreya Sans',sans-serif",
                      }}>{h.icon} {h.name}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <Btn full onClick={() => { setSummary(null); setScreen("base"); }}>Return to your Hold</Btn>
    </Shell>
  );

  return <Shell title="Loading..." />;
}
