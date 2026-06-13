import React, { useState, useEffect, useRef, useCallback } from "react";

/* EMBERHOLD — playable prototype.
   Version: see VERSION constant below.
   Patch history: PATCH_NOTES.txt in the repo root. */

const FONT = `@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700;900&family=Alegreya+Sans:wght@400;500;700&display=swap');`;

/* ============================================================
   LEADERBOARD — Firebase Cloud Firestore via REST API
   ------------------------------------------------------------
   Works from a static GitHub Pages deployment with no SDK bundle.
   SETUP (one time):
     1. Create a Firebase project at https://console.firebase.google.com
     2. Build → Firestore Database → Create database (Production mode)
     3. Project settings → General → copy your Project ID
     4. Paste it into FIREBASE_PROJECT_ID below.
     5. Firestore → Rules: allow public read + create on the
        "leaderboard" collection, e.g.:
          rules_version = '2';
          service cloud.firestore {
            match /databases/{db}/documents {
              match /leaderboard/{doc} {
                allow read: if true;
                allow create: if request.resource.data.progress is int
                              && request.resource.data.username is string
                              && request.resource.data.username.size() <= 24;
                allow update, delete: if false;
              }
            }
          }
   Until a project ID is set, the leaderboard UI shows a friendly
   "not configured yet" message and never errors.
   ============================================================ */
const FIREBASE_PROJECT_ID = "emberhold-2bef6"; // Firebase project ID
const LB_ENABLED = () => FIREBASE_PROJECT_ID.length > 0;
const LB_BASE = () => `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

/* submit a player's best progress. Fire-and-forget; never throws. */
async function lbSubmit({ username, progress, label, expeditions }) {
  if (!LB_ENABLED() || !username) return false;
  try {
    const body = {
      fields: {
        username: { stringValue: String(username).slice(0, 24) },
        progress: { integerValue: String(Math.round(progress)) },
        label: { stringValue: String(label).slice(0, 48) },
        expeditions: { integerValue: String(Math.max(0, Math.round(expeditions || 0))) },
        version: { stringValue: VERSION },
        ts: { integerValue: String(Date.now()) },
      },
    };
    const res = await fetch(`${LB_BASE()}/leaderboard`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return res.ok;
  } catch { return false; }
}

/* fetch the top entries, best progress first. Returns [] on any error.
   Keeps only each username's single best score client-side. */
async function lbFetchTop(limit = 25) {
  if (!LB_ENABLED()) return null;
  try {
    const query = {
      structuredQuery: {
        from: [{ collectionId: "leaderboard" }],
        orderBy: [{ field: { fieldPath: "progress" }, direction: "DESCENDING" }],
        limit: 300,
      },
    };
    const res = await fetch(`${LB_BASE()}:runQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query),
    });
    if (!res.ok) return [];
    const rows = await res.json();
    const best = new Map();
    for (const r of rows) {
      const d = r.document?.fields; if (!d) continue;
      const username = d.username?.stringValue || "—";
      const progress = parseInt(d.progress?.integerValue || "0", 10);
      const label = d.label?.stringValue || "";
      const expeditions = parseInt(d.expeditions?.integerValue || "0", 10);
      const prev = best.get(username);
      if (!prev || progress > prev.progress) best.set(username, { username, progress, label, expeditions });
    }
    return [...best.values()].sort((a, b) => b.progress - a.progress).slice(0, limit);
  } catch { return []; }
}

const VERSION = "0.104";

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

/* ---------- ambient music (Web Audio, no external assets) ---------- */
/* Three soft procedural drones: warm "hold", cool "umbral", urgent "combat".
   Each track is a small set of detuned sine pads with slow LFO modulation. */
const MUSIC_TRACKS = {
  hold:    { notes: [98.0, 130.81, 164.81, 196.0],   /* G2 C3 E3 G3 — warm major */ filter: 900, vol: 0.10 },
  umbral:  { notes: [82.41, 110.0, 130.81, 174.61],  /* E2 A2 C3 F3 — minor 7th */  filter: 600, vol: 0.08 },
  combat:  { notes: [73.42, 110.0, 138.59, 207.65],  /* D2 A2 C#3 G#3 — tense */    filter: 1200, vol: 0.09 },
};
class Music {
  constructor() { this.ctx = null; this.nodes = []; this.current = null; this.enabled = false; this.volume = 0.5; this.master = null; this.trackVol = 0; }
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return false; }
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return true;
  }
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(this.trackVol * this.volume, t + 0.2);
    }
  }
  stop() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.nodes.forEach(n => { try { n.gain.gain.cancelScheduledValues(t); n.gain.gain.setValueAtTime(n.gain.gain.value, t); n.gain.gain.linearRampToValueAtTime(0, t + 0.8); n.osc.stop(t + 0.9); n.lfo.stop(t + 0.9); } catch {} });
    setTimeout(() => { this.nodes = []; }, 1000);
    this.current = null;
    this.master = null;
  }
  play(trackName) {
    if (!this.enabled) return;
    if (this.current === trackName) return;
    if (!this.ensure()) return;
    this.stop();
    const track = MUSIC_TRACKS[trackName]; if (!track) return;
    const ctx = this.ctx; const t = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0, t);
    master.gain.linearRampToValueAtTime(track.vol * this.volume, t + 2.5);
    this.master = master;
    this.trackVol = track.vol;
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass"; filt.frequency.value = track.filter;
    filt.connect(master); master.connect(ctx.destination);
    track.notes.forEach((freq, i) => {
      [0, 3].forEach((detune, j) => {
        const osc = ctx.createOscillator();
        osc.type = j === 0 ? "sine" : "triangle";
        osc.frequency.value = freq;
        osc.detune.value = detune * (i % 2 ? 1 : -1);
        const g = ctx.createGain();
        g.gain.value = 0.18 / track.notes.length;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.07 + i * 0.03;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.05;
        lfo.connect(lfoGain).connect(g.gain);
        osc.connect(g).connect(filt);
        osc.start(t); lfo.start(t);
        this.nodes.push({ osc, lfo, gain: g });
      });
    });
    this.current = trackName;
  }
  setEnabled(on) {
    this.enabled = on;
    if (!on) this.stop();
  }
}
const MUSIC = new Music();

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
  { id: "kael", name: "Kaelis", cls: "Blade", icon: "⚔️", baseHp: 85, atk: 15, def: 6, matk: 4, mdef: 5, crit: 5, eva: 12, acc: 95, spd: 14, ultName: "Sever", ultDesc: "Strike focused enemy 3× damage" },
  { id: "syra", name: "Syrene", cls: "Pyromancer", icon: "🔥", baseHp: 70, atk: 6, def: 4, matk: 16, mdef: 12, crit: 12, eva: 8, acc: 92, spd: 12, ultName: "Cinder Nova", ultDesc: "Magic damage to ALL enemies + Burn (0.1×matk dmg/sec, stacks)" },
  { id: "prie", name: "Liora", cls: "Priestess", icon: "🙏", baseHp: 75, atk: 5, def: 5, matk: 12, mdef: 14, crit: 5, eva: 8, acc: 92, spd: 11, ultName: "Sanctuary", ultDesc: "Heal the party for magic attack" },
  { id: "rang", name: "Fenwick", cls: "Ranger", icon: "🏹", baseHp: 80, atk: 14, def: 5, matk: 3, mdef: 6, crit: 15, eva: 14, acc: 97, spd: 18, ultName: "Quickdraw", ultDesc: "Fenwick gains +50% attack speed for 3s" },
  { id: "pala", name: "Aldric", cls: "Paladin", icon: "⚜️", baseHp: 110, atk: 11, def: 10, matk: 8, mdef: 10, crit: 8, eva: 7, acc: 92, spd: 12, ultName: "Consecration", ultDesc: "Party +50% defenses 4s · heal lowest-HP ally for magic attack" },
  { id: "drui", name: "Thornwild", cls: "Druid", icon: "🌿", baseHp: 90, atk: 8, def: 8, matk: 12, mdef: 10, crit: 8, eva: 8, acc: 90, spd: 13, ultName: "Wildkin Bloom", ultDesc: "Focused enemy: -50% atk speed 4s & 0.75×matk dmg · Regrowth: lowest ally heals magic attack over 3s" },
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
      { id: "fang", name: "Ashen Fang", icon: "🗡️", desc: "+12% hero attack", mod: { atkPct: 12 } },
      { id: "idol", name: "Warding Idol", icon: "🗿", desc: "Enemies deal -12% damage", mod: { enemyAtkPct: -12 } },
      { id: "chalice", name: "Ember Chalice", icon: "🏆", desc: "+20 HP heal after each fight", mod: { healAfterFight: 20 } },
      { id: "hourglass", name: "Hourglass of Sol", icon: "⏳", desc: "Ultimates charge 15% faster", mod: { ultPct: 15 } },
      { id: "caravan", name: "Ember Caravan", icon: "🛒", desc: "+15% all resources from fights", mod: { allLootPct: 15 } },
      { id: "wisp", name: "Marshlight Wisp", icon: "✨", desc: "Heroes +5 evasion", mod: { evaFlat: 5 } },
      { id: "phoenix", name: "Phoenix Feather", icon: "🪶", desc: "Auto-revive a fallen hero at 30% HP (stacks ×3)", mod: { phoenix: 1 } },
    ],
    events: [
      { text: "A wounded pilgrim begs for coin. Her eyes glint strangely in the gloom.", a: { label: "Give 20 gold", needGold: 20, fn: s => Math.random() < 0.6 ? { ...s, gold: s.gold - 20, atkMod: s.atkMod + 0.06, blessing: "She whispers a war-blessing: +6% attack this run." } : { ...s, gold: s.gold - 20, blessing: "She takes the coin, mutters, and shuffles off. No blessing comes." } }, b: { label: "Walk past", fn: s => ({ ...s, blessing: "You walk past. Her eyes follow you into the dark. Nothing happens." }) } },
      { text: "A shrine of the old Worldflame flickers above the black water.", a: { label: "Touch the flame", fn: s => Math.random() > 0.8 ? { ...s, atkMod: s.atkMod + 0.1, blessing: "The flame accepts you! +10% attack this run." } : { ...s, teamDmg: 20, blessing: "The flame rejects you. Burned: the party loses 20 HP." } }, b: { label: "Bow and leave", fn: s => ({ ...s, gold: s.gold + 15, blessing: "You bow and find a 15 gold offering at the shrine's base." }) } },
      { text: "An abandoned supply cart sits half-swallowed by marsh roots.", a: { label: "Loot it quickly", fn: s => ({ ...s, wood: s.wood + 30, blessing: "You grab what you can: +30 wood salvaged." }) }, b: { label: "Search thoroughly (risky)", fn: s => Math.random() > 0.5 ? { ...s, wood: s.wood + 30, embers: s.embers + 3, blessing: "Hidden compartment! +30 wood and +3 embers!" } : { ...s, teamDmg: 25, blessing: "Bog hounds were waiting. Ambushed: -25 HP to the party." } } },
      { text: "A drowned chest glimmers beneath the black water.", a: { label: "Dive for it", fn: s => Math.random() > 0.5 ? { ...s, gold: s.gold + 60, blessing: "You wrench it free: +60 gold!" } : { ...s, teamDmg: 20, blessing: "Something pulls back. You escape, but the party loses 20 HP." } }, b: { label: "Leave it", fn: s => ({ ...s, blessing: "Some treasures are bait. You move on, unharmed." }) } },
      { text: "A fen witch offers a bubbling draught from her hut on stilts.", a: { label: "Drink it", fn: s => Math.random() > 0.5 ? { ...s, teamHeal: 40, blessing: "Warmth floods your veins: the party heals 40 HP." } : { ...s, teamDmg: 15, blessing: "It was swamp bile. The party loses 15 HP." } }, b: { label: "Refuse politely", fn: s => ({ ...s, blessing: "She cackles and waves you off. Nothing happens." }) } },
      { text: "Ghost-lights beckon you off the safe path.", a: { label: "Follow the lights", fn: s => Math.random() > 0.5 ? { ...s, embers: s.embers + 3, blessing: "They lead you to a dying flame shard: +3 embers!" } : { ...s, teamDmg: 15, blessing: "A trick of the mire. You stumble through thorns: -15 HP." } }, b: { label: "Stay on the path", fn: s => ({ ...s, gold: s.gold + 10, blessing: "You keep your footing and find a traveler's lost purse: +10 gold." }) } },
    ],
  },
  cave: {
    id: "cave", name: "The Hollowed Deep", emoji: "🕳️",
    basics: [
      E("Cave Spider", "🕷️", 55, 9, 4, 1, 3, 10, 12, 90, 12),
      E("Glowmoth Swarm", "🪲", 40, 5, 2, 8, 4, 8, 16, 92, 14),
      E("Bone Stalker", "💀", 65, 10, 5, 2, 4, 12, 6, 88, 10),
      E("Fungal Sprout", "🍄", 70, 4, 5, 10, 8, 6, 4, 86, 8),
      E("Echo Specter", "👻", 60, 3, 4, 12, 11, 9, 14, 91, 10),
      E("Crystal Wraith", "💎", 75, 5, 6, 13, 13, 10, 8, 89, 9),
      E("Stone Crawler", "🪨", 95, 9, 11, 2, 7, 4, 2, 82, 7),
      E("Cave Drake", "🐲", 80, 12, 7, 4, 6, 11, 5, 87, 10),
      E("Shadow Bat", "🦇", 45, 8, 2, 0, 3, 13, 18, 93, 14),
      E("Deep Worm", "🪱", 100, 8, 9, 3, 7, 5, 3, 84, 8),
    ],
    elites: [
      E("Drake Matron", "🐉", 170, 14, 9, 8, 8, 11, 4, 88, 9),
      E("Crystal Golem", "💠", 200, 11, 14, 6, 12, 7, 3, 85, 7),
      E("Pale Stalker", "🦂", 155, 16, 7, 2, 5, 18, 9, 92, 12),
    ],
    boss: E("The Hollow Sovereign", "👁️", 280, 13, 9, 12, 10, 14, 6, 91, 9),
    relics: [
      { id: "crystalens", name: "Crystal Lens", icon: "🔍", desc: "+10% critical chance", mod: { critFlat: 10 } },
      { id: "lantern", name: "Spelunker's Lantern", icon: "🏮", desc: "+5 accuracy", mod: { accFlat: 5 } },
      { id: "quartz", name: "Vein of Quartz", icon: "💠", desc: "Heroes +4 magic defense", mod: { mdefFlat: 4 } },
      { id: "stalkereye", name: "Stalker's Eye", icon: "👁️", desc: "Heroes +6 evasion", mod: { evaFlat: 6 } },
      { id: "echocharm", name: "Echoing Charm", icon: "🔔", desc: "Ultimates charge 12% faster", mod: { ultPct: 12 } },
      { id: "hoard", name: "Glittering Hoard", icon: "✨", desc: "+30% all resources from fights", mod: { allLootPct: 30 } },
      { id: "phoenix", name: "Phoenix Feather", icon: "🪶", desc: "Auto-revive a fallen hero at 30% HP (stacks ×3)", mod: { phoenix: 1 } },
    ],
    events: [
      { text: "A vast cavern swallows your torchlight. Something distant echoes back.", a: { label: "Call out", fn: s => Math.random() > 0.6 ? { ...s, atkMod: s.atkMod + 0.08, blessing: "The echo returns as a battle-hymn. +8% attack this run." } : { ...s, teamDmg: 20, blessing: "Something heard you. Sharp claws rake the party from the dark: -20 HP." } }, b: { label: "Pass in silence", fn: s => ({ ...s, blessing: "You creep past. The cavern keeps its secrets." }) } },
      { text: "A cluster of corrupted crystals pulses with cold light.", a: { label: "Touch the crystal", fn: s => Math.random() > 0.4 ? { ...s, embers: s.embers + 4, blessing: "Power flows in: +4 embers." } : { ...s, teamDmg: 15, blessing: "Frostburn lances through the party: -15 HP." } }, b: { label: "Carefully harvest a shard (10 wood)", needWood: 10, fn: s => s.wood >= 10 ? { ...s, wood: s.wood - 10, embers: s.embers + 2, blessing: "You pry one loose with a wedge: +2 embers (-10 wood)." } : { ...s, blessing: "Not enough wood for a wedge. You leave them be." } } },
      { text: "A pile of cracked bones surrounds a glinting weapon-hilt.", a: { label: "Take the weapon", fn: s => Math.random() > 0.5 ? { ...s, gold: s.gold + 30, blessing: "Beneath the bones, a fat coinpurse: +30 gold." } : { ...s, teamDmg: 18, blessing: "The bones rise! You drive them back, but the party loses 18 HP." } }, b: { label: "Burn the pile", fn: s => ({ ...s, wood: Math.max(0, s.wood - 5), blessing: "You salt and burn it. -5 wood spent on cleansing rites." }) } },
      { text: "A cave-in blocks the way forward.", a: { label: "Dig through (risk injury)", fn: s => ({ ...s, teamDmg: 12, blessing: "Stone cuts and bruises, but you break through: -12 HP." }) }, b: { label: "Detour (costs 15 wood for braces)", needWood: 15, fn: s => s.wood >= 15 ? { ...s, wood: s.wood - 15, blessing: "Solid bracing. The detour is safe (-15 wood)." } : { ...s, teamDmg: 20, blessing: "Not enough wood. The detour collapses: -20 HP." } } },
      { text: "A grove of pale, glowing mushrooms ripples in unseen wind.", a: { label: "Harvest and brew", fn: s => Math.random() > 0.5 ? { ...s, teamHeal: 35, blessing: "A potent draught. The party heals 35 HP." } : { ...s, teamDmg: 20, blessing: "Worse than poison. The party loses 20 HP." } }, b: { label: "Leave the grove alone", fn: s => ({ ...s, blessing: "Better safe than sorry. You walk wide of the grove." }) } },
      { text: "A weathered statue of a forgotten god kneels in a side chamber.", a: { label: "Make an offering (15 gold)", needGold: 15, fn: s => ({ ...s, gold: s.gold - 15, teamHeal: 25, blessing: "Old eyes stir kindly. The party heals 25 HP." }) }, b: { label: "Pry loose its gem", fn: s => Math.random() > 0.5 ? { ...s, gold: s.gold + 40, blessing: "A fat gemstone tumbles free: +40 gold." } : { ...s, teamDmg: 18, blessing: "The statue's eyes flare. -18 HP and a curse follows you." } } },
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
    bossAdds: [E("Twin-head Ogre", "👹", 160, 11, 7, 2, 5, 9, 3, 86, 8)],
    relics: [
      { id: "wolfsblood", name: "Wolfsblood Vial", icon: "🧪", desc: "Heroes +15% attack speed", mod: { spdPct: 15 } },
      { id: "ironbark", name: "Ironbark Hide", icon: "🛡️", desc: "Heroes +3 defense", mod: { defFlat: 3 } },
      { id: "tanglecharm", name: "Tanglevine Charm", icon: "🌿", desc: "Enemies attack 12% slower", mod: { enemySpdPct: -12 } },
      { id: "hunterseye", name: "Hunter's Eye", icon: "🎯", desc: "Heroes +6 accuracy", mod: { accFlat: 6 } },
      { id: "bounty", name: "Forest Bounty", icon: "🍂", desc: "+20% all resources from fights", mod: { allLootPct: 20 } },
      { id: "phoenix", name: "Phoenix Feather", icon: "🪶", desc: "Auto-revive a fallen hero at 30% HP (stacks ×3)", mod: { phoenix: 1 } },
      { id: "mossheart", name: "Moss Heart", icon: "💚", desc: "+30 HP heal after each fight", mod: { healAfterFight: 30 } },
    ],
    events: [
      { text: "An ogre cookpot bubbles unattended over a great fire.", a: { label: "Steal the stew", fn: s => Math.random() > 0.4 ? { ...s, teamHeal: 30, blessing: "Hearty and hot! The party heals 30 HP." } : { ...s, teamDmg: 20, blessing: "The cook returns mid-bite. You flee with bruises: -20 HP." } }, b: { label: "Tip it over and run", fn: s => ({ ...s, blessing: "Distant roars of ogre fury echo behind you. Worth it." }) } },
      { text: "A wounded wolf pup whimpers in a snare.", a: { label: "Free and tend it (10 gold)", needGold: 10, fn: s => Math.random() < 0.6 ? { ...s, gold: s.gold - 10, atkMod: s.atkMod + 0.06, blessing: "The pack watches from the shadows, then howls. Pack-blessed: +6% attack." } : { ...s, gold: s.gold - 10, blessing: "The pup bolts the moment it is free. The pack stays silent." } }, b: { label: "Leave it", fn: s => ({ ...s, blessing: "Its cries fade behind you. The forest remembers." }) } },
      { text: "An elder treant blocks the path with a riddle.", a: { label: "Answer the riddle", fn: s => Math.random() > 0.4 ? { ...s, embers: s.embers + 4, blessing: "Correct! Its bark splits to reveal +4 embers." } : { ...s, teamDmg: 10, blessing: "Wrong. A branch swats the party: -10 HP." } }, b: { label: "Go around (slow)", fn: s => ({ ...s, wood: s.wood + 10, blessing: "You gather fallen branches on the detour: +10 wood." }) } },
      { text: "Ogres have built a toll bridge over a ravine.", a: { label: "Pay the toll (30 gold)", needGold: 30, fn: s => ({ ...s, gold: s.gold - 30, blessing: "The ogres grunt and let you pass unharmed." }) }, b: { label: "Fight through", fn: s => ({ ...s, teamDmg: 20, gold: s.gold + 20, blessing: "You batter through and loot their toll box: -20 HP, +20 gold." }) } },
      { text: "Golden acorns gleam on a high branch.", a: { label: "Climb for them", fn: s => Math.random() > 0.5 ? { ...s, gold: s.gold + 50, blessing: "A pouch's worth! +50 gold." } : { ...s, teamDmg: 15, blessing: "The branch snaps. -15 HP and wounded pride." } }, b: { label: "Shake the trunk", fn: s => ({ ...s, gold: s.gold + 10, blessing: "A few drop loose: +10 gold." }) } },
      { text: "You find an old hunter's cache beneath a hollow log.", a: { label: "Take the supplies", fn: s => ({ ...s, wood: s.wood + 40, blessing: "Dry timber and rope: +40 wood." }) }, b: { label: "Dig deeper (risky)", fn: s => Math.random() > 0.5 ? { ...s, wood: s.wood + 40, embers: s.embers + 3, blessing: "A buried flame shard! +40 wood, +3 embers." } : { ...s, teamDmg: 15, blessing: "A spring-trap snaps shut: -15 HP." } } },
    ],
  },
};

