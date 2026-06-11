# Emberhold 🔥

A base-building strategy roguelite set in a dying fantasy world. Playable prototype built with React + Vite.

**Pitch:** Build a fortress sanctuary, then send heroes on roguelite expeditions through the Forgotten Marshland and the Ogre Forest. Heroes can be wounded or lost in a run, but loot and equipment always flow back to make your Hold stronger.

## Run it locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Deploy to GitHub Pages

One-time setup:

1. Push this repo to GitHub.
2. In your repo on GitHub → **Settings → Pages**, set Source to **GitHub Actions**.

Then to deploy:

```bash
git push   # the workflow at .github/workflows/deploy.yml builds and publishes
```

Or manually:

```bash
npm run deploy
```

Your playtest URL will be `https://<your-username>.github.io/<repo-name>/`.

## How to play

1. **Your Hold** — upgrade buildings (Forge, Barracks, Arcanum, Worldflame Shard) with gold, wood, and embers. Tick exactly 3 heroes to bring on the expedition. Hover (or tap ⓘ) for full stats.
2. **The Path** — choose your route Slay-the-Spire style; rows are connected to same/adjacent rows in the next column. Mid-map waygates heal 30% and revive fallen heroes at 20%.
3. **Combat** — tap an enemy to **focus fire**, tap the glowing **⚡ ult button** to cast (ults charge from attack swings), and tap **🛡️ BRACE!** when the red button appears at the bottom of the screen.
4. **Bosses** drop equipment — equip immediately on the descend/summary screen, or later from Your Hold.
5. **Descend** — kill the Herald of Gloaming to unlock the Ogre Forest within the same expedition. A random Umbral modifier empowers all remaining enemies.

## Heroes

- 🛡️ **Branwen** (Vanguard) — *Taunt:* enemies attack him 2s, defenses doubled
- ⚔️ **Kaelis** (Blade) — *Sever:* strike focused enemy 3× damage
- 🔥 **Syrene** (Pyromancer) — *Cinder Nova:* magic damage to all
- 🙏 **Liora** (Priest) — *Sanctuary:* heal party 15 HP
- 🏹 **Fenwick** (Ranger) — *Quickdraw:* +60% own attack speed 3s
- 🌿 **Thornwild** (Druid) — *Entangle:* −50% attack speed on focused enemy 4s

## Save data

Progress (Hold resources, building levels, items, Ogre Forest unlock, party choice) is stored in your browser via `localStorage` under the key `emberhold-save-v1`. The current expedition is **not** saved — closing mid-run loses it. There's a **Reset Hold** button on the Hold screen.

## Known issues / playtester feedback

- This is a prototype. Numbers will change.
- No audio yet.
- Tested mainly on desktop; mobile feedback welcome.
- Report issues or suggestions in this repo's Issues tab.

## License

MIT — see `LICENSE`.