/* Realms — the world is organized into realms, each containing several
   regions. Defeating the final boss of a realm will (eventually) unlock the
   next realm. For now only the Earthen Realm exists. */
const REALMS = {
  earthen: { id: "earthen", name: "Earthen Realm", icon: "🏔️", regions: ["marsh", "cave", "forest"] },
};
const realmOf = regionId => Object.values(REALMS).find(rl => rl.regions.includes(regionId)) || REALMS.earthen;

/* random modifier applied to all enemy encounters after descending deeper.
   Modifiers STACK — each descent adds one, and all stay active. */
const modsOf = r => (r?.modifiers) || (r?.modifier ? [r.modifier] : []);
const aggMods = r => {
  const out = { enemyHpPct: 0, enemyAtkPct2: 0, enemySpdPct2: 0, heroAccFlat: 0 };
  modsOf(r).forEach(m => { for (const k in m.mod) out[k] = (out[k] || 0) + m.mod[k]; });
  return out;
};
const REGION_ORDER = ["marsh", "cave", "forest"];
const nextRegion = id => REGION_ORDER[REGION_ORDER.indexOf(id) + 1] || null;
const regionIndexOf = id => Math.max(0, REGION_ORDER.indexOf(id));
const DESCENT_MODS = [
  { id: "frenzy", name: "Frenzied Umbral", desc: "Enemies attack 25% faster", mod: { enemySpdPct2: 25 } },
  { id: "hardened", name: "Hardened Hides", desc: "Enemies have +30% HP", mod: { enemyHpPct: 30 } },
  { id: "savage", name: "Savage Hunger", desc: "Enemies deal +20% damage", mod: { enemyAtkPct2: 20 } },
  { id: "mists", name: "Cloying Mists", desc: "Heroes lose 8 accuracy", mod: { heroAccFlat: -8 } },
  { id: "vengeful", name: "Vengeful Spirits", desc: "Enemies +10% critical chance", mod: { enemyCritFlat: 10 } },
  { id: "stoneskin", name: "Stoneskin Blight", desc: "Enemies have +25% defenses", mod: { enemyDefPct: 25 } },
];

/* equipment — drops ONLY from bosses. Each region's boss drops from its own
   2-item pool. Every item has exactly ONE modifier (a future upgrade system
   will add a second modifier at upgrade tier 1). */
const ITEMS = [
  /* marsh */
  { id: "blade", region: "marsh", name: "Heraldbane Blade", icon: "🗡️", desc: "+6 Attack", mod: { atk: 6 } },
  { id: "aegis", region: "marsh", name: "Gloamward Aegis", icon: "🛡️", desc: "+6 Defense", mod: { def: 6 } },
  { id: "veil", region: "marsh", name: "Gloamward Veil", icon: "🧣", desc: "+5 Magic Defense", mod: { mdef: 5 } },
  /* cave */
  { id: "eye", region: "cave", name: "Eye of the Worldflame", icon: "🔮", desc: "+8 Magic Attack", mod: { matk: 8 } },
  { id: "band", region: "cave", name: "Quicksilver Band", icon: "💍", desc: "+4 Attack Speed", mod: { spd: 4 } },
  { id: "sight", region: "cave", name: "Crystalline Sight", icon: "💎", desc: "+6 Critical", mod: { crit: 6 } },
  /* forest */
  { id: "amulet", region: "forest", name: "Emberheart Amulet", icon: "📿", desc: "+30 Max HP", mod: { hp: 30 } },
  { id: "boots", region: "forest", name: "Boots of the Wisp", icon: "🥾", desc: "+10 Evasion", mod: { eva: 10 } },
  { id: "huntmark", region: "forest", name: "Huntmark Talisman", icon: "🎯", desc: "+6 Accuracy", mod: { acc: 6 } },
];

/* ---------- helpers ---------- */
const rnd = a => a[Math.floor(Math.random() * a.length)];
const shuffle = a => [...a].sort(() => Math.random() - 0.5);
const aggRelics = relics => relics.reduce((a, r) => { for (const k in r.mod) a[k] = (a[k] || 0) + r.mod[k]; return a; }, {});

function makeRunGrid(regionId) {
  /* Grid is now 3 rows x (COLS+1) cols. The last col (index COLS) is the
     "final waygate column": row 1 (middle) is ALWAYS a waygate; rows 0 and 2
     are random non-waygate encounters. Every path can choose between healing
     at the waygate or taking the alternate encounter for resources. */
  const grid = Array.from({ length: 3 }, () => Array(COLS + 1).fill("fight"));
  /* required mid-map waygate band: cols 4-7 normally, widened to cols 3-7 in
     regions 2-3 (cave, forest) so the harder regions can offer a recovery
     point one column earlier. */
  const WG_BAND_LO = regionIndexOf(regionId) >= 1 ? 3 : 4;

  // gaps in cols 1 to COLS-1 only (col 0 and col COLS stay fully populated)
  const gapCols = shuffle(Array.from({ length: COLS - 1 }, (_, i) => i + 1)).slice(0, 3);
  shuffle([0, 1, 2]).forEach((row, i) => { if (Math.random() < 0.75) grid[row][gapCols[i]] = null; });

  const fightCells = () => {
    const out = [];
    for (let r = 0; r < 3; r++) for (let c = 1; c < COLS; c++) if (grid[r][c] === "fight") out.push({ r, c });
    return out;
  };

  /* waygates: MAX 3 per map total. The final column (COLS) always holds one
     waygate (its middle row), so we place at most 2 scattered waygates here.
     AT LEAST ONE scattered waygate must be in the required band (cols
     WG_BAND_LO..7). */
  const MAX_WAYGATES = 3;
  const waygateCols = new Set();
  let forcedOne = false;
  for (const { r, c } of shuffle(fightCells())) {
    if (forcedOne) break;
    if (c >= WG_BAND_LO && c <= 7) { grid[r][c] = "waygate"; waygateCols.add(c); forcedOne = true; }
  }
  for (const { r, c } of shuffle(fightCells())) {
    if (waygateCols.size >= MAX_WAYGATES - 1) break; // -1 reserves the final-column waygate
    if (waygateCols.has(c)) continue;
    grid[r][c] = "waygate"; waygateCols.add(c);
  }

  /* shrines: target distribution 68% one, 32% two. Distinct, non-adjacent
     columns. Count is decided up front and exempted from the combat-floor
     conversion below so the distribution is exact. */
  const shrineTarget = Math.random() < 0.90 ? 1 : 2;
  const shrineCols = new Set();
  for (const { r, c } of shuffle(fightCells())) {
    if (shrineCols.size >= shrineTarget) break;
    if (shrineCols.has(c) || shrineCols.has(c - 1) || shrineCols.has(c + 1)) continue;
    grid[r][c] = "shrine"; shrineCols.add(c);
  }

  /* events: target distribution 60% one, 40% two (never three). Count
     decided up front and exempted from the combat-floor conversion. */
  const eventTarget = Math.random() < 0.60 ? 1 : 2;
  const eventCols = new Set();
  for (const { r, c } of shuffle(fightCells())) {
    if (eventCols.size >= eventTarget) break;
    if (eventCols.has(c)) continue;
    grid[r][c] = "event"; eventCols.add(c);
  }

  /* elites in mid-to-late cols */
  for (let r = 0; r < 3; r++) for (let c = 4; c < COLS; c++) {
    if (grid[r][c] === "fight" && Math.random() < 0.22) grid[r][c] = "elite";
  }

  /* FINAL WAYGATE COLUMN (col COLS): middle row is always a waygate. Rows 0
     and 2 are combat only — shrine and event counts are fixed up front, so the
     final column must not add extras. */
  grid[1][COLS] = "waygate";
  grid[0][COLS] = Math.random() < 0.25 ? "elite" : "fight";
  grid[2][COLS] = Math.random() < 0.25 ? "elite" : "fight";

  /* ≥75% combat enforcement. Preserve the middle-row col-COLS waygate AND
     keep ≥1 waygate in cols 4-7 from being converted back to fights. */
  const isCombat = t => t === "fight" || t === "elite";
  const count = () => {
    let combat = 1, total = 1; // boss counts
    for (let r = 0; r < 3; r++) for (let c = 0; c <= COLS; c++) {
      if (!grid[r][c]) continue;
      total++; if (isCombat(grid[r][c])) combat++;
    }
    return { combat, total };
  };
  const collectByType = type => {
    const out = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c <= COLS; c++) if (grid[r][c] === type) out.push({ r, c });
    return out;
  };
  const allWg = collectByType("waygate");
  const wgFinal = ({ r, c }) => r === 1 && c === COLS;
  const wg47 = allWg.filter(({ r, c }) => !wgFinal({ r, c }) && c >= WG_BAND_LO && c <= 7);
  const wgLow = allWg.filter(({ r, c }) => !wgFinal({ r, c }) && c >= 0 && c < WG_BAND_LO);
  /* conversion pool: surplus nodes become fights to reach the combat floor.
     Shrines and events are EXEMPT — their counts were chosen up front (70/30
     for shrines, 60/40 for events) and must stay exact, so only surplus
     waygates convert. Protected: 1 waygate in the required band (cols
     WG_BAND_LO..7) + the final-column waygate. */
  const wgExcess = [...shuffle(wgLow), ...shuffle(wg47).slice(0, Math.max(0, wg47.length - 1))];
  const pool = [...wgExcess];
  let { combat, total } = count();
  while (combat / total < 0.75 && pool.length) {
    const { r, c } = pool.shift();
    grid[r][c] = "fight";
    combat++;
  }

  /* hard guarantees */
  const has = type => grid.some(row => row.some(t => t === type));
  const placeOne = type => {
    const cells = fightCells();
    if (!cells.length) return;
    if (type === "shrine") {
      const usedCols = new Set();
      grid.forEach(row => row.forEach((t, c) => { if (t === "shrine") usedCols.add(c); }));
      for (const { r, c } of shuffle(cells)) {
        if (usedCols.has(c - 1) || usedCols.has(c + 1)) continue;
        grid[r][c] = "shrine"; return;
      }
    }
    const { r, c } = cells[0];
    grid[r][c] = type;
  };
  if (!has("shrine")) placeOne("shrine");
  if (!has("event")) placeOne("event");

  /* defensive — make absolutely sure we have ≥1 waygate in the required band */
  let hasWgBand = false;
  for (let r = 0; r < 3; r++) for (let c = WG_BAND_LO; c <= 7; c++) if (grid[r][c] === "waygate") hasWgBand = true;
  if (!hasWgBand) {
    const bandCols = []; for (let c = WG_BAND_LO; c <= 7; c++) bandCols.push(c);
    outer: for (const c of shuffle(bandCols)) {
      for (const r of shuffle([0, 1, 2])) {
        if (grid[r][c] === "fight") { grid[r][c] = "waygate"; break outer; }
      }
    }
  }

  /* never allow a player to pick waygates three columns in a row. The final
     column (COLS) always holds a waygate, so scan for any 3 consecutive
     columns that each contain a waygate and demote the middle column's
     waygate(s) to fights. */
  const colHasWaygate = c => grid.some(row => row[c] === "waygate");
  for (let c = 0; c + 2 <= COLS; c++) {
    if (colHasWaygate(c) && colHasWaygate(c + 1) && colHasWaygate(c + 2)) {
      for (let r = 0; r < 3; r++) if (grid[r][c + 1] === "waygate") grid[r][c + 1] = "fight";
    }
  }

  /* HARD CAP: at most 3 waygates per map. The final-column waygate is always
     kept; demote any extras (lowest columns first) to fights. */
  const allWaygates = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c <= COLS; c++) if (grid[r][c] === "waygate") allWaygates.push({ r, c });
  if (allWaygates.length > 3) {
    const removable = allWaygates
      .filter(({ r, c }) => !(r === 1 && c === COLS)) // protect the final waygate
      .sort((a, b) => a.c - b.c); // demote earliest columns first
    let excess = allWaygates.length - 3;
    for (const { r, c } of removable) {
      if (excess <= 0) break;
      grid[r][c] = "fight"; excess--;
    }
  }

  /* HARD CAP: at most 2 shrines per map. Demote extras (latest columns
     first) to fights. */
  const allShrines = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c <= COLS; c++) if (grid[r][c] === "shrine") allShrines.push({ r, c });
  if (allShrines.length > 2) {
    const extra = allShrines.sort((a, b) => b.c - a.c).slice(0, allShrines.length - 2);
    for (const { r, c } of extra) grid[r][c] = "fight";
  }

  return grid;
}

function makeEnemies(regionId, type, depth, modifiers) {
  const reg = REGIONS[regionId];
  /* REGION POWER: each region multiplies enemy strength — marsh 1×,
     cave 2×, forest 2.5×. Future regions continue the climb (region 4
     ≈ 3.5×+). The game gets harder as you progress. On top of that,
     base depth scaling plus a random ~2% compounding bump per depth. */
  const REGION_POWER = { marsh: 1, cave: 2, forest: 2.5 };
  const regionPower = REGION_POWER[regionId] || (regionIndexOf(regionId) + 1);
  let scale = (1 + depth * 0.10) * regionPower;
  for (let d = 0; d < depth; d++) scale *= 1 + 0.02 * (0.5 + Math.random());
  /* descent modifiers multiply the fully depth-scaled stats */
  const dm = aggMods({ modifiers: modifiers || [] });
  const hpMod = 1 + (dm.enemyHpPct / 100);
  const atkMod = 1 + (dm.enemyAtkPct2 / 100);
  const defMod = 1 + ((dm.enemyDefPct || 0) / 100);
  const critAdd = dm.enemyCritFlat || 0;
  const mk = base => {
    const hp = Math.round(base.hp * ENEMY_HP_MUL * scale * hpMod);
    return {
      ...base, key: base.name + Math.random().toString(36).slice(2),
      hp, maxHp: hp, gauge: 0,
      atk: Math.round(base.atk * scale * atkMod), matk: Math.round(base.matk * scale * atkMod),
      def: Math.round(base.def * scale * defMod), mdef: Math.round(base.mdef * scale * defMod),
      crit: base.crit + critAdd,
    };
  };
  if (type === "boss") {
    const out = [mk(reg.boss), ...(reg.bossAdds || []).map(mk)];
    /* chance of basic-enemy reinforcements at region bosses:
       Herald of Gloaming - 10% chance of 1 add
       Hollow Sovereign - 10% chance of 2 adds, else 25% chance of 1 add */
    const roll = Math.random();
    if (regionId === "marsh" && roll < 0.10) out.push(mk(rnd(reg.basics)));
    if (regionId === "cave") {
      if (roll < 0.10) { out.push(mk(rnd(reg.basics)), mk(rnd(reg.basics))); }
      else if (roll < 0.35) { out.push(mk(rnd(reg.basics))); }
    }
    return out;
  }
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

/* Build an ultimate description with the caster's CURRENT magic-attack values
   substituted in, instead of the generic "matk" placeholder. `matk` should be
   the hero's effective magic attack at the point of display; an optional
   `mult` applies run/ult scaling so the number matches live combat. */
function ultDescLive(h, matk, mult = 1) {
  const m = Math.round((matk ?? h.matk) * mult);
  switch (h.id) {
    case "syra": {
      const burn = Math.max(1, Math.floor(0.1 * m));
      return `Magic damage to ALL enemies + Burn (${burn} dmg/sec, stacks)`;
    }
    case "prie":
      return `Heal the party for ${m} HP`;
    case "pala":
      return `Party +50% defenses 4s · heal lowest-HP ally for ${m} HP`;
    case "drui":
      return `Focused enemy: -50% atk speed 4s & ${Math.round(0.75 * m)} dmg · Regrowth: lowest ally heals ${m} over 3s`;
    default:
      return h.ultDesc;
  }
}

/* effective stats — apply every active modifier so tooltips show what
   actually goes into combat math, not just base values */
function effectiveHero(h, r, b) {
  if (!h) return h;
  const ag = aggRelics(r?.relics || []);
  const dm = aggMods(r);
  const tick = b?.tick || 0;
  const atkMul = (1 + (r?.atkMod || 0)) * (1 + (ag.atkPct || 0) / 100);
  const accAdj = (ag.accFlat || 0) + (dm.heroAccFlat || 0);
  const defAdj = ag.defFlat || 0;
  const spdMul = 1 + (ag.spdPct || 0) / 100;
  const hasteOn = b && h.id === "rang" && tick < (b.hasteUntil || 0);
  const tauntOn = b && h.id === "bran" && tick < (b.tauntUntil || 0);
  return {
    ...h,
    atk: Math.round(h.atk * atkMul),
    matk: Math.round(h.matk * atkMul),
    def: Math.round((h.def + defAdj) * (tauntOn ? 2 : 1)),
    mdef: Math.round((h.mdef + (ag.mdefFlat || 0)) * (tauntOn ? 2 : 1)),
    crit: h.crit + (ag.critFlat || 0),
    eva: h.eva + (ag.evaFlat || 0),
    acc: h.acc + accAdj,
    spd: Math.round(h.spd * spdMul * (hasteOn ? 1.5 : 1)),
    ultPerAtk: Math.round(20 * (1 + (ag.ultPct || 0) / 100)),
  };
}
function effectiveEnemy(e, r, b) {
  if (!e) return e;
  const ag = aggRelics(r?.relics || []);
  const tick = b?.tick || 0;
  const atkMul = 1 + (ag.enemyAtkPct || 0) / 100;
  const spdMul = 1 + (ag.enemySpdPct || 0) / 100;
  const slowed = b && e.key === b.slowedKey && tick < (b.slowUntil || 0);
  return {
    ...e,
    atk: Math.round(e.atk * atkMul),
    matk: Math.round(e.matk * atkMul),
    spd: Math.round(e.spd * spdMul * (slowed ? 0.5 : 1)),
  };
}

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
  ["Ult Charge", u => u.ultName ? `${Math.round(u.ult || 0)}%` : null],
  ["Ult/Atk", u => u.ultName ? `${u.ultPerAtk ?? 20}%` : null],
];

function StatCard({ unit, idKey, pinned, setPinned, hovered, setHovered, children, style, onClick, dir = "up", clickOnly = false, noIcon = false }) {
  /* mobile-first: stats are tap-to-toggle everywhere (no hover dependency).
     Bigger tap target on the ⓘ; tapping the open card dismisses it. */
  const show = pinned === idKey;
  const place = dir === "down" ? { top: "calc(100% + 6px)" } : { bottom: "calc(100% + 6px)" };
  return (
    <div onClick={onClick} style={{ position: "relative", ...style }}>
      {children}
      {!noIcon && <div
        onClick={e => { e.stopPropagation(); setPinned(p => (p === idKey ? null : idKey)); }}
        style={{ position: "absolute", top: 0, right: 0, fontSize: 17, color: show ? C.gold : C.dim, cursor: "pointer", padding: "8px 10px", lineHeight: 1, touchAction: "manipulation" }}
        title="Show stats"
      >ⓘ</div>}
      {show && (
        <div
          onClick={e => { e.stopPropagation(); setPinned(null); }}
          style={{
          position: "absolute", ...place, left: "50%", transform: "translateX(-50%)",
          background: "#0d0a14", border: `1px solid ${C.gold}66`, borderRadius: 10, padding: "12px 14px",
          zIndex: 50, width: 170, boxShadow: "0 6px 18px #000a", cursor: "pointer",
        }}>
          <div style={{ fontFamily: "'Cinzel',serif", fontWeight: 700, fontSize: 12, color: C.gold, marginBottom: 6, textAlign: "center" }}>{unit.name}</div>
          {STAT_ROWS.map(([label, fn]) => {
            const v = fn(unit);
            if (v === null || v === undefined) return null;
            return (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.text, lineHeight: 1.7 }}>
                <span style={{ color: C.dim }}>{label}</span><span>{v}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ================= MAIN ================= */
export default function Emberhold() {
  /* persistent (saved to localStorage) */
  const [res, setRes] = usePersistent("res", { gold: 100, wood: 60, embers: 4 });
  const [bld, setBld] = usePersistent("bld", { forge: 1, barracks: 1, arcanum: 1, shard: 1 });
  const [runsDone, setRunsDone] = usePersistent("runsDone", 0);
  const [username, setUsername] = usePersistent("username", "");
  const [bestProgress, setBestProgress] = usePersistent("bestProgress", { progress: 0, label: "" });
  const [forestUnlocked, setForestUnlocked] = usePersistent("forestUnlocked", false);
  const [caveUnlocked, setCaveUnlocked] = usePersistent("caveUnlocked", false);
  const [items, setItems] = usePersistent("items", []);
  const [equips, setEquips] = usePersistent("equips", {});
  const [party, setParty] = usePersistent("party", ["bran", "kael", "syra"]);
  /* heroes who died last expedition must recover one expedition before they
     can be selected again. benched is {heroId: expeditionsRemaining}. */
  const [benched, setBenched] = usePersistent("benched", {});
  /* last descent modifier id is excluded from the next descent roll —
     prevents back-to-back repeats and the player feeling like only one
     modifier ever comes up */
  const [lastModifierId, setLastModifierId] = usePersistent("lastModifierId", null);
  const [equipPicker, setEquipPicker] = useState(null);

  /* run state (persisted so reloading doesn't reset the map). Battle state is
     intentionally NOT persisted — reloading mid-combat just resumes the fight
     from the map. */
  const [screen, setScreenRaw] = usePersistent("screen", "base");
  const [run, setRunRaw] = usePersistent("run", null);
  const setScreen = s => { setScreenRaw(s); };
  const setRun = r => { setRunRaw(r); };
  const [battle, setBattle] = useState(null);
  const [pendingRelics, setPendingRelics] = usePersistent("pendingRelics", null);
  const [eventCard, setEventCard] = usePersistent("eventCard", null);
  const [eventResult, setEventResult] = usePersistent("eventResult", null);
  const [summary, setSummary] = usePersistent("summary", null);
  const [combatReview, setCombatReview] = usePersistent("combatReview", null);
  const [floats, setFloats] = useState([]);
  const [legendOpen, setLegendOpen] = useState(true);
  const [resetArmed, setResetArmed] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [lbRows, setLbRows] = useState(null);     // null = loading, [] = empty, [...] = data, undefined string handled in UI
  const [lbLoading, setLbLoading] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [pinned, setPinned] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [showMap, setShowMap] = useState(false);
  const [logDetail, setLogDetail] = useState(false);
  const [musicOn, setMusicOn] = usePersistent("musicOn", false);
  const [musicVol, setMusicVol] = usePersistent("musicVol", 0.5);

  useEffect(() => { MUSIC.setVolume(musicVol); }, [musicVol]);

  /* Full reset that works in EVERY environment — including sandboxed
     contexts (e.g. the Claude app) where localStorage and location.reload()
     may be blocked. We reset all React state to defaults directly so the
     button never silently fails, then also clear the save and attempt a
     reload for normal browsers. */
  const resetHold = () => {
    setRes({ gold: 100, wood: 60, embers: 4 });
    setBld({ forge: 1, barracks: 1, arcanum: 1, shard: 1 });
    setRunsDone(0);
    setForestUnlocked(false);
    setCaveUnlocked(false);
    setItems([]);
    setEquips({});
    setParty(["bran", "kael", "syra"]);
    setBenched({});
    setLastModifierId(null);
    setRun(null);
    setBattle(null);
    setPendingRelics(null);
    setEventCard(null);
    setEventResult(null);
    setSummary(null);
    setCombatReview(null);
    setEquipPicker(null);
    setScreen("base");
    clearSave();
    try { location.reload(); } catch {}
  };

  /* ---- leaderboard helpers ----
     progress score: regionIndex * 1000 + (depth reached), with a +500 bonus
     for clearing a region's boss, so "boss of cave" outranks "deep in cave"
     but ranks below "any progress in forest". Higher = further. */
  const computeProgress = (regionId, depth, bossKilled) => {
    const ri = regionIndexOf(regionId);
    return ri * 1000 + Math.max(0, depth) * 10 + (bossKilled ? 500 : 0);
  };
  const progressLabel = (regionId, depth, bossKilled) => {
    const name = REGIONS[regionId]?.name || regionId;
    if (bossKilled) {
      const last = !nextRegion(regionId);
      return last ? `${name} — realm cleared! 🏆` : `${name} — boss defeated`;
    }
    return `${name} — depth ${Math.max(1, depth + 1)}`;
  };
  /* record a new run result and push to the board if it's a personal best */
  const recordProgress = (regionId, depth, bossKilled, expeditions) => {
    const progress = computeProgress(regionId, depth, bossKilled);
    const label = progressLabel(regionId, depth, bossKilled);
    if (progress > (bestProgress.progress || 0)) {
      setBestProgress({ progress, label, expeditions });
      if (username) lbSubmit({ username, progress, label, expeditions });
    }
  };
  const loadLeaderboard = async () => {
    setLbLoading(true);
    const rows = await lbFetchTop(25);
    setLbRows(rows);
    setLbLoading(false);
  };

  useEffect(() => {
    MUSIC.setEnabled(musicOn);
    if (!musicOn) return;
    const track =
      screen === "base" ? "hold" :
      screen === "battle" ? "combat" :
      "umbral";
    MUSIC.play(track);
  }, [screen, musicOn]);

  const BUILDINGS = [
    { id: "forge", name: "Forge", icon: "⚒️", desc: "+12% hero attack & magic attack / level", cost: l => ({ gold: 45 * l, wood: 30 * l }) },
    { id: "barracks", name: "Barracks", icon: "🏰", desc: "+15% hero HP & +5% defenses / level", cost: l => ({ gold: 50 * l, wood: 40 * l }) },
    { id: "arcanum", name: "Arcanum", icon: "🔮", desc: "+8% ult charge speed / level", cost: l => ({ gold: 80 * l, embers: 2 * l }) },
    { id: "shard", name: "Worldflame Shard", icon: "🔥", desc: "+10% all loot / level", cost: l => ({ embers: 4 * l, wood: 50 * l }) },
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
      def: Math.round(h.def * (1 + 0.05 * (bld.barracks - 1))) + (m.def || 0),
      mdef: Math.round(h.mdef * (1 + 0.05 * (bld.barracks - 1))) + (m.mdef || 0),
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
      regionId: "marsh", modifier: null, modifiers: [], drops: [],
      grid: makeRunGrid("marsh"), pos: null, visited: [],
      heroes, gold: 0, wood: 0, embers: 0, relics: [], atkMod: 0, phoenixSpent: 0, lastEventText: null,
      corruptionBaseline: 0,
    });
    setScreen("map");
  };

  const depthOf = r => (r.pos ? (r.pos.boss ? COLS + 1 : r.pos.col) : -1);

  const candidatesOf = r => {
    if (!r.pos) return [0, 1, 2].filter(row => r.grid[row][0]).map(row => ({ row, col: 0 }));
    if (r.pos.boss) return [];
    if (r.pos.col === COLS) return [{ boss: true }];
    return [r.pos.row - 1, r.pos.row, r.pos.row + 1]
      .filter(row => row >= 0 && row < 3 && r.grid[row][r.pos.col + 1])
      .map(row => ({ row, col: r.pos.col + 1 }));
  };

  const chooseNode = cand => {
    setPinned(null);
    setShowMap(false);
    const r = runRef.current;
    const type = cand.boss ? "boss" : r.grid[cand.row][cand.col];
    /* backup guard: never allow a relic pick immediately after a relic pick */
    if (type === "shrine" && r.lastType === "shrine") return;
    const visited = r.pos && !r.pos.boss ? [...r.visited, `${r.pos.row}-${r.pos.col}`] : r.visited;
    const r2 = { ...r, pos: cand, visited, lastType: type };
    setRun(r2);
    const depth = cand.boss ? COLS + 1 : cand.col;

    if (type === "fight" || type === "elite" || type === "boss") {
      /* attack charge starts fresh each fight */
      setRun({ ...r2, heroes: r2.heroes.map(h => ({ ...h, gauge: 0 })) });
      const enemies = makeEnemies(r2.regionId, type, depth, modsOf(r2));
      setBattle({ enemies, type, log: [{ text: "The enemy blocks your path. Steel yourselves...", level: "major" }], focus: enemies[0].key, surge: null, tick: 0, started: false, enraged: false, tauntUntil: 0, hasteUntil: 0, slowUntil: 0, slowedKey: null, consecUntil: 0, hotHeroId: null, hotUntil: 0, hotPerSec: 0 });
      setScreen("battle");
    } else if (type === "shrine") {
      const pool = REGIONS[r2.regionId].relics.filter(x =>
        x.id === "phoenix"
          ? r2.relics.filter(y => y.id === "phoenix").length < 3
          : !r2.relics.find(y => y.id === x.id));
      const opts = [];
      while (opts.length < Math.min(3, pool.length)) { const x = rnd(pool); if (!opts.includes(x)) opts.push(x); }
      setPendingRelics(opts); setScreen("relic");
    } else if (type === "event") {
      {
        const pool = REGIONS[r2.regionId].events.filter(ev => ev.text !== r2.lastEventText);
        const card = rnd(pool.length ? pool : REGIONS[r2.regionId].events);
        setRun({ ...r2, lastEventText: card.text });
        setEventCard(card);
      }
      setScreen("event");
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
      const dm = aggMods(r);
      let heroes = r.heroes.map(h => ({ ...h }));
      let enemies = b.enemies.map(e => ({ ...e }));
      let log = [...b.log];
      let surge = b.surge ? { ...b.surge } : null;
      const tick = b.tick + 1;
      let phoenixSpent = r.phoenixSpent || (r.phoenixUsed ? 1 : 0);

      /* ENRAGE (boss fights): every boss enrages if the fight drags past
         ENRAGE_SECS (anti-stall). The Ogre King ALSO enrages early when it
         drops below ENRAGE_HP_PCT — a signature desperate phase for the
         realm's final boss. While enraged, all enemies in the fight gain
         +50% attack and +30% attack speed, and Umbral Surges wind up faster. */
      const ENRAGE_SECS = 45, ENRAGE_HP_PCT = 0.30;
      let enraged = b.enraged || false;
      if (b.type === "boss" && !enraged) {
        const boss = enemies[0];
        const byTime = tick >= ENRAGE_SECS * 4;
        const byHp = r.regionId === "forest" && boss && boss.maxHp > 0 && boss.hp > 0 && boss.hp / boss.maxHp <= ENRAGE_HP_PCT;
        if (byTime || byHp) {
          enraged = true;
          log.push({ text: `😡 ${enemies[0]?.name || "The boss"} ENRAGES — ${byHp ? "wounded and furious" : "tired of your defiance"}!`, level: "major" });
          addFloat("😡 ENRAGED", C.red);
        }
      }
      const enrageAtk = enraged ? 1.5 : 1;
      const enrageSpd = enraged ? 1.3 : 1;

      const atkMul = (1 + r.atkMod) * (1 + (ag.atkPct || 0) / 100);
      const eAtkMul = 1 + (ag.enemyAtkPct || 0) / 100; /* descent atk modifier is baked into enemy stats multiplicatively */
      const ultGain = ULT_PER_ATTACK * (1 + 0.08 * (bld.arcanum - 1)) * (1 + (ag.ultPct || 0) / 100);
      const heroSpdBase = 1 + (ag.spdPct || 0) / 100;
      const enemySpdBase = (1 + (ag.enemySpdPct || 0) / 100) * (1 + (dm.enemySpdPct2 || 0) / 100);
      const accAdj = (ag.accFlat || 0) + (dm.heroAccFlat || 0);
      const defAdj = ag.defFlat || 0;

      /* heroes: attack when gauge fills; each attack SWING charges the ult.
         Quickdraw haste applies ONLY to Fenwick.
         Targeting: the focused enemy if one is set and alive; otherwise a
         RANDOM living enemy (re-rolled per swing), so attacks spread out
         instead of all piling onto the first enemy in the list. */
      const focusTarget = () => {
        const focused = enemies.find(e => e.key === b.focus && e.hp > 0);
        if (focused) return focused;
        const live = enemies.filter(e => e.hp > 0);
        return live.length ? rnd(live) : null;
      };
      heroes.forEach(h => {
        if (!h.alive) return;
        const haste = h.id === "rang" && tick < b.hasteUntil ? 1.5 : 1;
        h.gauge = (h.gauge || 0) + h.spd * heroSpdBase * haste;
        if (h.gauge >= 100) {
          h.gauge -= 100;
          h.ult = Math.min(100, h.ult + ultGain);
          const t = focusTarget();
          if (t) {
            if (rollHit({ ...h, acc: h.acc + accAdj }, t)) {
              const { dmg, crit } = rollDamage({ ...h, atk: Math.round(h.atk * atkMul), matk: Math.round(h.matk * atkMul), crit: h.crit + (ag.critFlat || 0) }, t, 1);
              t.hp -= dmg;
              if (crit) addFloat(`CRIT -${dmg}`, C.gold);
              log.push({ text: `${h.icon} ${h.name} ${crit ? "CRITS" : "hits"} ${t.name} for ${dmg}${t.hp <= 0 ? " — felled!" : ""}`, level: "detail" });
            } else { addFloat("MISS", C.dim); log.push({ text: `${h.icon} ${h.name} misses ${t.name}`, level: "detail" }); }
          }
        }
      });

      /* enemies: attack gauge; Entangle slows ONLY the marked target; taunt redirects to Branwen */
      enemies.filter(e => e.hp > 0).forEach(e => {
        const slowed = e.key === b.slowedKey && tick < b.slowUntil ? 0.5 : 1;
        e.gauge = (e.gauge || 0) + e.spd * enemySpdBase * slowed * enrageSpd;
        if (e.gauge >= 100) {
          e.gauge -= 100;
          const live = heroes.filter(h => h.alive);
          if (!live.length) return;
          const bran = heroes.find(h => h.id === "bran" && h.alive);
          const t = (tick < b.tauntUntil && bran) ? bran : rnd(live);
          const td = { ...t, def: t.def + defAdj, mdef: t.mdef + (ag.mdefFlat || 0), eva: t.eva + (ag.evaFlat || 0) };
          if (t.id === "bran" && tick < b.tauntUntil) { td.def *= 2; td.mdef *= 2; } /* Taunt doubles his defenses */
          if (tick < (b.consecUntil || 0)) { td.def = Math.round(td.def * 1.5); td.mdef = Math.round(td.mdef * 1.5); } /* Consecration */
          if (rollHit(e, td)) {
            const { dmg, crit } = rollDamage({ ...e, atk: Math.round(e.atk * eAtkMul * enrageAtk), matk: Math.round(e.matk * eAtkMul * enrageAtk) }, td, 1);
            t.hp -= dmg;
            if (crit) addFloat(`-${dmg} CRIT!`, C.red);
            log.push({ text: `${e.icon} ${e.name} ${crit ? "CRITS" : "hits"} ${t.name} for ${dmg}`, level: "detail" });
          } else { addFloat("DODGED", C.umbral); log.push({ text: `${t.name} dodges ${e.name}`, level: "detail" }); }
        }
      });

      /* UMBRAL SURGE quick-time event */
      if (surge) {
        /* if the enemy charging the surge dies mid-windup (hero hit, burn,
           DoT), the surge fizzles — cancel it and clear the BRACE prompt */
        const charger = enemies.find(e => e.key === surge.enemyKey);
        if (!charger || charger.hp <= 0) {
          log.push({ text: "💨 The winding-up enemy fell — the surge dissipates.", level: "major" });
          surge = null;
        } else {
          surge.ticksLeft -= 1;
          if (surge.ticksLeft <= 0) {
            const src = charger;
            const live = heroes.filter(h => h.alive);
            if (live.length) {
              const bran = heroes.find(h => h.id === "bran" && h.alive);
              const t = (tick < b.tauntUntil && bran) ? bran : rnd(live);
              const td = { ...t, def: t.def + defAdj, mdef: t.mdef + (ag.mdefFlat || 0), eva: t.eva + (ag.evaFlat || 0) };
              if (t.id === "bran" && tick < b.tauntUntil) { td.def *= 2; td.mdef *= 2; } /* Taunt doubles his defenses */
              if (tick < (b.consecUntil || 0)) { td.def = Math.round(td.def * 1.5); td.mdef = Math.round(td.mdef * 1.5); } /* Consecration */
              const { dmg: raw } = rollDamage({ ...src, atk: Math.round(src.atk * eAtkMul * enrageAtk), matk: Math.round(src.matk * eAtkMul * enrageAtk), crit: 0 }, td, 3);
              const dmg = surge.braced ? Math.round(raw * 0.3) : raw;
              t.hp -= dmg;
              log.push({ text: surge.braced ? `🛡️ BRACED! ${t.name} takes only ${dmg}` : `💥 Surge hits ${t.name} for ${dmg}!`, level: "major" });
              addFloat(surge.braced ? `-${dmg} 🛡️` : `-${dmg}!`, surge.braced ? C.umbral : C.red);
            }
            surge = null;
          }
        }
      } else if (tick > 16 && tick % (enraged ? 24 : 36) === 0) {
        const live = enemies.filter(e => e.hp > 0);
        if (live.length) {
          surge = { enemyKey: rnd(live).key, ticksLeft: 8, braced: false };
          log.push({ text: "⚠️ An enemy is winding up a heavy attack — BRACE!", level: "major" });
        }
      }

      /* burn DoT — generic: any unit with .burn ticks 3 dmg/sec per stack */
      if (tick % 4 === 0) {
        enemies.forEach(e => { if (e.hp > 0 && (e.burnDps || 0) > 0) e.hp -= e.burnDps; });
        heroes.forEach(h => { if (h.alive && (h.burnDps || 0) > 0) h.hp -= h.burnDps; });
        /* Regrowth heal-over-time (Wildkin Bloom) */
        if (tick < (b.hotUntil || 0) && b.hotHeroId) {
          const hh = heroes.find(x => x.id === b.hotHeroId && x.alive);
          if (hh) hh.hp = Math.min(hh.maxHp, hh.hp + (b.hotPerSec || 0));
        }
      }

      /* deaths */
      heroes.forEach(h => {
        if (h.alive && h.hp <= 0) {
          if ((ag.phoenix || 0) > phoenixSpent) {
            h.hp = Math.round(h.maxHp * 0.3); phoenixSpent++;
            log.push({ text: `🪶 A Phoenix Feather ignites — ${h.name} rises from the ashes! (${(ag.phoenix || 0) - phoenixSpent} left)`, level: "major" });
          } else { h.alive = false; h.hp = 0; log.push({ text: `☠️ ${h.name} has fallen!`, level: "major" }); }
        }
      });
      enemies.forEach(e => { e.hp = Math.max(0, e.hp); });

      const won = enemies.every(e => e.hp <= 0);
      const lost = heroes.every(h => !h.alive);

      setRun({ ...r, heroes, phoenixSpent });
      setBattle({ ...b, enemies, log, surge, tick, enraged });

      if (won) { clearInterval(iv); winFight({ ...r, heroes, phoenixSpent }, heroes, b.type, log); }
      else if (lost) { clearInterval(iv); finishRun({ ...r, heroes }, false); }
    }, TICK_MS);
    return () => clearInterval(iv);
  }, [screen, battle?.type, battle?.started]); // eslint-disable-line

  /* --- player actions --- */
  const startFight = () => {
    const b = battleRef.current;
    if (b) setBattle({ ...b, started: true, log: [{ text: "⚔️ The clash begins!", level: "major" }] });
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
    let { tauntUntil, hasteUntil, slowUntil, slowedKey, consecUntil = 0, hotHeroId = null, hotUntil = 0, hotPerSec = 0 } = b;
    const ag = aggRelics(r.relics);
    const atkMul = (1 + r.atkMod) * (1 + (ag.atkPct || 0) / 100);
    /* ultimates scale +2% per depth (damage, healing, and durations) */
    const ultScale = 1 + 0.02 * Math.max(0, depthOf(r));

    if (h.id === "bran") { tauntUntil = b.tick + Math.round(8 * ultScale); log.push({ text: "🛡️ TAUNT! All eyes on Branwen — defenses doubled", level: "major" }); addFloat("🛡️ TAUNT", C.blue); }
    if (h.id === "kael") {
      const live = enemies.filter(e => e.hp > 0);
      if (live.length) {
        const t = enemies.find(e => e.key === b.focus && e.hp > 0) || live.reduce((a, c) => a.hp > c.hp ? a : c);
        const { dmg } = rollDamage({ ...h, atk: Math.round(h.atk * atkMul) }, t, 3 * ultScale);
        t.hp = Math.max(0, t.hp - dmg);
        log.push({ text: `⚔️ Sever! ${dmg} damage`, level: "major" }); addFloat(`-${dmg} ⚔️`, C.ember);
      }
    }
    if (h.id === "syra") {
      const effMatk = Math.round(h.matk * atkMul);
      /* Burn dps scales with magic attack: 0.1 × matk per cast (rounded down),
         minimum 1. Tracked as accumulated dps so sources can differ. */
      const burnPerCast = Math.max(1, Math.floor(0.1 * effMatk));
      enemies = enemies.map(e => {
        if (e.hp <= 0) return e;
        const { dmg } = rollDamage({ ...h, matk: effMatk }, e, 2 * ultScale);
        return { ...e, hp: Math.max(0, e.hp - dmg), burnDps: (e.burnDps || 0) + burnPerCast, burnStacks: (e.burnStacks || 0) + 1 };
      });
      log.push({ text: `🔥 Cinder Nova engulfs all foes — they BURN (+${burnPerCast}/sec)!`, level: "major" }); addFloat("🔥 NOVA", C.ember);
    }
    if (h.id === "prie") {
      const heal = Math.round(h.matk * atkMul * ultScale);
      heroes = heroes.map(x => x.alive ? { ...x, hp: Math.min(x.maxHp, x.hp + heal) } : x);
      log.push({ text: `🙏 Sanctuary! Party healed +${heal}`, level: "major" }); addFloat(`+${heal} ❤️`, C.green);
    }
    if (h.id === "rang") { hasteUntil = b.tick + Math.round(12 * ultScale); log.push({ text: "🏹 Quickdraw! Fenwick attacks 50% faster", level: "major" }); addFloat("🏹 HASTE", C.blue); }
    if (h.id === "pala") {
      consecUntil = b.tick + Math.round(16 * ultScale);
      const heal = Math.round(h.matk * atkMul * ultScale);
      const living = heroes.map((x, i) => ({ x, i })).filter(v => v.x.alive);
      let healedName = "";
      if (living.length) {
        const lowest = living.reduce((a, c) => (c.x.hp / c.x.maxHp) < (a.x.hp / a.x.maxHp) ? c : a);
        heroes[lowest.i] = { ...heroes[lowest.i], hp: Math.min(heroes[lowest.i].maxHp, heroes[lowest.i].hp + heal) };
        healedName = heroes[lowest.i].name;
      }
      log.push({ text: `⚜️ Consecration! Party defenses +50%${healedName ? ` · ${healedName} +${heal} HP` : ""}`, level: "major" });
      addFloat("⚜️ CONSECRATE", C.gold);
    }
    if (h.id === "drui") {
      const live = enemies.filter(e => e.hp > 0);
      const t = enemies.find(e => e.key === b.focus && e.hp > 0) || (live.length ? rnd(live) : null);
      if (t) {
        slowedKey = t.key; slowUntil = b.tick + Math.round(16 * ultScale);
        const effMatk = Math.round(h.matk * atkMul * ultScale);
        const dmg = Math.round(0.75 * effMatk);
        const targetIdx = enemies.findIndex(e => e.key === t.key);
        enemies[targetIdx] = { ...enemies[targetIdx], hp: Math.max(0, enemies[targetIdx].hp - dmg) };
        /* Regrowth: heal-over-time on the lowest-HP ally — total = magic attack,
           spread over 3 seconds (ticks every 4th tick = ~3 ticks). */
        const livingHeroes = heroes.map((h2, i2) => ({ h: h2, i: i2 })).filter(x => x.h.alive);
        if (livingHeroes.length) {
          const lowest = livingHeroes.reduce((a, c) => (c.h.hp / c.h.maxHp) < (a.h.hp / a.h.maxHp) ? c : a);
          hotHeroId = heroes[lowest.i].id;
          hotUntil = b.tick + Math.round(12 * ultScale);
          hotPerSec = Math.max(1, Math.round(effMatk / 3));
          log.push({ text: `🌿 Wildkin Bloom! ${t.name} -${dmg} & slowed · Regrowth on ${heroes[lowest.i].name} (+${hotPerSec}/sec)`, level: "major" });
          addFloat(`-${dmg} 🌿`, C.green);
        }
      }
    }

    heroes[i] = { ...heroes[i], ult: 0 };
    setRun({ ...r, heroes });
    setBattle({ ...b, enemies, log, tauntUntil, hasteUntil, slowUntil, slowedKey, consecUntil, hotHeroId, hotUntil, hotPerSec });
  };

  const winFight = (r, heroes, type, fullLog) => {
    const depth = depthOf(r);
    const ag = aggRelics(r.relics);
    const regionMul = 1 + regionIndexOf(r.regionId) * 1.5; // marsh 1.0, cave 2.5, forest 4.0
    const mult = (type === "boss" ? 4 : type === "elite" ? 2 : 1) * (1 + 0.1 * (bld.shard - 1)) * regionMul;
    const goldMul = 1 + (ag.goldPct || 0) / 100;
    const allMul = 1 + (ag.allLootPct || 0) / 100;
    let hs = heroes;
    /* attack charge does not carry between fights */
    hs = hs.map(h => ({ ...h, gauge: 0 }));
    if (ag.healAfterFight) hs = hs.map(h => h.alive ? { ...h, hp: Math.min(h.maxHp, h.hp + ag.healAfterFight) } : h);
    const goldGain = Math.round((20 + depth * 8) * mult * goldMul * allMul);
    const woodGain = Math.round((10 + depth * 4) * mult * allMul);
    const emberGain = Math.round(((type === "boss" ? 8 : type === "elite" ? 2 : Math.random() > 0.6 ? 1 : 0)) * allMul);
    let r2 = {
      ...r, heroes: hs,
      gold: r.gold + goldGain,
      wood: r.wood + woodGain,
      embers: r.embers + emberGain,
    };
    setBattle(null);

    let bonusDrop = null;
    if (type === "boss") {
      /* victory restoration: revive any fallen heroes at 30% HP, and bump
         living heroes up to at least 30% if they were hurt below that */
      const recovered = r2.heroes.map(h => ({
        ...h,
        alive: true,
        hp: h.alive
          ? Math.max(h.hp, Math.round(h.maxHp * 0.3))
          : Math.round(h.maxHp * 0.3),
      }));
      r2 = { ...r2, heroes: recovered };

      /* equipment drop preference:
         - each region's boss drops only from that region's 2-item pool
         - prefer an item the player does NOT already own (no duplicates)
         - if the region's pool is fully collected, drop a treasure cache */
      const ownedIds = new Set(items.map(it => it.id));
      const regionPool = ITEMS.filter(it => it.region === r.regionId);
      const uncollected = regionPool.filter(it => !ownedIds.has(it.id));
      if (uncollected.length > 0) {
        const drop = rnd(uncollected);
        const uid = Math.random().toString(36).slice(2);
        setItems(p => [...p, { uid, id: drop.id }]);
        r2 = { ...r2, drops: [...r2.drops, { ...drop, uid }] };
      } else {
        const regMul = 1 + regionIndexOf(r.regionId) * 1.5;
        const bGold = Math.round(50 * regMul);
        const bWood = Math.round(25 * regMul);
        const bEmber = Math.round(3 * regMul);
        r2 = { ...r2, gold: r2.gold + bGold, wood: r2.wood + bWood, embers: r2.embers + bEmber };
        bonusDrop = { gold: bGold, wood: bWood, embers: bEmber };
      }
    }
    setRun(r2);
    setCombatReview({
      type, log: fullLog || [], gained: { gold: goldGain, wood: woodGain, embers: emberGain },
      bossKill: type === "boss", regionId: r2.regionId, bonusDrop,
    });
    setScreen("combatReview");
  };

  /* descend deeper to the next region with a fresh random modifier;
     1/3 of current corruption carries over as the next region's baseline */
  const descend = () => {
    const r = runRef.current;
    const nxt = nextRegion(r.regionId);
    if (!nxt) return;
    /* modifiers STACK across descents. Exclude every already-active id and
       the last rolled id (persisted) so the player always sees variety */
    const active = modsOf(r);
    const excluded = new Set([...active.map(x => x.id), lastModifierId].filter(Boolean));
    const pool = DESCENT_MODS.filter(x => !excluded.has(x.id));
    const m = rnd(pool.length ? pool : DESCENT_MODS.filter(x => !active.some(a => a.id === x.id)));
    setLastModifierId(m.id);
    const heroes = r.heroes.map(h => h.alive ? { ...h, hp: Math.min(h.maxHp, h.hp + Math.round(h.maxHp * 0.3)), gauge: 0, ult: 0 } : h);
    const carriedBaseline = corruption / 3;
    setRun({ ...r, regionId: nxt, modifier: m, modifiers: [...active, m], grid: makeRunGrid(nxt), pos: null, visited: [], heroes, corruptionBaseline: carriedBaseline, lastEventText: null });
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
    /* recovery accounting: decrement existing bench counts, then add this
       expedition's fallen heroes to sit out one expedition */
    setBenched(prev => {
      const next = {};
      for (const [id, n] of Object.entries(prev || {})) if (n > 1) next[id] = n - 1;
      r.heroes.forEach(h => { if (!h.alive) next[h.id] = 1; });
      return next;
    });
    const fallen = r.heroes.filter(h => !h.alive).map(h => h.id);
    recordProgress(r.regionId, depthOf(r), bossKill, runsDone + 1);
    setSummary({ extracted, bossKill, gained, depth: depthOf(r) + 1, drops: r.drops, regionId: r.regionId, ogreKill: bossKill && r.regionId === "forest", fallen });
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
    if (benched[id]) return;
    setParty(p => p.includes(id) ? p.filter(x => x !== id) : p.length < 3 ? [...p, id] : p);
  };

  /* if we reloaded into the battle screen but the in-memory battle object is
     gone, gracefully resume into the map */
  useEffect(() => {
    if (screen === "battle" && !battle && run) setScreen("map");
  }, [screen, battle, run]);

  /* benched heroes can't be in the party — auto-deselect after a run ends */
  useEffect(() => {
    const cleaned = party.filter(id => !benched[id]);
    if (cleaned.length !== party.length) setParty(cleaned);
  }, [benched]); // eslint-disable-line

  /* migrate: stale in-progress runs from before col-9 expansion don't have
     the right grid shape — clear them so the player gets a fresh expedition */
  useEffect(() => {
    if (run && (!run.grid || !run.grid[0] || run.grid[0].length !== COLS + 1)) {
      setRun(null);
      setScreen("base");
    }
  }, []); // eslint-disable-line

  /* migrate: items whose definitions were removed (e.g. old Sigil of
     Precision) get cleaned out of the armory and unequipped */
  useEffect(() => {
    const valid = new Set(ITEMS.map(it => it.id));
    if (items.some(it => !valid.has(it.id))) {
      const keep = items.filter(it => valid.has(it.id));
      const keepUids = new Set(keep.map(it => it.uid));
      setItems(keep);
      setEquips(prev => {
        const next = {};
        for (const [hid, uid] of Object.entries(prev)) if (keepUids.has(uid)) next[hid] = uid;
        return next;
      });
    }
  }, []); // eslint-disable-line

  /* ---------- render ---------- */
  /* corruption: starts at the carried-over baseline (1/3 of prior region's
     value), then per-encounter rate doubles for each region descended into.
     Marsh ~5%/depth, cave ~10%/depth, forest ~20%/depth. */
  const corruption = run
    ? (run.corruptionBaseline || 0) + ((depthOf(run) + 1) / (COLS + 2)) * 0.5 * (2 ** regionIndexOf(run.regionId))
    : 0;
  const corruptionVisual = Math.min(1, corruption);
  const glow = run
    ? `radial-gradient(ellipse 90% 55% at 50% -10%, rgba(67,197,178,${0.10 + corruptionVisual * 0.25}), transparent 60%)`
    : `radial-gradient(ellipse 90% 55% at 50% -10%, rgba(240,140,58,.22), transparent 60%)`;

  const MapPeek = ({ r }) => {
    const icons = { fight: "⚔️", elite: "👹", event: "❓", shrine: "✨", waygate: "🌀" };
    const bossIcon = REGIONS[r.regionId].boss.icon;
    const here = r.pos;
    const SZ = 30;
    return (
      <div style={{ overflowX: "auto", marginBottom: 6 }}>
        <div style={{
          display: "grid", gap: 4, justifyContent: "center",
          gridTemplateColumns: `repeat(${COLS + 2}, ${SZ}px)`,
          gridTemplateRows: `repeat(3, ${SZ}px)`,
          minWidth: (SZ + 4) * (COLS + 2),
        }}>
          {r.grid.map((rowArr, r2) => rowArr.map((t, c2) => {
            if (!t) return null;
            const isHere = here && !here.boss && here.row === r2 && here.col === c2;
            const was = r.visited.includes(`${r2}-${c2}`);
            return (
              <div key={`${r2}-${c2}`} style={{
                gridRow: r2 + 1, gridColumn: c2 + 1,
                borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
                background: isHere ? C.ember : was ? "#1c1628" : C.panel,
                opacity: was ? 0.35 : 1,
                border: isHere ? `2px solid ${C.gold}` : `1px solid ${C.panel2}`,
              }}>{icons[t]}</div>
            );
          }))}
          <div style={{
            gridRow: 2, gridColumn: COLS + 2, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15,
            background: here?.boss ? C.ember : C.panel, border: `1px solid ${C.red}55`,
          }}>{bossIcon}</div>
        </div>
      </div>
    );
  };

  const MapToggle = ({ r }) => (
    <div style={{ marginBottom: 12 }}>
      <div onClick={() => setShowMap(s => !s)} style={{
        background: C.panel2, borderRadius: 8, padding: "6px 12px", textAlign: "center",
        cursor: "pointer", fontSize: 12, color: C.dim, border: `1px solid ${C.panel2}`,
      }}>
        {showMap ? "▲ Hide path" : "👁 Show path"}
      </div>
      {showMap && <div style={{ marginTop: 8 }}><MapPeek r={r} /></div>}
    </div>
  );

  /* persistent panels reused across map / event / relic / waygate screens
     so the player can always see hero HP, live stats, and active effects */
  const PartyPanel = ({ r }) => (
    <div style={{ background: C.panel, borderRadius: 14, padding: 14, marginBottom: 12, border: `1px solid ${C.panel2}` }}>
      {r.heroes.map(h => {
        const eff = effectiveHero(h, r, null);
        return (
          <div key={h.id} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", fontSize: 13, marginBottom: 3 }}>
              <span style={{ opacity: h.alive ? 1 : 0.35 }}>{h.icon} {h.name}</span>
              <span style={{ marginLeft: "auto", color: h.alive ? C.dim : C.red, fontWeight: h.alive ? 400 : 700 }}>{h.alive ? `${h.hp}/${h.maxHp}` : "DOWNED"}</span>
            </div>
            <Bar val={h.hp} max={h.maxHp} color={h.alive ? C.green : C.red} />
            {h.alive && (
              <div style={{ fontSize: 11, color: C.dim, marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <span>⚔️ {eff.atk}</span>
                <span>🔮 {eff.matk}</span>
                <span>🛡️ {eff.def}</span>
                <span>🪄 {eff.mdef}</span>
                <span>💨 {eff.spd}</span>
                <span style={{ color: (h.ult || 0) >= 100 ? C.ember : C.dim }}>⚡ {Math.round(h.ult || 0)}%</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const EffectsPanel = ({ r }) => {
    const activeMods = modsOf(r);
    if (!(r.atkMod > 0 || activeMods.length > 0 || r.relics.length > 0)) return null;
    return (
      <div style={{ background: "#1c1628", borderRadius: 12, padding: "8px 12px", marginBottom: 12, border: `1px solid ${C.panel2}`, fontSize: 12 }}>
        <div style={{ color: C.dim, fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>ACTIVE EFFECTS</div>
        {r.atkMod > 0 && <div style={{ color: C.green }}>🌟 Event blessing: +{Math.round(r.atkMod * 100)}% attack this run</div>}
        {activeMods.map(m => <div key={m.id} style={{ color: C.red }}>🌑 {m.name}: {m.desc}</div>)}

        {r.relics.length > 0 && (
          <div style={{ marginTop: 2 }}>
            <div style={{ color: C.gold, marginBottom: 2 }}>Relics:</div>
            {Object.values(r.relics.reduce((acc, x) => { (acc[x.id] = acc[x.id] || { ...x, n: 0 }).n++; return acc; }, {})).map(x => (
              <div key={x.id} style={{ color: C.text, paddingLeft: 8, lineHeight: 1.5 }}>
                {x.icon} <span style={{ fontWeight: 700, color: C.gold }}>{x.name}{x.n > 1 ? ` ×${x.n}` : ""}</span> <span style={{ color: C.dim }}>— {x.desc}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const Shell = ({ children, title, sub }) => (
    <div style={{ minHeight: "100vh", background: `${glow}, ${C.bg}`, color: C.text, fontFamily: "'Alegreya Sans',sans-serif", maxWidth: 480, margin: "0 auto", padding: "20px 16px 32px", position: "relative" }}>
      <style>{FONT}{`
        @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.07)} }
        @keyframes floatUp { 0%{opacity:1; transform:translateY(0)} 100%{opacity:0; transform:translateY(-46px)} }
        @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
        @keyframes glowPulse { 0%,100%{box-shadow:0 0 5px ${C.gold}44} 50%{box-shadow:0 0 14px ${C.gold}aa} }
      `}</style>
      <div style={{ fontFamily: "'Cinzel',serif", fontWeight: 900, fontSize: 13, letterSpacing: 4, color: run ? C.umbral : C.ember, textAlign: "center" }}>EMBERHOLD <span style={{ color: C.dim, fontWeight: 400, letterSpacing: 1, fontSize: 10 }}>v{VERSION}</span></div>
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
      <Shell title="Your Hold" sub={`${REALMS.earthen.icon} ${REALMS.earthen.name} · Expeditions: ${runsDone}${caveUnlocked ? " · 🕳️ Deep" : ""}${forestUnlocked ? " · 🌲 Forest" : ""}${Object.keys(benched).length ? ` · 🩹 ${Object.keys(benched).length} recovering` : ""}`}>
        {!username && (
          <div style={{ background: "#1c1730", border: `1px solid ${C.gold}66`, borderRadius: 12, padding: 16, marginBottom: 16, textAlign: "center" }}>
            <div style={{ fontFamily: "'Cinzel',serif", fontWeight: 700, color: C.gold, fontSize: 16, marginBottom: 6 }}>⚔️ Name your champion</div>
            <div style={{ fontSize: 12, color: C.dim, marginBottom: 12 }}>Choose a username for the leaderboard. This is how other players will see how far you've delved.</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
              <input
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value.slice(0, 24))}
                placeholder="Your name"
                maxLength={24}
                style={{ background: C.panel, border: `1px solid ${C.panel2}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 14, fontFamily: "'Alegreya Sans',sans-serif", width: 180 }}
              />
              <button
                onClick={() => { const n = nameDraft.trim(); if (n) setUsername(n); }}
                disabled={!nameDraft.trim()}
                style={{ background: nameDraft.trim() ? C.ember : "#352c44", color: nameDraft.trim() ? "#1a1020" : C.dim, border: "none", borderRadius: 8, padding: "8px 18px", fontFamily: "'Alegreya Sans',sans-serif", fontWeight: 700, fontSize: 13, cursor: nameDraft.trim() ? "pointer" : "default" }}
              >Set name</button>
            </div>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, marginBottom: 14 }}>
          <button onClick={() => { setShowLeaderboard(true); loadLeaderboard(); }} style={{ background: "transparent", color: C.gold, border: `1px solid ${C.gold}66`, borderRadius: 8, padding: "7px 18px", fontSize: 13, cursor: "pointer", fontFamily: "'Alegreya Sans',sans-serif", fontWeight: 700 }}>
            🏆 Leaderboard
          </button>
          {username && (
            <span style={{ fontSize: 12, color: C.dim }}>
              Playing as <span style={{ color: C.gold, fontWeight: 700 }}>{username}</span>
              <button onClick={() => { setNameDraft(username); setUsername(""); }} style={{ marginLeft: 8, background: "transparent", color: C.dim, border: "none", textDecoration: "underline", fontSize: 11, cursor: "pointer", fontFamily: "'Alegreya Sans',sans-serif" }}>change</button>
            </span>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}><Res res={res} /></div>
        <div style={{ display: "grid", gap: 10, marginBottom: 18 }}>
          {BUILDINGS.map(b => {
            const lvl = bld[b.id], cost = b.cost(lvl);
            const can = (cost.gold || 0) <= res.gold && (cost.wood || 0) <= res.wood && (cost.embers || 0) <= res.embers;
            return (
              <div key={b.id} style={{ background: C.panel, borderRadius: 14, padding: 14, display: "flex", alignItems: "center", gap: 12, border: `1px solid ${C.panel2}` }}>
                <div style={{ fontSize: 26 }}>{b.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>{b.name} <span style={{ color: C.gold }}>Level {lvl}</span></div>
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
            const isBenched = !!benched[h.id];
            const available = items.filter(it => {
              const holder = Object.entries(equips).find(([, uid]) => uid === it.uid);
              return !holder || holder[0] === h.id;
            });
            return (
              <StatCard key={h.id} unit={{ ...h, hp: h.maxHp }} idKey={`base-${h.id}`} pinned={pinned} setPinned={setPinned} hovered={hovered} setHovered={setHovered} noIcon
                style={{ fontSize: 13, color: C.dim, marginBottom: 10, padding: 6, borderRadius: 8, background: isBenched ? "#1a1620" : inParty ? "#241a30" : "#1c1628", border: `1px solid ${isBenched ? C.red + "44" : inParty ? C.ember + "66" : C.panel2}`, opacity: isBenched ? 0.7 : 1 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" checked={inParty} disabled={isBenched} onChange={() => toggleParty(h.id)}
                    style={{ width: 16, height: 16, accentColor: C.ember, cursor: isBenched ? "not-allowed" : "pointer" }} />
                  <span>{h.icon}</span><span style={{ color: C.text, fontWeight: 700 }}>{h.name}</span>
                  <span>{h.cls}</span>
                  <span onClick={e => { e.stopPropagation(); setPinned(p => (p === `base-${h.id}` ? null : `base-${h.id}`)); }}
                    style={{ fontSize: 16, color: pinned === `base-${h.id}` ? C.gold : C.dim, cursor: "pointer", padding: "6px 8px", margin: "-6px 0", lineHeight: 1, touchAction: "manipulation" }}
                    title="Show stats">ⓘ</span>
                  <span style={{ marginLeft: "auto" }}>❤️{h.maxHp} ⚔️{h.atk} 🔮{h.matk} 💨{h.spd}</span>
                </div>
                {isBenched && (
                  <div style={{ fontSize: 11, color: C.red, marginTop: 4, fontWeight: 700 }}>
                    🩹 Recovering — sits out the next expedition
                  </div>
                )}
                <div style={{ fontSize: 12, color: C.ember, marginTop: 4 }}>
                  ⚡ {h.ultName} <span style={{ color: C.dim }}>— {ultDescLive(h, h.matk)}</span>
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
        <Btn full disabled={party.length !== 3 || !username} onClick={startRun}>
          {!username ? "⚔️ Set a username above to begin" : party.length === 3 ? "🌫️ Venture into the Forgotten Marshland" : (() => {
            const available = HERO_DEFS.filter(h => !benched[h.id]).length;
            if (available < 3) return `Only ${available} heroes available — wait one expedition for recovery`;
            return `Select ${3 - party.length} more hero${3 - party.length === 1 ? "" : "es"}`;
          })()}
        </Btn>
        <div style={{ textAlign: "center", marginTop: 14, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          <button onClick={() => setMusicOn(v => !v)} style={{ background: "transparent", color: musicOn ? C.ember : C.dim, border: `1px solid ${musicOn ? C.ember + "66" : C.panel2}`, borderRadius: 8, padding: "6px 14px", fontSize: 11, cursor: "pointer", fontFamily: "'Alegreya Sans',sans-serif" }}>
            {musicOn ? "🎵 Music On" : "🔇 Music Off"}
          </button>
          <button onClick={() => {
            if (resetArmed) { resetHold(); }
            else { setResetArmed(true); setTimeout(() => setResetArmed(false), 4000); }
          }} style={{ background: resetArmed ? C.red : "transparent", color: resetArmed ? "#fff" : C.dim, border: `1px solid ${resetArmed ? C.red : C.panel2}`, borderRadius: 8, padding: "6px 14px", fontSize: 11, cursor: "pointer", fontFamily: "'Alegreya Sans',sans-serif" }}>
            {resetArmed ? "⚠️ Tap again to confirm — wipes ALL progress" : "⚠️ Reset Hold (wipes save)"}
          </button>
        </div>
        {musicOn && (
          <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 11, color: C.dim }}>🔈</span>
            <input type="range" min="0" max="1" step="0.05" value={musicVol}
              onChange={e => setMusicVol(parseFloat(e.target.value))}
              style={{ width: 160, accentColor: C.ember, cursor: "pointer" }} />
            <span style={{ fontSize: 11, color: C.dim, minWidth: 32, textAlign: "right" }}>{Math.round(musicVol * 100)}%</span>
          </div>
        )}
        {showLeaderboard && (
          <div onClick={() => setShowLeaderboard(false)} style={{ position: "fixed", inset: 0, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#15101f", border: `1px solid ${C.gold}66`, borderRadius: 14, padding: 18, width: "100%", maxWidth: 420, maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontFamily: "'Cinzel',serif", fontWeight: 900, color: C.gold, fontSize: 18 }}>🏆 Leaderboard</div>
                <button onClick={() => setShowLeaderboard(false)} style={{ marginLeft: "auto", background: "transparent", color: C.dim, border: "none", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
              <div style={{ fontSize: 11, color: C.dim, marginBottom: 12 }}>Furthest delve into the Earthen Realm.</div>
              <div style={{ overflowY: "auto", flex: 1 }}>
                {!LB_ENABLED() ? (
                  <div style={{ color: C.dim, fontSize: 13, textAlign: "center", padding: "24px 8px", lineHeight: 1.5 }}>
                    The leaderboard isn't configured yet.<br />Add a Firebase project ID to enable online scores.
                  </div>
                ) : lbLoading ? (
                  <div style={{ color: C.dim, textAlign: "center", padding: 24 }}>Loading…</div>
                ) : !lbRows || lbRows.length === 0 ? (
                  <div style={{ color: C.dim, textAlign: "center", padding: 24 }}>No entries yet — be the first to delve!</div>
                ) : (
                  lbRows.map((row, i) => {
                    const isMe = row.username === username;
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, marginBottom: 4, background: isMe ? C.ember + "22" : i % 2 ? "#1a1426" : "transparent", border: isMe ? `1px solid ${C.ember}66` : "1px solid transparent" }}>
                        <span style={{ width: 28, textAlign: "right", fontWeight: 700, color: i === 0 ? C.gold : i === 1 ? "#c9c9d4" : i === 2 ? "#cd7f32" : C.dim, fontSize: 14 }}>{i + 1}</span>
                        <span style={{ flex: 1, color: isMe ? C.gold : C.text, fontWeight: isMe ? 700 : 500, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.username}{isMe ? " (you)" : ""}</span>
                        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.3 }}>
                          <span style={{ color: C.dim, fontSize: 12 }}>{row.label}</span>
                          <span style={{ color: C.dim, fontSize: 10, opacity: 0.7 }}>{row.expeditions} expedition{row.expeditions === 1 ? "" : "s"}</span>
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
              {LB_ENABLED() && (
                <button onClick={loadLeaderboard} style={{ marginTop: 10, background: "transparent", color: C.dim, border: `1px solid ${C.panel2}`, borderRadius: 8, padding: "6px 14px", fontSize: 11, cursor: "pointer", fontFamily: "'Alegreya Sans',sans-serif" }}>↻ Refresh</button>
              )}
            </div>
          </div>
        )}
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
    const isCand = (r2, c2) => cands.some(x => !x.boss && x.row === r2 && x.col === c2);
    const bossCand = cands.some(x => x.boss);
    /* a relic was just chosen: shrine candidates are blocked while any
       non-shrine option exists (no back-to-back relic picks) */
    const lastWasShrine = run.lastType === "shrine";
    const candHasNonShrine = cands.some(x => x.boss || run.grid[x.row][x.col] !== "shrine");
    const shrineBlocked = lastWasShrine && candHasNonShrine;
    const SZ = 36;

    return (
      <Shell title={region.name} sub={`${realmOf(run.regionId).icon} ${realmOf(run.regionId).name} · Depth ${depthOf(run) + 1} of ${COLS + 2} · Corruption ${Math.round(corruption * 100)}%${modsOf(run).length ? ` · ${modsOf(run).map(m => m.name).join(" + ")}` : ""} · choose your next step`}>
        <div style={{ overflowX: "auto", paddingBottom: 6, marginBottom: 12 }}>
          <div style={{
            display: "grid", gap: 6, justifyContent: "center",
            gridTemplateColumns: `repeat(${COLS + 2}, ${SZ}px)`,
            gridTemplateRows: `repeat(3, ${SZ}px)`,
            minWidth: (SZ + 6) * (COLS + 2),
          }}>
            {run.grid.map((rowArr, r2) => rowArr.map((t, c2) => {
              if (!t) return null;
              const here = run.pos && !run.pos.boss && run.pos.row === r2 && run.pos.col === c2;
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

        <PartyPanel r={run} />
        <EffectsPanel r={run} />
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
        {battle.type === "boss" && (
          <div style={{ height: 42, marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {battle.enraged && (
              <div style={{ width: "100%", textAlign: "center", padding: "6px 12px", boxSizing: "border-box", background: "#2a1015", borderRadius: 10, border: `1px solid ${C.red}`, color: C.red, fontWeight: 700, fontSize: 13, animation: "pulse 1s infinite" }}>
                😡 ENRAGED — the boss strikes harder and faster!
              </div>
            )}
          </div>
        )}
        {/* enemies */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 10, flexWrap: "wrap" }}>
          {battle.enemies.map(e => {
            const focused = battle.focus === e.key && e.hp > 0;
            const isSurger = battle.surge?.enemyKey === e.key;
            return (
              <StatCard key={e.key} unit={effectiveEnemy(e, run, battle)} idKey={e.key} dir="down" clickOnly pinned={pinned} setPinned={setPinned} hovered={hovered} setHovered={setHovered}
                onClick={() => setFocus(e.key)}
                style={{
                  background: C.panel, borderRadius: 12, padding: 10, width: 96, textAlign: "center",
                  opacity: e.hp > 0 ? 1 : 0.25, cursor: e.hp > 0 ? "pointer" : "default",
                  border: `2px solid ${focused ? C.gold : isSurger ? C.red : C.umbral + "33"}`,
                  boxShadow: focused ? `0 0 10px ${C.gold}55` : "none",
                  animation: isSurger && surging ? "shake .4s infinite" : "none",
                }}>
                <div style={{ fontSize: 26 }}>{isSurger && surging ? "⚠️" : e.icon}</div>
                <div style={{ fontSize: 10, color: C.dim, height: 30, display: "flex", flexDirection: "column", justifyContent: "flex-start", lineHeight: 1.15, overflow: "hidden" }}>
                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</div>
                  <div style={{ height: 13 }}>
                    {slowOn && battle.slowedKey === e.key ? "🌿" : ""}{(e.burnStacks || 0) > 0 ? `🔥×${e.burnStacks}` : ""}
                  </div>
                </div>
                <Bar val={e.hp} max={e.maxHp} color={C.umbral} h={6} />
                <div style={{ margin: "3px 0" }}><Bar val={e.gauge || 0} max={100} color={C.blue} h={4} /></div>
                <div style={{ fontSize: 11 }}>{e.hp}</div>
                <div style={{ fontSize: 10, color: C.gold, fontWeight: 700, height: 14 }}>{focused ? "🎯 FOCUS" : ""}</div>
              </StatCard>
            );
          })}
        </div>

        {/* active buffs — fixed height + single line so multiple simultaneous
            effects never wrap and shift the hero cards below */}
        <div style={{ height: 20, textAlign: "center", fontSize: 12, marginBottom: 4, display: "flex", justifyContent: "center", alignItems: "center", gap: 10, whiteSpace: "nowrap", overflow: "hidden" }}>
          {tauntOn && <span style={{ color: C.blue }}>🛡️ Taunt</span>}
          {hasteOn && <span style={{ color: C.blue }}>🏹 Hasted</span>}
          {slowOn && <span style={{ color: C.umbral }}>🌿 {battle.enemies.find(e => e.key === battle.slowedKey)?.name || "Enemy"} slowed</span>}
          {battle.tick < (battle.consecUntil || 0) && <span style={{ color: C.gold }}>⚜️ Consecrated</span>}
          {battle.tick < (battle.hotUntil || 0) && battle.hotHeroId && <span style={{ color: C.green }}>🌿 Regrowth: {run.heroes.find(x => x.id === battle.hotHeroId)?.name}</span>}
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

        <div style={{ height: 54, textAlign: "center", fontSize: 13, color: C.gold, marginBottom: 8, display: "flex", flexDirection: "column", justifyContent: "flex-end", overflow: "hidden" }}>
          {battle.log.filter(e => (typeof e === "string" ? true : e.level === "major")).slice(-3).map((l, i) => <div key={i}>{typeof l === "string" ? l : l.text}</div>)}
        </div>

        {/* heroes: HP bar, attack gauge bar, ult bar + button */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "flex-start" }}>
          {run.heroes.map((h, i) => {
            const ready = battle.started && h.alive && h.ult >= 100;
            return (
              <StatCard key={h.id} unit={effectiveHero(h, run, battle)} idKey={`b-${h.id}`} clickOnly pinned={pinned} setPinned={setPinned} hovered={hovered} setHovered={setHovered}
                style={{
                  background: C.panel, borderRadius: 12, padding: 10, width: 106, textAlign: "center",
                  opacity: h.alive ? 1 : 0.3, border: `1px solid ${h.id === "bran" && tauntOn ? C.blue : C.panel2}`,
                  boxSizing: "border-box", alignSelf: "flex-start",
                }}>
                <div style={{ fontSize: 22, height: 28, lineHeight: "28px" }}>{h.icon}</div>
                <div style={{ fontSize: 12, fontWeight: 700, height: 18, lineHeight: "18px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{h.name}</div>
                <Bar val={h.hp} max={h.maxHp} color={C.green} h={6} />
                <div style={{ margin: "3px 0" }}><Bar val={h.gauge || 0} max={100} color={C.blue} h={4} /></div>
                <div style={{ margin: "3px 0" }}><Bar val={h.ult} max={100} color={C.ember} h={5} /></div>
                <button onClick={e => { e.stopPropagation(); fireUlt(i); }} disabled={!ready} style={{
                  width: "100%", border: "none", borderRadius: 8, padding: "0 4px", height: 34,
                  fontFamily: "'Alegreya Sans',sans-serif", fontWeight: 700, fontSize: 11,
                  background: ready ? C.ember : "#352c44", color: ready ? "#1a1020" : C.dim,
                  cursor: ready ? "pointer" : "default",
                  animation: ready ? "pulse .7s infinite" : "none",
                  boxShadow: ready ? `0 0 12px ${C.ember}88` : "none",
                  lineHeight: 1.1, overflow: "hidden",
                }}>{ready ? `⚡ ${h.ultName}` : battle.started ? `${Math.round(h.ult)}%` : h.ultName}</button>
              </StatCard>
            );
          })}
        </div>
        <div style={{ textAlign: "center", fontSize: 10, color: C.dim, marginTop: 8 }}>
          bars: <span style={{ color: C.green }}>HP</span> · <span style={{ color: C.blue }}>attack charge</span> · <span style={{ color: C.ember }}>ultimate</span>
        </div>
        {/* BRACE QTE — inline under the bar legend so it sits where the eye is already focused */}
        <div style={{ minHeight: 56, display: "flex", justifyContent: "center", alignItems: "center", marginTop: 10 }}>
          {surging && (
            <button onClick={brace} style={{
              background: C.red, color: "#fff", border: "none", borderRadius: 14, padding: "14px 48px",
              fontFamily: "'Cinzel',serif", fontWeight: 900, fontSize: 18, cursor: "pointer",
              animation: "pulse .45s infinite", boxShadow: `0 0 24px ${C.red}cc`,
            }}>🛡️ BRACE!</button>
          )}
        </div>
      </Shell>
    );
  }

  /* RELIC pick */
  if (screen === "relic" && pendingRelics && run) return (
    <Shell title="A Shrine Hums" sub="Choose one relic — it lasts only this run">
      <MapToggle r={run} />
      <PartyPanel r={run} />
      <EffectsPanel r={run} />
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
      if (r2.teamDmg) {
        /* event damage can down heroes; Phoenix Feathers auto-revive at 30% */
        const ag2 = aggRelics(r2.relics);
        let spent = r2.phoenixSpent || 0;
        const heroes2 = r2.heroes.map(h => {
          if (!h.alive) return h;
          const hp = h.hp - r2.teamDmg;
          if (hp > 0) return { ...h, hp };
          if ((ag2.phoenix || 0) > spent) { spent++; return { ...h, hp: Math.round(h.maxHp * 0.3) }; }
          return { ...h, hp: 0, alive: false };
        });
        r2 = { ...r2, heroes: heroes2, phoenixSpent: spent, teamDmg: 0 };
      }
      if (r2.teamHeal) r2 = { ...r2, heroes: r2.heroes.map(h => h.alive ? { ...h, hp: Math.min(h.maxHp, h.hp + r2.teamHeal) } : h), teamHeal: 0 };
      setEventCard(null);
      setEventResult({ text: r2.blessing || "Nothing came of it. The road continues.", run: r2 });
      setScreen("eventResult");
    };
    return (
      <Shell title="A Strange Encounter">
        <MapToggle r={run} />
        <PartyPanel r={run} />
        <EffectsPanel r={run} />
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
        {eventResult.run && <>
          <MapToggle r={eventResult.run} />
          <PartyPanel r={eventResult.run} />
          <EffectsPanel r={eventResult.run} />
        </>}
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
    const isFinal = run.pos?.col === COLS;
    const region = REGIONS[run.regionId];
    return (
      <Shell title={isFinal ? "🌀 The Last Waygate" : "🌀 A Waygate"}
        sub={isFinal ? `Beyond this gate, only ${region.boss.name} remains.` : "A shimmering door home. Beyond it, the dark deepens."}>
        <MapToggle r={run} />
        <PartyPanel r={run} />
        <EffectsPanel r={run} />
        <div style={{ background: C.panel, borderRadius: 14, padding: 16, textAlign: "center", marginBottom: 16, border: `1px solid ${C.umbral}55` }}>
          <div style={{ fontSize: 13, color: C.green, marginBottom: 8 }}>✨ The gate's light mends the party: +30% HP, and the fallen rise again at 20%.</div>
          <div style={{ fontSize: 13, color: C.dim, marginBottom: 6 }}>Loot secured if you extract now</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.gold }}>🪙{run.gold} 🪵{run.wood} ✨{run.embers}</div>
          <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>If your party falls deeper in, you keep only half.</div>
          {isFinal && <div style={{ fontSize: 12, color: C.gold, marginTop: 6 }}>⚔️ Only bosses can drop equipment.</div>}

        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <Btn full color={C.umbral} onClick={() => finishRun(run, true)}>🏠 Extract — keep everything</Btn>
          <Btn full onClick={() => isFinal ? chooseNode({ boss: true }) : backToMap()}>{isFinal ? `${region.boss.icon} Face ${region.boss.name}` : "⚔️ Continue — greater rewards ahead"}</Btn>
        </div>
      </Shell>
    );
  }

  /* COMBAT REVIEW — shown after every victorious fight */
  if (screen === "combatReview" && combatReview && run) {
    const cr = combatReview;
    const title = cr.bossKill ? "🏆 Boss Slain!" : cr.type === "elite" ? "Elite Vanquished" : "Foes Routed";
    const proceed = () => {
      setCombatReview(null);
      if (cr.bossKill) {
        const nxt = nextRegion(run.regionId);
        if (nxt) {
          if (nxt === "cave" && !caveUnlocked) setCaveUnlocked(true);
          if (nxt === "forest" && !forestUnlocked) setForestUnlocked(true);
          setScreen("descend");
        } else {
          finishRun(run, true, true);
        }
      } else {
        backToMap();
      }
    };
    /* normalize legacy string entries to {text, level: "major"} for safety */
    const norm = cr.log.map(e => typeof e === "string" ? { text: e, level: "major" } : e);
    const majorCount = norm.filter(e => e.level === "major").length;
    const detailCount = norm.length - majorCount;
    const shown = logDetail ? norm : norm.filter(e => e.level === "major");
    return (
      <Shell title={title} sub="Review the battle, then continue your expedition">
        <div style={{ background: C.panel, borderRadius: 14, padding: 16, marginBottom: 14, border: `1px solid ${C.panel2}`, textAlign: "center" }}>
          <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>RESOURCES GAINED</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.gold }}>
            🪙 +{cr.gained.gold} &nbsp; 🪵 +{cr.gained.wood} &nbsp; ✨ +{cr.gained.embers}
          </div>
        </div>
        {cr.bonusDrop && (
          <div style={{ background: "#2a2010", borderRadius: 14, padding: 14, marginBottom: 14, border: `1px solid ${C.gold}77`, textAlign: "center" }}>
            <div style={{ fontSize: 12, color: C.gold, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>🎁 TREASURE CACHE</div>
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 6, fontStyle: "italic" }}>Your armory is full — the boss yields a hoard instead</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.gold }}>
              🪙 +{cr.bonusDrop.gold} &nbsp; 🪵 +{cr.bonusDrop.wood} &nbsp; ✨ +{cr.bonusDrop.embers}
            </div>
          </div>
        )}
        {cr.bossKill && (
          <div style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 11, color: C.green, fontWeight: 700, letterSpacing: 1, marginBottom: 6, textAlign: "center" }}>✨ VICTORY MENDS THE PARTY — fallen revived at 30%</div>
            <PartyPanel r={run} />
          </div>
        )}
        <div style={{ background: C.panel, borderRadius: 14, padding: 12, marginBottom: 14, border: `1px solid ${C.panel2}` }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 700, letterSpacing: 1 }}>COMBAT LOG</div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <button onClick={() => setLogDetail(false)} style={{
                background: !logDetail ? C.ember : "transparent", color: !logDetail ? "#1a1020" : C.dim,
                border: `1px solid ${!logDetail ? C.ember : C.panel2}`, borderRadius: 6, padding: "4px 10px",
                fontSize: 11, cursor: "pointer", fontFamily: "'Alegreya Sans',sans-serif", fontWeight: 700,
              }}>Simple ({majorCount})</button>
              <button onClick={() => setLogDetail(true)} style={{
                background: logDetail ? C.ember : "transparent", color: logDetail ? "#1a1020" : C.dim,
                border: `1px solid ${logDetail ? C.ember : C.panel2}`, borderRadius: 6, padding: "4px 10px",
                fontSize: 11, cursor: "pointer", fontFamily: "'Alegreya Sans',sans-serif", fontWeight: 700,
              }}>Detailed ({majorCount + detailCount})</button>
            </div>
          </div>
          <div style={{ maxHeight: 260, overflowY: "auto", fontSize: 12, lineHeight: 1.6 }}>
            {shown.length === 0 && <div style={{ color: C.dim }}>No notable events.</div>}
            {shown.map((l, i) => (
              <div key={i} style={{ color: l.level === "major" ? C.text : C.dim, padding: "1px 4px", fontWeight: l.level === "major" ? 600 : 400 }}>{l.text}</div>
            ))}
          </div>
        </div>
        <Btn full onClick={proceed}>{cr.bossKill && nextRegion(run.regionId) ? `${REGIONS[nextRegion(run.regionId)].emoji} Continue ▸` : cr.bossKill ? "🏠 Return Home ▸" : "🗺️ Back to the path ▸"}</Btn>
      </Shell>
    );
  }

  /* DESCEND — after killing a region boss with a next region available */
  if (screen === "descend" && run) {
    const nxt = nextRegion(run.regionId);
    const curr = REGIONS[run.regionId];
    const nxtReg = nxt ? REGIONS[nxt] : null;
    const titleByRegion = { marsh: "The Herald Falls!", cave: "The Hollow Sovereign Falls!" };
    const subByRegion = {
      marsh: "Behind its corpse, the marsh floor splits open — a rift descending into deeper Umbral.",
      cave: "The Sovereign's gaze breaks. Beyond, ancient roots tangle into a dimming forest.",
    };
    if (!nxtReg) { finishRun(run, true, true); return null; }
    return (
      <Shell title={titleByRegion[run.regionId] || `${curr.name} cleared!`}
        sub={subByRegion[run.regionId] || "A deeper region opens before you."}>
        <div style={{ background: C.panel, borderRadius: 14, padding: 16, marginBottom: 14, border: `1px solid ${C.gold}55` }}>
          <div style={{ fontSize: 13, color: C.dim, marginBottom: 6, textAlign: "center" }}>Equipment claimed — equip it now, before going deeper:</div>
          {run.drops.map(d => (
            <div key={d.uid} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.gold, textAlign: "center" }}>{d.icon} {d.name} <span style={{ fontSize: 12, color: C.text, fontWeight: 400 }}>· {d.desc}</span></div>
              {d.equippedTo ? (
                <div style={{ fontSize: 12, color: C.umbral, textAlign: "center", marginTop: 4 }}>✓ Equipped to {HERO_DEFS.find(x => x.id === d.equippedTo)?.name}</div>
              ) : (
                <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 6, flexWrap: "wrap" }}>
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
          <div style={{ fontFamily: "'Cinzel',serif", fontWeight: 700, color: C.umbral, marginBottom: 6 }}>{nxtReg.emoji} {nxtReg.name} beckons</div>
          <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.6 }}>
            Descend to face <b>{nxtReg.boss.name}</b> — stronger foes, richer loot, another equipment drop.
            The party recovers 30% HP on descent, but a <span style={{ color: C.red }}>random Umbral modifier</span> will
            empower all remaining enemy encounters in this new region. Corruption already accelerates here — its rate doubles each region.
          </div>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <Btn full color={C.umbral} onClick={() => finishRun(run, true, true)}>🏠 Extract — return victorious</Btn>
          <Btn full onClick={descend}>{nxtReg.emoji} Descend into {nxtReg.name}</Btn>
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
      <Btn full onClick={() => setScreen("map")}>{REGIONS[run.regionId].emoji} Enter {REGIONS[run.regionId].name}</Btn>
    </Shell>
  );

  /* SUMMARY */
  if (screen === "summary" && summary) return (
    <Shell title={summary.ogreKill ? "👑 The Earthen Realm Is Cleansed!" : summary.bossKill ? "🏆 Victory!" : summary.extracted ? "Safely Home" : "The Party Has Fallen"}
      sub={summary.extracted ? "Your hold grows stronger." : "Survivors limp home with half the spoils."}>
      <div style={{ background: C.panel, borderRadius: 14, padding: 18, textAlign: "center", margin: "14px 0", border: `1px solid ${C.panel2}` }}>
        <div style={{ fontSize: 13, color: C.dim, marginBottom: 8 }}>
          {REGIONS[summary.regionId].emoji} {REGIONS[summary.regionId].name} · depth {summary.depth} of {COLS + 2} · loot returned:
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: C.gold }}>
          🪙 +{summary.gained.gold} &nbsp; 🪵 +{summary.gained.wood} &nbsp; ✨ +{summary.gained.embers}
        </div>
        {summary.fallen && summary.fallen.length > 0 && (
          <div style={{ marginTop: 12, padding: "10px 12px", background: "#2a1620", borderRadius: 10, border: `1px solid ${C.red}66` }}>
            <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 4 }}>🩹 Fallen — recovering at the Hold:</div>
            <div style={{ fontSize: 13, color: C.text }}>
              {summary.fallen.map(id => HERO_DEFS.find(h => h.id === id)).filter(Boolean).map(h => `${h.icon} ${h.name}`).join(" · ")}
            </div>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>They cannot be selected for the next expedition.</div>
          </div>
        )}
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
