import Phaser from 'phaser';

const GAME_WIDTH = 480;
const GAME_HEIGHT = 800;
const ROAD_LEFT = 30;
const ROAD_RIGHT = GAME_WIDTH - 30;
const PLAYER_Y = 690;
const BASE_SCROLL_SPEED = 220; // px/sec, ramps up with distance
const MAX_SOLDIERS_RENDERED = 60; // perf cap; army count can exceed this

// ---------------------------------------------------------------------------
// BOSS TUNING -- this is the "HP slider". hp at spawn = BOSS_BASE_HP *
// BOSS_HP_GROWTH_RATE ^ (bossCount - 1) -- geometric, not linear, because the
// army snowballs multiplicatively via `mult` gates.
// History, since this constant keeps getting revisited: 1.35 (original) had
// real teeth but created a hard wall around boss #8 (~1.5-2 min in) where
// fights become mathematically unwinnable regardless of skill. We tried
// 1.05 to chase an hour-long sustainable run -- that fixed the wall but
// made early bosses trivial (sub-1s kills up through wave 45). We also
// tried DPS-relative scaling (hp derived directly from current DPS x a
// designed fight-duration curve) to hit an exact early-game duration
// reliably -- mechanically correct, but it removed the sense of real
// elimination risk, which is the point of a boss fight. Back to 1.35: real
// threat (including the wall) is the explicit tradeoff being made here over
// "sustainable forever".
// The eventual fix for pushing the wall further out, discussed and landed
// on: not a global rate/DPS-relative change (that flattens the whole game,
// including the early fights that are already tuned right), but a single
// mid-game CHECKPOINT. Bosses #1..BOSS_HP_RESET_COUNT-1 are completely
// untouched -- still the pure BOSS_BASE_HP * BOSS_HP_GROWTH_RATE^(n-1) curve
// above, unwinnable wall and all. At boss #BOSS_HP_RESET_COUNT, hp is
// instead measured live from THIS run's actual current DPS (see
// getFirepower()), set so that specific boss is a clean
// BOSS_HP_RESET_BEATABLE_SECONDS-second kill -- which absorbs whatever gap
// had opened up between the formula's blind compounding and this run's real
// army growth by that point. Boss #BOSS_HP_RESET_COUNT+1 onward resumes
// BOSS_HP_GROWTH_RATE compounding, unchanged, but from that fresh,
// fair-to-this-run baseline instead of carrying BOSS_HP_RESET_COUNT-1
// encounters' worth of accumulated drift -- same wall, same teeth, just
// further out. See getBossHp().
// MAX_DMG_PER_VOLLEY caps how hard even a massive army can hit per volley, so
// no army size can one-shot a boss regardless of how big it's grown.
// BOSS_INVULN_MS ignores damage entirely for a moment right as he locks in,
// specifically to absorb the burst of bullets already in flight cleanly
// instead of letting it chip a huge chunk off his HP bar in one frame (the
// boss is ALSO fully invulnerable during its descent, before it locks in at
// all -- see the `!boss.getData('locked')` check in onBulletHitBoss -- so
// none of its hp budget can be chipped away before the timed fight starts).
// ---------------------------------------------------------------------------
const BOSS_BASE_HP = 550; // hp of the very first boss
const BOSS_HP_GROWTH_RATE = 1.35; // +35% hp per boss encounter, compounding
const BOSS_HP_RESET_COUNT = 16; // wave 80 (bosses spawn every 5 waves) -- the mid-game checkpoint, see BOSS TUNING above
const BOSS_HP_RESET_BEATABLE_SECONDS = 5; // boss #BOSS_HP_RESET_COUNT's hp is set so it's a clean kill in this many seconds at THIS run's actual DPS at that moment
const MAX_DMG_PER_VOLLEY = 25;
const FIREPOWER_VOLLEYS_PER_SECOND_MAX = 45; // hard ceiling on bullet-spawn rate; see getFirepower()
const BOSS_INVULN_MS = 500;

// ---------------------------------------------------------------------------
// BOSS ROTATION -- boss #1 is always the plain intro fight, and the moon
// boss keeps top priority on its own fixed schedule: first at bossCount ===
// MOON_FIRST_BOSS_COUNT, then again every MOON_REPEAT_INTERVAL encounters
// after that (3, 6, 9, 12...). Every other encounter round-robins through
// NON_MOON_TYPE_ORDER, advancing one step past whatever non-moon type came
// before it -- tracked via this.lastNonMoonTypeIndex, NOT this.lastBossType,
// specifically so a moon encounter in between doesn't reset the rotation.
// (Earlier version derived the next index via
// NON_MOON_TYPE_ORDER.indexOf(this.lastBossType), which returned -1 right
// after a moon boss and silently reset to index 0 every time -- since the
// moon repeats every 3 encounters, the same length as NON_MOON_TYPE_ORDER,
// that reset always landed right before index 2 would come up, making
// 'water' mathematically unreachable rather than just rare. Persisting the
// index across moon encounters fixes that while still guaranteeing no
// non-moon type repeats back to back.) See getBossType() /
// this.lastNonMoonTypeIndex.
// ---------------------------------------------------------------------------
const MOON_FIRST_BOSS_COUNT = 3;
const MOON_REPEAT_INTERVAL = 3;
const NON_MOON_TYPE_ORDER = ['basic', 'fire', 'water'];
const BOSS_TEXTURE_BY_TYPE = { basic: 'bossBasic', fire: 'bossFire', crescent: 'bossCrescent', water: 'bossWater' };

// ---------------------------------------------------------------------------
// BOSS MOVEMENT -- movement style is per-type now, not a global escalation:
//   - basic (lightning): holds perfectly still. Its threat is the timed
//     lightning strike instead of evasion (see LIGHTNING below).
//   - crescent: floats up and down instead of side to side.
//   - fire AND water: share the original side-to-side evasion (no unique
//     movement was specified for water, so it reuses this rather than
//     introducing a 4th pattern). Bosses 1..BOSS_OSCILLATE_COUNT just
//     wander; beyond that they reactively dodge by biasing away from the
//     player's firing column (formationX). Escalates by total boss count.
// ---------------------------------------------------------------------------
const BOSS_OSCILLATE_COUNT = 5;
const BOSS_OSCILLATE_RANGE = 90; // +/- px from the boss's lock-in x
const BOSS_OSCILLATE_FREQ = 1.1; // rad/sec
const BOSS_DODGE_SPEED = 160; // px/sec, reactive-dodge bosses
const BOSS_DODGE_TRIGGER_PX = 40; // how close the boss must drift toward the firing column before it commits to fleeing the other way
const BOSS_FLOAT_RANGE = 35; // +/- px, crescent boss's vertical bob amplitude
const BOSS_FLOAT_FREQ = 0.9; // rad/sec

// ---------------------------------------------------------------------------
// FIREBALL -- exclusive to the Fire boss type: it telegraphs and throws one
// at 50% HP every time it appears. Basic and Crescent stay attack-free aside
// from their own mechanics (lightning strike / star drop).
// It fires one fireball at each quarter-health threshold crossed
// (75%, 50%, 25% HP remaining) -- 3 over the course of the fight, one at a
// time, each with its own telegraph.
// Invincible -- bullets are absorbed on contact (onBulletHitFireball) but do
// no damage, so it can't be shot down. The only counterplay is dodging it;
// getting hit costs FIREBALL_ARMY_DMG_PCT of the current army.
// ---------------------------------------------------------------------------
const FIREBALL_HP_THRESHOLDS = [0.75, 0.5, 0.25];
const FIREBALL_SPEED = 260; // px/sec
const FIREBALL_ARMY_DMG_PCT = 0.25; // fraction of current army lost if it connects -- was 0.08, raised since dodging is now the only counterplay
const FIREBALL_ARMY_DMG_MIN = 3;
const FIREBALL_SCALE = 1.4; // visual + hitbox size multiplier -- bigger means it blocks more of the player's firing columns

// ---------------------------------------------------------------------------
// WATER SPRAY -- exclusive to the Water boss type. Runs for the whole fight
// (not threshold-based like the fireball): a repeating 2s-on/1s-off duty
// cycle, "on" meaning it emits a steady stream of small droplets (a genuine
// spray, not one lone projectile) every WATER_SPRAY_INTERVAL_MS for the
// full on-duration -- droplet count per burst is derived from WATER_ON_MS /
// WATER_SPRAY_INTERVAL_MS rather than hardcoded, so it automatically keeps
// spraying for the whole "on" window instead of finishing early and sitting
// idle if either constant changes. "off" is a pause before the next burst.
// Each droplet is shootable (unlike the now-invincible fireball), with a
// smaller army-damage hit if it connects since it repeats far more often
// than the fireball's few-per-fight threshold triggers -- meant to be a
// naggy, attritional threat you can chip away at rather than a single big
// spike. WATER_DROPLET_DESTROY_SECONDS/_HP_MIN/_HP_MAX are scaled together
// by WATER_DROPLET_HP_SCALE (1.75x, was 0.4s/8/60 pre-scale) so hp scales to
// exactly that factor for any DPS: the hp formula clamps dps*seconds between
// min and max, and clamp(k*x, k*lo, k*hi) == k*clamp(x, lo, hi) for any
// positive k, so scaling all three by the same factor scales the actual
// result by that same factor at every possible firepower, not just at the
// clamp's extremes. (Tried 3x first -- knocked back down to 1.75x.)
// ---------------------------------------------------------------------------
const WATER_ON_MS = 2000;
const WATER_OFF_MS = 1000;
const WATER_SPRAY_INTERVAL_MS = 220;
const WATER_DROPLET_HP_SCALE = 1.75;
const WATER_DROPLET_DESTROY_SECONDS = 0.4 * WATER_DROPLET_HP_SCALE;
const WATER_DROPLET_HP_MIN = Math.round(8 * WATER_DROPLET_HP_SCALE);
const WATER_DROPLET_HP_MAX = Math.round(60 * WATER_DROPLET_HP_SCALE);
const WATER_DROPLET_SPEED = 300; // px/sec
const WATER_ARMY_DMG_PCT = 0.03; // fraction of current army lost if it connects
const WATER_ARMY_DMG_MIN = 2;

// ---------------------------------------------------------------------------
// LIGHTNING STRIKE -- the basic boss's attack. It stands still and charges
// for the first half of its fight timer (a growing electric glow is the
// tell), then at exactly the halfway point strikes straight down in the
// column under wherever it's standing. Since the boss doesn't move, dodging
// is entirely on the player: steer the army out of that column before the
// strike lands, or lose 90% of the current army -- severe enough that
// eating one is close to a run-ender, not just a setback.
// ---------------------------------------------------------------------------
const LIGHTNING_STRIKE_HALF_WIDTH = 45; // px -- how far from the strike column you must be to dodge it
const LIGHTNING_STRIKE_ARMY_SURVIVAL_PCT = 0.10; // fraction of the army left standing if it connects

// ---------------------------------------------------------------------------
// STAR UPGRADE -- dropped by the Moon boss on death only (tried dropping one
// from every boss to counteract boss HP scaling, but that made every
// post-#1 fight too easy -- back to Moon-exclusive while balance gets
// tuned by hand instead).
// Every tier -- the first 5 hand-authored ones AND the uncapped procedural
// ones after -- now grants a COMBINED damage + fire-rate multiplier
// together, rather than splitting bonuses across separate tiers. That
// split was the original design (tiers 1-3 damage-only, 4-5 rate-only) but
// it wastes most of each pickup's potential: total DPS = damage x rate, so
// growing only one factor at a time leaves the other sitting idle. With
// moon now every 3rd boss, there's a real gap (boss #10-11) where only 3
// pickups exist before the 4th arrives at boss #12 -- simulation showed the
// split design couldn't clear wave 55 even fully maxed, while the combined
// version clears it with real margin. STAR_TIER_MULT covers the first 5
// (their hand-authored look is unchanged, only the math); STAR_POWER_
// GROWTH_RATE covers tier 6+ (uncapped, procedural color + bullet design --
// see collectStarUpgrade() / generateStarBulletTexture()). Colors step around
// the hue wheel by the golden angle (STAR_HUE_STEP) instead of picking
// randomly, which guarantees consecutive pickups never look similar without
// needing a "don't repeat" check.
// ---------------------------------------------------------------------------
const STAR_TIER_MULT = 1.25; // combined dmg+rate multiplier, tiers 1-5
const STAR_TIERS = [
  { armyTint: 0x33ff66, bulletTexture: 'bulletTier1', label: 'Green' },
  { armyTint: 0x3388ff, bulletTexture: 'bulletTier2', label: 'Blue' },
  { armyTint: 0xaa44ff, bulletTexture: 'bulletTier3', label: 'Purple' },
  { armyTint: 0x9a9a9a, bulletTexture: 'bulletTier4', label: 'Grey' },
  { armyTint: 0x1a1a1a, bulletTexture: 'bulletTier5', label: 'Black' },
];
const STAR_POWER_GROWTH_RATE = 1.25; // tier 6+ -- was 1.16, bumped to match STAR_TIER_MULT so there's no dip transitioning from hand-authored into procedural tiers
const STAR_HUE_STEP = 0.6180339887; // golden angle conjugate, in turns (0..1)

// ---------------------------------------------------------------------------
// EXPLOSIVE BULLETS -- from the Black tier onward (starTier >= STAR_TIERS.length,
// tier 6+ stays explosive too since it's strictly stronger than Black), every
// bullet also splashes on impact: on top of its direct hit, it deals
// EXPLOSION_DMG_MULT x its own (already star-upgraded) damage to every other
// enemy within EXPLOSION_RADIUS_PX. The 1.5x is on top of, not instead of,
// whatever starDmgMult has already done to dmgPerBullet.
// ---------------------------------------------------------------------------
const EXPLOSIVE_TIER = STAR_TIERS.length;
const EXPLOSION_RADIUS_PX = 55;
const EXPLOSION_DMG_MULT = 1.5;

// ---------------------------------------------------------------------------
// ENEMY WAVE ESCALATION -- controls how brutal the game gets over time.
// ENEMY_COUNT_BASE/PER_WAVE/MAX: how many red blocks spawn per wave, growing
// with waveIndex up to a hard cap.
// ENEMY_HP_EVERY_N_WAVES: enemies start at 1 HP and gain +1 HP every N waves,
// so late-game blocks take multiple hits -- a weak army can get swarmed
// because it can't clear a wave fast enough before it reaches the formation.
// ENEMY_BREACH_DMG_EVERY_N_WAVES: how much army you lose per enemy that
// reaches you scales up too, so a breach hurts more the deeper you are.
// SPAWN_GAP_MIN_PX / SPAWN_GAP_SHRINK_PER_WAVE: waves start ~900px apart and
// get closer together (more frequent) as waveIndex climbs, floored at the min.
// ---------------------------------------------------------------------------
const ENEMY_COUNT_BASE = 5;
const ENEMY_COUNT_PER_WAVE = 1.6;
const ENEMY_COUNT_MAX = 60;
const ENEMY_HP_EVERY_N_WAVES = 6;
const ENEMY_BREACH_DMG_EVERY_N_WAVES = 12;
const SPAWN_GAP_MIN_PX = 480;
const SPAWN_GAP_SHRINK_PER_WAVE = 10;

// ---------------------------------------------------------------------------
// RAINBOW BLASTER -- a temporary weapon buff earned by killing red enemies
// (only red enemies count, not bosses). Progress persists across waves
// (no reset), and the threshold scales with how many enemies the current
// wave spawned, so it naturally gets harder to re-earn as the game ramps up
// -- and naturally plateaus once ENEMY_COUNT_MAX is hit, so it never needs
// an unbounded formula of its own.
// It does NOT fire the instant the bar caps out -- registerRedKill() stops
// accumulating and holds the bar full, a button appears below it, and the
// player has to tap that button (activateRainbowChargeButton) to actually
// spend the charge, so activation lands on a moment the player chooses
// rather than whatever's on screen when the last needed kill happens to land.
// While active: bullets curve in a sine wave as they travel (sweeps the
// whole lane width -- useful against both enemy groups and dodging bosses),
// cycle through rainbow hues, and fire rate spikes under its OWN higher
// ceiling (RAINBOW_RATE_CAP) rather than the permanent FIREPOWER_VOLLEYS_
// PER_SECOND_MAX, so the burst genuinely feels faster than normal play
// without reopening the runaway-bullet-creation risk that cap exists for.
// Re-triggering while already active just refreshes the duration rather
// than stacking multiple instances.
// ---------------------------------------------------------------------------
const RED_KILL_CHARGE_MULTIPLIER = 3.5; // threshold = round(currentWaveEnemyCount * this) -- doubled from 1.75
const RAINBOW_DURATION_MS = 4000;
const RAINBOW_RATE_MULT = 1.8;
const RAINBOW_RATE_CAP = 65; // buff-only ceiling, higher than FIREPOWER_VOLLEYS_PER_SECOND_MAX
const RAINBOW_CURVE_AMPLITUDE = 55; // px
const RAINBOW_CURVE_FREQ = 4; // rad/sec-ish, per-bullet curve time

// h, s, v in [0, 1] -> 0xRRGGBB. Self-contained rather than relying on
// Phaser.Display.Color's HSV support, to keep this a plain, dependency-free
// utility like the rest of the game's procedural texture code.
function hsvToHex(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return (Math.round(r * 255) << 16) + (Math.round(g * 255) << 8) + Math.round(b * 255);
}

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  create() {
    this.cameras.main.setBackgroundColor('#0f4a80'); // ocean fallback in case the water tile doesn't fully cover on odd aspect ratios
    this.drawRoad();

    // ---- core state ----
    this.army = 1;
    this.distance = 0;
    this.score = 0;
    this.kills = 0; // number of red blocks (enemies) destroyed
    this.scrollSpeed = BASE_SCROLL_SPEED;
    this.waveIndex = 0;
    this.bossCount = 0; // increments per boss spawn; drives movement style + which boss type is up
    this.lastNonMoonTypeIndex = -1; // index into NON_MOON_TYPE_ORDER, persists through moon encounters -- see BOSS ROTATION comment
    this.bossHpResetAnchor = null; // set once, at boss #BOSS_HP_RESET_COUNT -- see getBossHp() / BOSS TUNING comment
    this.bossPouncing = false; // true during the timer-runs-out death-blow cinematic (see bossPounceAndGameOver)
    this.starTier = 0; // uncapped -- total stars collected this run
    this.starDmgMult = 1; // every tier multiplies this directly now (STAR_TIER_MULT for 1-5, STAR_POWER_GROWTH_RATE for 6+)
    this.starRateMult = 1;
    this.starHue = Phaser.Math.FloatBetween(0, 1); // rotates by STAR_HUE_STEP each pickup from tier 6 onward
    this.currentArmyColor = null; // set the first time a star is collected; applied to all soldier sprites
    this.currentBulletTexture = 'bullet';
    this.redKillCharge = 0; // running count of red-enemy kills toward the rainbow blaster; persists across waves
    this.currentWaveEnemyCount = ENEMY_COUNT_BASE; // last spawned wave's enemy count, drives the charge threshold
    this.rainbowChargeReady = false; // true once the bar is full -- holds there (stops accumulating) until the player taps the button to actually activate it
    this.rainbowActive = false;
    this.rainbowEndTime = 0;
    this.rainbowHue = 0;
    this.state = 'playing'; // 'playing' | 'boss' | 'gameover'
    // gates the whole update() loop (see update()) until the player's first
    // tap/click -- mobile always fires a touchstart to steer, which the
    // browser counts as the gesture that unlocks Web Audio, but on desktop
    // this game is fully playable via pure mouse hover (pointermove alone
    // steers, no click needed), and passive mouse movement does NOT count
    // as a gesture. A hover-only desktop session could play the entire game
    // with sound permanently stuck locked. Forcing one tap before anything
    // moves guarantees the gesture fires on every platform.
    this.gameStarted = false;
    this.formationX = GAME_WIDTH / 2;
    this.targetX = this.formationX;
    this.fireAccumulator = 0;
    this.nextSpawnAt = 900; // distance (px) until next spawn
    this.spawnGapPx = 900;

    // ---- groups ----
    this.soldierSprites = this.add.group();
    this.bullets = this.physics.add.group({ maxSize: 400 });
    this.enemies = this.physics.add.group();
    this.gates = this.physics.add.group();
    this.fireballs = this.physics.add.group();
    this.waterDroplets = this.physics.add.group();
    this.stars = this.physics.add.group();
    this.boss = null;
    this.bossHpBarBg = null;
    this.bossHpBarFill = null;

    // invisible collider representing the player's formation footprint
    this.playerCollider = this.physics.add.sprite(this.formationX, PLAYER_Y, null);
    this.playerCollider.body.setSize(70, 20);
    this.playerCollider.setVisible(false);
    this.playerCollider.body.allowGravity = false;

    this.buildSoldierFormation();

    // ---- input: drag / pointer / arrow keys all move the formation ----
    this.input.on('pointermove', (p) => {
      if (!this.gameStarted || this.state === 'gameover' || this.isPointerOnRainbowButton(p)) return;
      this.targetX = Phaser.Math.Clamp(p.x, ROAD_LEFT + 30, ROAD_RIGHT - 30);
    });
    this.input.on('pointerdown', (p) => {
      if (!this.gameStarted || this.state === 'gameover' || this.isPointerOnRainbowButton(p)) return;
      this.targetX = Phaser.Math.Clamp(p.x, ROAD_LEFT + 30, ROAD_RIGHT - 30);
    });
    this.cursors = this.input.keyboard.createCursorKeys();

    // ---- collisions ----
    this.physics.add.overlap(this.bullets, this.enemies, this.onBulletHitEnemy, null, this);
    this.physics.add.overlap(this.playerCollider, this.gates, this.onPlayerHitGate, null, this);
    this.physics.add.overlap(this.playerCollider, this.enemies, this.onPlayerHitEnemyRow, null, this);
    this.physics.add.overlap(this.bullets, this.fireballs, this.onBulletHitFireball, null, this);
    this.physics.add.overlap(this.playerCollider, this.fireballs, this.onFireballHitPlayer, null, this);
    this.physics.add.overlap(this.bullets, this.waterDroplets, this.onBulletHitWaterDroplet, null, this);
    this.physics.add.overlap(this.playerCollider, this.waterDroplets, this.onWaterDropletHitPlayer, null, this);
    // no overlap for stars -- collection is now position-triggered by y
    // alone (updateStarPickups), not a physics hit against the player

    this.sfxLastPlayed = {};

    this.buildUI();
    if (this.sound.locked) {
      // first-ever load in this browser session -- gate on a tap
      this.buildStartOverlay();
      this.input.once('pointerdown', () => this.startGame());
    } else {
      // scene.restart() re-runs create(), but the Sound Manager (and its
      // unlocked state) persists across scene restarts -- the gesture
      // requirement is already satisfied, so don't make a replay tap twice
      // (once for "TAP TO RESTART", again for this overlay) for no reason
      this.gameStarted = true;
      this.showIntro();
    }
  }

  // most sfx just fire-and-forget via this.sound.play(); shoot and
  // player-hit can otherwise be called dozens of times per second (fire
  // rate scales up to 65 volleys/sec, and a big breach fires one call per
  // enemy in a single frame), which would drown into noise unthrottled.
  playSfxThrottled(key, minGapMs, config) {
    const now = this.time.now;
    const last = this.sfxLastPlayed[key] || 0;
    if (now - last < minGapMs) return;
    this.sfxLastPlayed[key] = now;
    this.sound.play(key, config);
  }

  // ---------------- visuals ----------------

  drawRoad() {
    // ocean backdrop, full-width, behind everything -- the road reads as a
    // bridge crossing water
    this.waterTile = this.add.tileSprite(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 'water');
    this.waterTile.setDepth(-1);

    const road = this.add.tileSprite(GAME_WIDTH / 2, GAME_HEIGHT / 2, ROAD_RIGHT - ROAD_LEFT, GAME_HEIGHT, 'road');
    road.setDepth(0);
    this.roadTile = road;
    // bridge railings mark the road's edge against the water
    this.add.rectangle(ROAD_LEFT - 6, GAME_HEIGHT / 2, 6, GAME_HEIGHT, 0x4a4a52).setDepth(0);
    this.add.rectangle(ROAD_RIGHT + 6, GAME_HEIGHT / 2, 6, GAME_HEIGHT, 0x4a4a52).setDepth(0);
    this.add.rectangle(ROAD_LEFT, GAME_HEIGHT / 2, 2, GAME_HEIGHT, 0x8a8a96).setDepth(0);
    this.add.rectangle(ROAD_RIGHT, GAME_HEIGHT / 2, 2, GAME_HEIGHT, 0x8a8a96).setDepth(0);

    // two dashed dividers split the road into 3 even lanes
    const laneWidth = (ROAD_RIGHT - ROAD_LEFT) / 3;
    this.laneDividers = [ROAD_LEFT + laneWidth, ROAD_LEFT + laneWidth * 2].map((x) => {
      const d = this.add.tileSprite(x, GAME_HEIGHT / 2, 8, GAME_HEIGHT, 'laneDivider');
      d.setDepth(1);
      return d;
    });
  }

  buildUI() {
    const style = { fontFamily: 'Segoe UI, sans-serif', fontSize: '22px', color: '#ffffff', fontStyle: 'bold' };
    this.armyText = this.add.text(16, 14, 'Army: 1', style).setScrollFactor(0).setDepth(20);
    this.distText = this.add.text(GAME_WIDTH - 16, 14, 'Wave: 0', style).setScrollFactor(0).setDepth(20).setOrigin(1, 0);
    this.distText.setOrigin(1, 0);
    this.scoreText = this.add.text(16, 42, 'Blocks: 0   Score: 0', {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '16px', color: '#ffe066', fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(20);

    this.starStatusText = this.add.text(16, 64, 'PWR: +0%   RATE: +0%', {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '16px', color: '#ffffff', fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(20);

    // rainbow-blaster charge meter -- vertical bar in the left margin (the
    // water strip outside the road), fills upward as red enemies are
    // killed, sweeping red -> violet across the rainbow spectrum as it
    // fills (see updateChargeBar). Once full it holds there and a button
    // appears below it -- the player taps that to actually activate the
    // blaster (see registerRedKill / activateRainbowChargeButton), rather
    // than it firing automatically the instant it caps out.
    this.add.text(12, 260, 'CHRG', {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '12px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(20);
    this.chargeBarBg = this.add.rectangle(12, 430, 14, 300, 0x222222, 0.8).setScrollFactor(0).setDepth(20);
    this.chargeBarFill = this.add.rectangle(12, 580, 14, 0, 0xff2222).setOrigin(0.5, 1).setScrollFactor(0).setDepth(21);

    this.rainbowButtonBg = this.add.rectangle(12, 610, 28, 32, 0xff2222, 0.95)
      .setStrokeStyle(2, 0xffffff, 0.9)
      .setScrollFactor(0).setDepth(21).setVisible(false);
    this.rainbowButtonBg.setInteractive({ useHandCursor: true });
    // stopPropagation, not a this.rainbowChargeReady check in the scene-level
    // handler below -- this object's own pointerdown fires (and flips
    // rainbowChargeReady to false) BEFORE the scene-level 'pointerdown'
    // listener runs for the same click, so a flag check there would already
    // see the post-activation state and let the click fall through to move
    // the formation instead of being swallowed by the button
    this.rainbowButtonBg.on('pointerdown', (pointer, localX, localY, event) => {
      event.stopPropagation();
      this.activateRainbowChargeButton();
    });
    this.rainbowButtonText = this.add.text(12, 610, 'GO', {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '13px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(22).setVisible(false);

    this.gameOverText = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 70, '', {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '28px', color: '#ff5555', fontStyle: 'bold', align: 'center', lineSpacing: 8,
    }).setOrigin(0.5).setDepth(30).setVisible(false);

    this.restartText = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 110, 'TAP TO RESTART', {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '22px', color: '#ffffff',
    }).setOrigin(0.5).setDepth(30).setVisible(false);
  }

  // blocks the whole update() loop (see update()) until dismissed -- see the
  // gameStarted comment in create() for why this exists. Sits above
  // everything, including the road/formation, which are already visible
  // underneath so the scene doesn't look empty while waiting for the tap.
  buildStartOverlay() {
    this.startOverlayBg = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.55)
      .setScrollFactor(0).setDepth(35);
    this.startOverlayTitle = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'TAP TO START', {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '32px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(36);
  }

  startGame() {
    this.gameStarted = true;
    this.startOverlayBg.destroy();
    this.startOverlayTitle.destroy();
    this.showIntro();
  }

  // arcade-attract-mode title card, played once over the empty road at the
  // very start of a run (before wave 1's first gate/enemy wave arrives at
  // ~900px of scroll, roughly 3.5-4s in) -- bursts in, marquee-cycles
  // through the hue wheel like a real arcade cabinet sign, then fades out
  // with time to spare before anything actually spawns.
  showIntro() {
    const title1 = this.add.text(GAME_WIDTH / 2, 260, 'WELCOME TO', {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '22px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(28).setAlpha(0).setScrollFactor(0);

    const title2 = this.add.text(GAME_WIDTH / 2, 302, 'ROAD RUNNER', {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '42px', color: '#ffe066', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(28).setAlpha(0).setScale(0.6).setScrollFactor(0);

    this.tweens.add({ targets: [title1, title2], alpha: 1, duration: 400, ease: 'Sine.easeOut' });
    this.tweens.add({ targets: title2, scale: 1, duration: 500, ease: 'Back.easeOut' });

    let introHue = 0.12; // start near gold, matching title1's white/title2's initial yellow before it starts cycling
    const colorTimer = this.time.addEvent({
      delay: 60,
      loop: true,
      callback: () => {
        introHue = (introHue + 0.02) % 1;
        title2.setColor(`#${hsvToHex(introHue, 0.85, 1).toString(16).padStart(6, '0')}`);
      },
    });

    this.time.delayedCall(2200, () => {
      this.tweens.add({
        targets: [title1, title2],
        alpha: 0,
        y: '-=30',
        duration: 500,
        onComplete: () => {
          title1.destroy();
          title2.destroy();
          colorTimer.remove(false);
        },
      });
    });
  }

  updateScoreText() {
    this.scoreText.setText(`Blocks: ${this.kills}   Score: ${this.score}`);
  }

  updateStarStatusText() {
    const dmgPct = Math.round((this.starDmgMult - 1) * 100);
    const ratePct = Math.round((this.starRateMult - 1) * 100);
    this.starStatusText.setText(`PWR: +${dmgPct}%   RATE: +${ratePct}%`);
  }

  getRedKillChargeThreshold() {
    return Math.max(5, Math.round(this.currentWaveEnemyCount * RED_KILL_CHARGE_MULTIPLIER));
  }

  updateChargeBar() {
    const pct = Phaser.Math.Clamp(this.redKillCharge / this.getRedKillChargeThreshold(), 0, 1);
    this.chargeBarFill.height = 300 * pct;
    // sweeps red (empty) -> violet (full) as it charges, rather than a flat
    // red fill -- doubles as a second "how close am I" signal alongside height
    this.chargeBarFill.setFillStyle(hsvToHex(pct * 0.8, 0.9, 1.0), 1);
  }

  // only red-enemy kills feed the charge -- called from onBulletHitEnemy.
  // Charge holds at full once ready instead of auto-firing -- the player
  // has to tap the button (see activateRainbowChargeButton) to spend it.
  registerRedKill() {
    if (this.rainbowChargeReady) return;
    this.redKillCharge += 1;
    if (this.redKillCharge >= this.getRedKillChargeThreshold()) {
      this.redKillCharge = this.getRedKillChargeThreshold();
      this.rainbowChargeReady = true;
      this.showRainbowButton();
    }
    this.updateChargeBar();
  }

  isPointerOnRainbowButton(pointer) {
    return this.rainbowChargeReady && this.rainbowButtonBg.getBounds().contains(pointer.x, pointer.y);
  }

  showRainbowButton() {
    this.rainbowButtonBg.setVisible(true).setScale(0.85);
    this.rainbowButtonText.setVisible(true).setScale(0.85);
    this.rainbowButtonPulse = this.tweens.add({
      targets: [this.rainbowButtonBg, this.rainbowButtonText],
      scale: { from: 0.85, to: 1.05 },
      duration: 380,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  hideRainbowButton() {
    if (this.rainbowButtonPulse) { this.rainbowButtonPulse.stop(); this.rainbowButtonPulse = null; }
    this.rainbowButtonBg.setVisible(false).setScale(1);
    this.rainbowButtonText.setVisible(false).setScale(1);
  }

  // fired by tapping the charge button once it's full
  activateRainbowChargeButton() {
    if (this.state === 'gameover' || !this.rainbowChargeReady) return;
    this.rainbowChargeReady = false;
    this.redKillCharge = 0;
    this.hideRainbowButton();
    this.updateChargeBar();
    this.activateRainbowBlaster();
  }

  activateRainbowBlaster() {
    if (!this.rainbowActive) {
      this.rainbowActive = true;
      this.showFloatingText(this.formationX, PLAYER_Y - 80, 'RAINBOW BLASTER!', '#ff66ff');
    }
    // re-triggering while already active just refreshes the duration rather than stacking
    this.rainbowEndTime = this.time.now + RAINBOW_DURATION_MS;
  }

  buildSoldierFormation() {
    this.soldierSprites.clear(true, true);
    const shown = Math.min(this.army, MAX_SOLDIERS_RENDERED);
    const cols = Math.min(10, Math.ceil(Math.sqrt(shown)) + 1);
    const rows = Math.ceil(shown / cols);
    const spacing = 20;
    for (let i = 0; i < shown; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const offsetX = (col - (cols - 1) / 2) * spacing;
      const offsetY = row * spacing;
      const s = this.add.image(this.formationX + offsetX, PLAYER_Y + offsetY, 'soldier');
      s.setDepth(8);
      s.setData('offsetX', offsetX);
      s.setData('offsetY', offsetY);
      if (this.currentArmyColor !== null) s.setTint(this.currentArmyColor);
      this.soldierSprites.add(s);
    }
  }

  updateFormationVisual() {
    // rebuild only when the rendered count actually changes, cheap enough here
    const shown = Math.min(this.army, MAX_SOLDIERS_RENDERED);
    if (this.soldierSprites.getLength() !== shown) {
      this.buildSoldierFormation();
    } else {
      this.soldierSprites.getChildren().forEach((s) => {
        s.x = this.formationX + s.getData('offsetX');
      });
    }
  }

  // ---------------- main loop ----------------

  update(time, delta) {
    if (!this.gameStarted || this.state === 'gameover') return;
    // clamp so a lag spike or backgrounded/resumed tab (huge `delta`) can't
    // make handleAutoFire's accumulator catch up in one massive burst of
    // bullet creation in a single frame -- caps the worst case regardless of
    // how high the star system has pushed volleysPerSecond
    const dt = Math.min(delta / 1000, 0.1);

    // difficulty ramps slowly with distance
    this.scrollSpeed = BASE_SCROLL_SPEED + Math.min(260, this.distance * 0.02);

    // smooth follow toward target x (keyboard nudge too)
    if (this.cursors.left.isDown) this.targetX -= 260 * dt;
    if (this.cursors.right.isDown) this.targetX += 260 * dt;
    this.targetX = Phaser.Math.Clamp(this.targetX, ROAD_LEFT + 30, ROAD_RIGHT - 30);
    this.formationX = Phaser.Math.Linear(this.formationX, this.targetX, Math.min(1, dt * 10));
    this.playerCollider.x = this.formationX;
    this.updateFormationVisual();

    // scroll world
    this.roadTile.tilePositionY -= this.scrollSpeed * dt;
    this.laneDividers.forEach((d) => { d.tilePositionY -= this.scrollSpeed * dt; });
    // slower, independent rate so the water reads as flowing beneath a fixed bridge rather than locked to your speed
    this.waterTile.tilePositionY -= this.scrollSpeed * dt * 0.35;
    this.distance += this.scrollSpeed * dt;
    this.distText.setText(`Wave: ${this.waveIndex}`);
    this.armyText.setText(`Army: ${this.army}`);

    this.scrollGroup(this.enemies, dt);
    this.scrollGroup(this.gates, dt);
    this.scrollGroup(this.stars, dt);
    this.updateStarPickups();
    this.scrollBoss(dt);
    this.updateBossMovement(dt);
    this.moveBullets(dt);
    this.updateFireballs(dt);
    this.updateWaterDroplets(dt);

    if (this.rainbowActive && this.time.now >= this.rainbowEndTime) {
      this.rainbowActive = false;
    }

    this.handleAutoFire(dt);
    this.checkSpawns();
    this.cleanupOffscreen();
  }

  scrollGroup(group, dt) {
    group.getChildren().forEach((obj) => {
      obj.y += this.scrollSpeed * dt;
      if (obj.getData('hpText')) obj.getData('hpText').y = obj.y;
      if (obj.getData('labelText')) obj.getData('labelText').y = obj.y;
    });
  }

  // collects any star pickup the instant its fall reaches the army's row --
  // x-position doesn't matter, only y, so it can't be missed by steering
  // wrong. Snapshotting the children array first because collectStarUpgrade
  // doesn't touch this.stars, but star.destroy() below does mutate the
  // group's live array mid-loop (same reasoning as triggerExplosion).
  updateStarPickups() {
    const pending = [...this.stars.getChildren()];
    pending.forEach((star) => {
      if (star.y < PLAYER_Y) return;
      this.collectStarUpgrade(star.x, PLAYER_Y);
      star.destroy();
    });
  }

  scrollBoss(dt) {
    if (!this.boss) return;
    if (this.boss.getData('locked')) return; // boss stops at engagement line
    this.boss.y += this.scrollSpeed * dt;
    if (this.bossGlow) this.bossGlow.y = this.boss.y;
    if (this.bossLabel) this.bossLabel.y = this.boss.y - 80;
    if (this.boss.y >= 220) {
      this.boss.setData('locked', true);
      this.boss.setData('lockX', this.boss.x);
      this.boss.setData('lockY', this.boss.y);
      this.boss.setData('invulnUntil', this.time.now + BOSS_INVULN_MS);
      this.startBossTimer();
    }
  }

  // movement once the boss has locked at the engagement line, branched by
  // boss type -- see the BOSS MOVEMENT comment up top for what each does.
  updateBossMovement(dt) {
    if (!this.boss || !this.boss.getData('locked') || this.bossPouncing) return;
    const bossType = this.boss.getData('bossType');
    const t = this.time.now / 1000;
    const phase = this.boss.getData('oscPhase') || 0;

    if (bossType === 'basic') {
      // holds perfectly still -- its threat is the timed lightning strike
    } else if (bossType === 'crescent') {
      const lockY = this.boss.getData('lockY') ?? 220;
      this.boss.y = lockY + Math.sin(t * BOSS_FLOAT_FREQ + phase) * BOSS_FLOAT_RANGE;
    } else {
      const minX = ROAD_LEFT + 70;
      const maxX = ROAD_RIGHT - 70;
      if (this.boss.getData('dodgeMode')) {
        const distFromPlayerX = this.boss.x - this.formationX;
        let dir = this.boss.getData('dodgeDir') || 1;
        if (Math.abs(distFromPlayerX) < BOSS_DODGE_TRIGGER_PX) {
          dir = distFromPlayerX >= 0 ? 1 : -1;
        }
        let nx = this.boss.x + dir * BOSS_DODGE_SPEED * dt;
        if (nx <= minX) { nx = minX; dir = 1; }
        if (nx >= maxX) { nx = maxX; dir = -1; }
        this.boss.setData('dodgeDir', dir);
        this.boss.x = nx;
      } else {
        const lockX = this.boss.getData('lockX') ?? GAME_WIDTH / 2;
        this.boss.x = Phaser.Math.Clamp(
          lockX + Math.sin(t * BOSS_OSCILLATE_FREQ + phase) * BOSS_OSCILLATE_RANGE,
          minX, maxX
        );
      }
    }

    if (this.bossGlow) { this.bossGlow.x = this.boss.x; this.bossGlow.y = this.boss.y; }
    if (this.bossLabel) { this.bossLabel.x = this.boss.x; this.bossLabel.y = this.boss.y - 80; }
  }

  moveBullets(dt) {
    this.bullets.getChildren().forEach((b) => {
      b.y -= 620 * dt;
      if (b.getData('curving')) {
        // per-bullet curve clock (not global time) so the sine starts at a
        // clean zero offset at spawn instead of popping to wherever a
        // shared clock happens to be
        const curveT = (b.getData('curveT') || 0) + dt;
        b.setData('curveT', curveT);
        const phase = b.getData('curvePhase') || 0;
        b.x += Math.sin(curveT * RAINBOW_CURVE_FREQ + phase) * RAINBOW_CURVE_AMPLITUDE * dt;
      }
    });
  }

  // invincible -- no hp bar to track, just cleans it up once it leaves play
  // (a hit is handled in onFireballHitPlayer, a dodge just lets it fly off)
  updateFireballs(dt) {
    this.fireballs.getChildren().forEach((fb) => {
      if (fb.y > GAME_HEIGHT + 60 || fb.x < -40 || fb.x > GAME_WIDTH + 40) {
        this.destroyFireball(fb);
      }
    });
  }

  destroyFireball(fb) {
    fb.destroy();
  }

  cleanupOffscreen() {
    this.bullets.getChildren().forEach((b) => {
      if (b.y < -20) b.destroy();
    });
    this.gates.getChildren().forEach((g) => {
      if (g.y > GAME_HEIGHT + 60) g.destroy();
    });
    this.stars.getChildren().forEach((s) => {
      if (s.y > GAME_HEIGHT + 60) s.destroy();
    });
    // enemies that slip past without being destroyed are handled in onPlayerHitEnemyRow
  }

  // ---------------- firing ----------------

  // A single source of truth for "how strong is the player right now" so that
  // regular combat and the boss-timer estimate always agree. Total DPS scales
  // with sqrt(army) rather than army directly -- linear scaling on both fire
  // rate AND damage AND bullet count compounds into absurd numbers fast
  // (that was the old bug: a big army could one-shot a boss before you even
  // saw it).
  getFirepower() {
    const firepower = Math.sqrt(this.army);
    let volleysPerSecond = Phaser.Math.Clamp(4 + firepower * 0.6, 4, 20);
    let dmgPerVolley = Phaser.Math.Clamp(Math.round(firepower * 1.5), 1, MAX_DMG_PER_VOLLEY);
    if (this.starTier > 0) {
      // deliberately applied after the clamp above -- the star should still
      // feel like a real power-up even once the army is big enough to have
      // already hit MAX_DMG_PER_VOLLEY on its own. Uncapped and compounding
      // by design -- this is what's supposed to help push the boss-HP-growth
      // "wall" further out (see BOSS TUNING comment up top).
      volleysPerSecond *= this.starRateMult;
      dmgPerVolley = Math.round(dmgPerVolley * this.starDmgMult);
    }
    if (this.rainbowActive) volleysPerSecond *= RAINBOW_RATE_MULT;
    // hard safety ceiling on bullet-SPAWN rate, independent of the uncapped
    // star growth above. Unlike damage (just a bigger number on an existing
    // bullet), fire rate controls how many bullet objects get created per
    // second -- left uncapped, enough star pickups push it into the hundreds
    // per second, and a single lag spike lets handleAutoFire's accumulator
    // catch up in one massive burst of object creation, freezing/crashing
    // the tab. Any growth beyond the ceiling gets redirected into damage
    // instead, so total DPS still scales -- only the object-creation rate is
    // capped, not the player's actual power. The rainbow blaster gets its
    // own higher temporary ceiling so the burst still feels dramatic.
    const volleysCap = this.rainbowActive ? RAINBOW_RATE_CAP : FIREPOWER_VOLLEYS_PER_SECOND_MAX;
    if (volleysPerSecond > volleysCap) {
      const overflowRatio = volleysPerSecond / volleysCap;
      volleysPerSecond = volleysCap;
      dmgPerVolley = Math.round(dmgPerVolley * overflowRatio);
    }
    const cols = Math.min(10, Math.max(1, Math.ceil(Math.sqrt(Math.min(this.army, MAX_SOLDIERS_RENDERED)))));
    const dmgPerBullet = Math.max(1, Math.round(dmgPerVolley / cols));
    return { volleysPerSecond, dmgPerVolley, dmgPerBullet, cols };
  }

  handleAutoFire(dt) {
    if (this.state === 'boss' && !this.boss) return;
    if (this.bossPouncing) return; // no point firing at a boss mid-death-blow
    const fp = this.getFirepower();
    this.fireAccumulator += dt * fp.volleysPerSecond;
    while (this.fireAccumulator >= 1) {
      this.fireAccumulator -= 1;
      this.fireVolley(fp);
    }
  }

  fireVolley(fp) {
    this.playSfxThrottled('shoot', 90, { volume: 0.25 });
    const spacing = 20;
    for (let c = 0; c < fp.cols; c++) {
      const offsetX = (c - (fp.cols - 1) / 2) * spacing;
      const b = this.bullets.get(this.formationX + offsetX, PLAYER_Y - 14, this.currentBulletTexture);
      if (!b) continue;
      b.setTexture(this.currentBulletTexture);
      b.setActive(true).setVisible(true);
      b.setDepth(10);
      if (b.body) b.body.reset(this.formationX + offsetX, PLAYER_Y - 14);
      b.setData('damage', fp.dmgPerBullet);
      b.setData('explosive', this.starTier >= EXPLOSIVE_TIER);
      if (this.rainbowActive) {
        // hue steps per bullet (not per volley) so a single volley reads as
        // a left-to-right rainbow gradient across its columns
        this.rainbowHue = (this.rainbowHue + 0.08) % 1;
        b.setTint(hsvToHex(this.rainbowHue, 0.9, 1.0));
        b.setData('curving', true);
        b.setData('curvePhase', Phaser.Math.FloatBetween(0, Math.PI * 2));
        b.setData('curveT', 0);
      } else {
        b.clearTint();
        b.setData('curving', false);
      }
    }
  }

  // ---------------- spawning ----------------

  checkSpawns() {
    if (this.state === 'boss') return; // hold the wave cadence until the current boss is defeated
    if (this.distance < this.nextSpawnAt) return;
    this.spawnGapPx = Math.max(SPAWN_GAP_MIN_PX, 900 - this.waveIndex * SPAWN_GAP_SHRINK_PER_WAVE);
    this.nextSpawnAt += this.spawnGapPx;
    this.waveIndex++;

    if (this.waveIndex % 5 === 0) {
      this.spawnBoss();
    } else {
      this.spawnGatePair();
      // stagger an enemy wave shortly after the gate
      this.time.delayedCall(450, () => {
        if (this.state !== 'gameover') this.spawnEnemyWave();
      });
    }
  }

  spawnGatePair() {
    // no guaranteed-wipe "both sides negative" pairs before the first boss
    // (bossCount === 0) -- the army starts at 1 and every sub value is >= 2,
    // so hitting roll 4 here isn't a real choice, it's an unavoidable game
    // over. Rejection sampling keeps the other 6 outcomes uniformly likely.
    let roll;
    do {
      roll = Phaser.Math.Between(0, 6);
    } while (this.bossCount === 0 && roll === 4);
    let leftVal, rightVal, leftType, rightType;
    if (roll === 0) { // safe round, both positive
      leftVal = Phaser.Math.Between(3, 8); rightVal = Phaser.Math.Between(3, 8);
      leftType = 'add'; rightType = 'add';
    } else if (roll === 1) { // risk/reward: multiplier vs modest add
      leftVal = 2; rightVal = Phaser.Math.Between(4, 9);
      leftType = 'mult'; rightType = 'add';
    } else if (roll === 2) { // classic: dodge the trap
      leftVal = Phaser.Math.Between(3, 7); rightVal = Phaser.Math.Between(3, 7);
      leftType = 'sub'; rightType = 'add';
    } else if (roll === 3) { // mirror of case 2
      leftVal = Phaser.Math.Between(5, 12); rightVal = 2;
      leftType = 'add'; rightType = 'mult';
    } else if (roll === 4) { // both negative -- pick the lesser evil
      leftVal = Phaser.Math.Between(2, 6); rightVal = Phaser.Math.Between(5, 11);
      leftType = 'sub'; rightType = 'sub';
    } else if (roll === 5) { // harsh sub vs a multiplier gamble
      leftVal = Phaser.Math.Between(6, 14); rightVal = 2;
      leftType = 'sub'; rightType = 'mult';
    } else { // mirror of case 5
      leftVal = 2; rightVal = Phaser.Math.Between(6, 14);
      leftType = 'mult'; rightType = 'sub';
    }

    const leftGate = this.makeGate(ROAD_LEFT + (ROAD_RIGHT - ROAD_LEFT) * 0.27, leftVal, leftType);
    const rightGate = this.makeGate(ROAD_LEFT + (ROAD_RIGHT - ROAD_LEFT) * 0.73, rightVal, rightType);
    // linking the pair enforces "pick one" -- see onPlayerHitGate
    leftGate.setData('partner', rightGate);
    rightGate.setData('partner', leftGate);
  }

  makeGate(x, value, type) {
    const key = type === 'sub' ? 'gateNegative' : 'gatePositive';
    const g = this.gates.create(x, -60, key);
    g.setDepth(4);
    g.body.allowGravity = false;
    g.setData('value', value);
    g.setData('type', type);
    g.setData('consumed', false);
    g.setImmovable(true);

    const label = type === 'add' ? `+${value}` : type === 'sub' ? `-${value}` : `x${value}`;
    const txt = this.add.text(x, -60, label, {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '28px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(5);
    g.setData('labelText', txt);
    g.on('destroy', () => txt.destroy());
    return g;
  }

  spawnEnemyWave() {
    const count = Phaser.Math.Clamp(ENEMY_COUNT_BASE + Math.floor(this.waveIndex * ENEMY_COUNT_PER_WAVE), ENEMY_COUNT_BASE, ENEMY_COUNT_MAX);
    this.currentWaveEnemyCount = count;
    this.updateChargeBar(); // threshold just changed -- reflect it immediately
    const enemyHp = 1 + Math.floor(this.waveIndex / ENEMY_HP_EVERY_N_WAVES);
    const cols = Math.min(10, count);
    const rows = Math.ceil(count / cols);
    const usableWidth = ROAD_RIGHT - ROAD_LEFT - 40;
    const spacingX = usableWidth / cols;
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = ROAD_LEFT + 20 + spacingX * col + spacingX / 2;
      const y = -40 - row * 30;
      const e = this.enemies.create(x, y, 'enemy');
      e.setDepth(6);
      e.body.allowGravity = false;
      e.setData('hp', enemyHp);
      e.setData('maxHp', enemyHp);
      if (enemyHp > 1) {
        // slight tint so tougher blocks are visually distinct from 1-hit ones
        e.setTint(0xff8f8f);
      }
    }
  }

  // bossCount is 1-indexed. Moon keeps its own fixed schedule: first at 3,
  // then every MOON_REPEAT_INTERVAL after (currently 3 -> 3, 6, 9, 12...).
  // Boss #1 is always the plain/harmless intro fight. Every other slot
  // round-robins through NON_MOON_TYPE_ORDER, advancing one step past
  // whatever the last boss was -- guaranteed to never repeat back to back.
  getBossType(bossCount) {
    if (bossCount === 1) {
      this.lastNonMoonTypeIndex = NON_MOON_TYPE_ORDER.indexOf('basic');
      return 'basic';
    }

    const isMoon = bossCount === MOON_FIRST_BOSS_COUNT
      || (bossCount > MOON_FIRST_BOSS_COUNT && (bossCount - MOON_FIRST_BOSS_COUNT) % MOON_REPEAT_INTERVAL === 0);
    if (isMoon) return 'crescent';

    this.lastNonMoonTypeIndex = (this.lastNonMoonTypeIndex + 1) % NON_MOON_TYPE_ORDER.length;
    return NON_MOON_TYPE_ORDER[this.lastNonMoonTypeIndex];
  }

  // see BOSS TUNING comment up top for the full rationale. Bosses before
  // BOSS_HP_RESET_COUNT follow the original uninterrupted compounding curve;
  // at exactly BOSS_HP_RESET_COUNT, hp is measured live from this run's
  // actual current DPS and that becomes the fixed baseline (bossHpResetAnchor)
  // that every later boss compounds from instead of boss #1's fixed hp.
  getBossHp() {
    if (this.bossCount < BOSS_HP_RESET_COUNT) {
      return Math.round(BOSS_BASE_HP * Math.pow(BOSS_HP_GROWTH_RATE, this.bossCount - 1));
    }
    if (this.bossCount === BOSS_HP_RESET_COUNT) {
      const fp = this.getFirepower();
      const estDps = Math.max(1, fp.volleysPerSecond * fp.dmgPerBullet * fp.cols);
      this.bossHpResetAnchor = Math.round(estDps * BOSS_HP_RESET_BEATABLE_SECONDS);
      return this.bossHpResetAnchor;
    }
    return Math.round(this.bossHpResetAnchor * Math.pow(BOSS_HP_GROWTH_RATE, this.bossCount - BOSS_HP_RESET_COUNT));
  }

  spawnBoss() {
    this.state = 'boss';
    this.bossCount += 1;
    const bossType = this.getBossType(this.bossCount);
    const isFirstBoss = this.bossCount === 1; // stays fully plain/harmless as an intro fight
    const baseHp = this.getBossHp();
    const hp = isFirstBoss ? Math.round(baseHp / 2) : baseHp; // boss #1 only -- half hp, half timer (see startBossTimer); every other boss is unaffected

    // glow sits just behind the boss sprite -- a separate object rather than
    // baked into the texture, so depth ordering is unambiguous
    this.bossGlow = this.add.circle(GAME_WIDTH / 2, -100, 85, 0xff2f6b, 0.35);
    this.bossGlow.setDepth(11);

    const textureKey = (bossType === 'basic' && isFirstBoss) ? 'bossBasicPlain' : BOSS_TEXTURE_BY_TYPE[bossType];
    this.boss = this.physics.add.sprite(GAME_WIDTH / 2, -100, textureKey);
    this.boss.setDepth(12);
    this.boss.body.allowGravity = false;
    // hit tolerance is much wider than the sprite itself so near-center hits
    // still register -- you shouldn't need pixel-perfect alignment to fight it
    this.boss.body.setSize(220, 130);
    this.boss.body.setOffset((130 - 220) / 2, 0);
    this.boss.setData('hp', hp);
    this.boss.setData('maxHp', hp);
    this.boss.setData('locked', false);
    this.boss.setData('bossType', bossType);
    this.boss.setData('dodgeMode', this.bossCount > BOSS_OSCILLATE_COUNT);
    this.boss.setData('dodgeDir', 1);
    this.boss.setData('oscPhase', Phaser.Math.FloatBetween(0, Math.PI * 2));
    this.boss.setData('canFireball', bossType === 'fire');
    this.boss.setData('firedThresholds', new Set());
    this.boss.setData('fireballPending', false);
    this.boss.setData('hasLightningAttack', bossType === 'basic' && !isFirstBoss);
    this.boss.setData('hasWaterAttack', bossType === 'water');
    this.boss.setData('isFirstBoss', isFirstBoss);
    if (this.bossCollider) this.bossCollider.destroy();
    this.bossCollider = this.physics.add.overlap(this.bullets, this.boss, this.onBulletHitBoss, null, this);

    this.bossLabel = this.add.text(GAME_WIDTH / 2, this.boss.y - 80, 'BOSS', {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '30px', color: '#ffe066', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(22);

    this.tweens.add({
      targets: this.boss,
      scale: { from: 1, to: 1.08 },
      duration: 450,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    this.tweens.add({
      targets: this.bossGlow,
      scale: { from: 1, to: 1.15 },
      alpha: { from: 0.35, to: 0.15 },
      duration: 450,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    this.bossHpBarBg = this.add.rectangle(GAME_WIDTH / 2, 130, 280, 20, 0x333333).setDepth(20);
    this.bossHpBarFill = this.add.rectangle(GAME_WIDTH / 2 - 138, 130, 276, 16, 0xff3355).setOrigin(0, 0.5).setDepth(21);

    this.showFloatingText(GAME_WIDTH / 2, PLAYER_Y - 100, 'BOSS INCOMING!', '#ffe066');
    this.sound.play('boss-incoming', { volume: 0.5 });
  }

  startBossTimer() {
    // fair time limit: estimate current DPS from the same firepower calc used
    // in combat, and give roughly 2.2x the time needed at that firepower,
    // clamped to a sane range either direction
    const fp = this.getFirepower();
    const estDps = Math.max(1, fp.volleysPerSecond * fp.dmgPerBullet * fp.cols);
    const hp = this.boss.getData('hp');
    let timeLimit = Phaser.Math.Clamp((hp / estDps) * 2200, 7000, 15000); // bounds were 14000/30000 (half)
    // boss #1 only -- shortened explicitly AFTER the clamp, since the raw
    // computed value almost always exceeds the 15s cap this early anyway
    // (tiny starting army), so shrinking hp beforehand wouldn't actually
    // change the timer on its own
    if (this.boss.getData('isFirstBoss')) timeLimit /= 1.5;

    this.bossTimerBar = this.add.rectangle(GAME_WIDTH / 2, 158, 280, 8, 0x66ccff).setDepth(20);
    this.bossTimerTween = this.tweens.add({
      targets: this.bossTimerBar,
      scaleX: 0,
      duration: timeLimit,
      onUpdate: () => { this.bossTimerBar.x = GAME_WIDTH / 2 - (280 * (1 - this.bossTimerBar.scaleX)) / 2; },
      onComplete: () => {
        if (this.boss) this.bossPounceAndGameOver();
      },
    });

    if (this.boss.getData('hasLightningAttack')) this.startLightningCharge(timeLimit);
    if (this.boss.getData('hasWaterAttack')) this.startWaterCycle();
  }

  // fight timer ran out: instead of cutting straight to game over, the boss
  // leaps up and slams down onto the army before the game-over screen shows.
  // Cancels any in-progress attack (lightning charge / water spray) so
  // nothing fires mid-cinematic, and bossPouncing gates out normal boss
  // movement + player firing for the duration.
  bossPounceAndGameOver() {
    if (!this.boss) { this.gameOver('The boss overwhelmed you!'); return; }
    this.bossPouncing = true;

    if (this.lightningTimer) { this.lightningTimer.remove(false); this.lightningTimer = null; }
    this.clearLightningChargeVisuals();
    if (this.waterSprayTimer) { this.waterSprayTimer.remove(false); this.waterSprayTimer = null; }
    if (this.waterCycleTimer) { this.waterCycleTimer.remove(false); this.waterCycleTimer = null; }

    const startY = this.boss.y;
    const targetX = this.formationX;
    const targetY = PLAYER_Y;

    // wind-up: hop upward
    this.tweens.add({
      targets: this.boss,
      y: startY - 60,
      scale: 1.25,
      duration: 260,
      ease: 'Sine.easeOut',
      onComplete: () => {
        if (this.bossGlow) this.bossGlow.setVisible(false);
        // lunge: slam down onto the army's position
        this.tweens.add({
          targets: this.boss,
          x: targetX,
          y: targetY,
          scale: 1.4,
          duration: 320,
          ease: 'Cubic.easeIn',
          onComplete: () => this.bossImpact(targetX, targetY),
        });
      },
    });
  }

  bossImpact(x, y) {
    // impact flash
    const shock = this.add.circle(x, y, 70, 0xffffff, 0.85).setDepth(26).setScale(0.1);
    this.tweens.add({
      targets: shock,
      scale: 1.6,
      alpha: 0,
      duration: 350,
      onComplete: () => shock.destroy(),
    });
    this.cameras.main.shake(220, 0.012);

    // the army is destroyed
    this.soldierSprites.clear(true, true);
    this.army = 0;
    this.armyText.setText('Army: 0');

    // clean up the now-stale boss HUD (timer/hp bar/label/glow) -- the boss
    // sprite itself is left standing where it landed as the final tableau
    if (this.bossTimerBar) this.bossTimerBar.destroy();
    if (this.bossHpBarBg) this.bossHpBarBg.destroy();
    if (this.bossHpBarFill) this.bossHpBarFill.destroy();
    if (this.bossLabel) this.bossLabel.destroy();
    if (this.bossGlow) this.bossGlow.destroy();

    this.time.delayedCall(300, () => this.gameOver('The boss overwhelmed you!'));
  }

  // basic boss's attack: charges for the first half of the fight timer (a
  // growing electric glow is the tell), then strikes straight down in
  // whatever column it's standing in -- it doesn't move, so dodging is
  // entirely on the player.
  startLightningCharge(timeLimit) {
    const halfTime = timeLimit / 2;

    // outer aura -- steady growth, and now IN FRONT of the boss (depth 14 >
    // boss's 12) instead of subtly tucked behind it, plus a much higher max
    // alpha/scale so the buildup actually reads at a glance
    this.chargeGlow = this.add.circle(this.boss.x, this.boss.y, 55, 0xbfefff, 0.3).setDepth(14);
    this.tweens.add({
      targets: this.chargeGlow,
      scale: { from: 0.4, to: 2.3 },
      alpha: { from: 0.25, to: 0.8 },
      duration: halfTime,
      ease: 'Sine.easeIn',
    });

    // inner spark core -- fast continuous flicker for the whole charge
    // window, reads as crackling energy building up rather than a slow fade
    this.chargeCore = this.add.circle(this.boss.x, this.boss.y, 18, 0xffffff, 0.9).setDepth(15);
    this.tweens.add({
      targets: this.chargeCore,
      alpha: { from: 0.9, to: 0.25 },
      scale: { from: 0.7, to: 1.4 },
      duration: 140,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    this.lightningTimer = this.time.delayedCall(halfTime, () => this.lightningStrike());
  }

  // shared cleanup for the charge visuals -- called when the strike actually
  // fires and also from defeatBoss() in case the boss dies mid-charge
  clearLightningChargeVisuals() {
    if (this.chargeGlow) { this.chargeGlow.destroy(); this.chargeGlow = null; }
    if (this.chargeCore) { this.chargeCore.destroy(); this.chargeCore = null; }
  }

  lightningStrike() {
    if (!this.boss || this.state !== 'boss') return;
    this.clearLightningChargeVisuals();

    const strikeX = this.boss.x;
    const bolt = this.add.rectangle(strikeX, (this.boss.y + PLAYER_Y) / 2, 14, PLAYER_Y - this.boss.y, 0xbfefff, 0.9).setDepth(15);
    this.tweens.add({ targets: bolt, alpha: 0, duration: 300, onComplete: () => bolt.destroy() });

    if (Math.abs(this.formationX - strikeX) < LIGHTNING_STRIKE_HALF_WIDTH) {
      this.army = Math.floor(this.army * LIGHTNING_STRIKE_ARMY_SURVIVAL_PCT);
      this.showFloatingText(this.formationX, PLAYER_Y - 60, 'LIGHTNING STRIKE! Army devastated', '#bfefff');
      this.playSfxThrottled('player-hit', 150, { volume: 0.35 });
      if (this.army <= 0) this.gameOver('Your army was struck down!');
    } else {
      this.showFloatingText(strikeX, PLAYER_Y - 60, 'DODGED!', '#66ff99');
    }
  }

  // water boss's attack: repeats for the whole fight. Each "on" phase fires
  // WATER_DROPLETS_PER_BURST droplets in quick succession (the actual
  // spray), then waits WATER_OFF_MS before the next burst. Runs until the
  // boss dies (cleaned up in defeatBoss()) or the fight timer runs out.
  startWaterCycle() {
    if (!this.boss || this.state !== 'boss') return;
    const burstCount = Math.max(1, Math.round(WATER_ON_MS / WATER_SPRAY_INTERVAL_MS));
    this.waterSprayTimer = this.time.addEvent({
      delay: WATER_SPRAY_INTERVAL_MS,
      repeat: burstCount - 1,
      callback: () => this.spawnWaterDroplet(),
    });
    this.waterCycleTimer = this.time.delayedCall(WATER_ON_MS + WATER_OFF_MS, () => this.startWaterCycle());
  }

  spawnWaterDroplet() {
    if (!this.boss) return;
    // sizes off current firepower like the fireball does, but targets a
    // much shorter destroy time since droplets are frequent, not a rare spike
    const fp = this.getFirepower();
    const dps = Math.max(1, fp.volleysPerSecond * fp.dmgPerVolley);
    const hp = Phaser.Math.Clamp(Math.round(dps * WATER_DROPLET_DESTROY_SECONDS), WATER_DROPLET_HP_MIN, WATER_DROPLET_HP_MAX);

    const wd = this.waterDroplets.create(this.boss.x, this.boss.y + 60, 'waterDroplet');
    wd.setDepth(13);
    wd.body.allowGravity = false;
    wd.body.setCircle(16, -2, -2); // generous hitbox, same tolerance philosophy as the boss/fireball
    wd.setData('hp', hp);
    wd.setData('maxHp', hp);

    const dx = this.formationX - wd.x;
    const dy = PLAYER_Y - wd.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    wd.body.velocity.x = (dx / dist) * WATER_DROPLET_SPEED;
    wd.body.velocity.y = (dy / dist) * WATER_DROPLET_SPEED;

    wd.setData('barBg', this.add.rectangle(wd.x, wd.y - 22, 34, 6, 0x333333).setDepth(20));
    wd.setData('barFill', this.add.rectangle(wd.x - 16, wd.y - 22, 32, 4, 0x33bbff).setOrigin(0, 0.5).setDepth(21));
  }

  updateWaterDroplets(dt) {
    this.waterDroplets.getChildren().forEach((wd) => {
      const bg = wd.getData('barBg');
      const fill = wd.getData('barFill');
      if (bg) bg.setPosition(wd.x, wd.y - 22);
      if (fill) {
        fill.setPosition(wd.x - 16, wd.y - 22);
        fill.scaleX = Phaser.Math.Clamp(wd.getData('hp') / wd.getData('maxHp'), 0, 1);
      }
      if (wd.y > GAME_HEIGHT + 60 || wd.x < -40 || wd.x > GAME_WIDTH + 40) {
        this.destroyWaterDroplet(wd);
      }
    });
  }

  destroyWaterDroplet(wd) {
    const bg = wd.getData('barBg');
    const fill = wd.getData('barFill');
    if (bg) bg.destroy();
    if (fill) fill.destroy();
    wd.destroy();
  }

  // ---------------- collision handlers ----------------

  onBulletHitEnemy(bullet, enemy) {
    const dmg = bullet.getData('damage') || 1;
    const explosive = bullet.getData('explosive');
    const x = bullet.x;
    const y = bullet.y;
    bullet.destroy();
    this.damageEnemy(enemy, dmg);
    if (explosive) this.triggerExplosion(x, y, enemy, dmg);
  }

  // shared kill/damage bookkeeping so both a direct bullet hit and explosion
  // splash (see triggerExplosion) go through the same score/sound/charge path
  damageEnemy(enemy, dmg) {
    const hp = (enemy.getData('hp') || 1) - dmg;
    if (hp <= 0) {
      this.kills += 1;
      this.score += 1;
      this.updateScoreText();
      enemy.destroy();
      this.sound.play('enemy-kill', { volume: 0.25 });
      this.registerRedKill();
    } else {
      enemy.setData('hp', hp);
    }
  }

  // Black tier and beyond -- see EXPLOSIVE_TIER comment up top. Splashes
  // EXPLOSION_DMG_MULT x the bullet's own (already star-upgraded) damage
  // onto every other enemy within EXPLOSION_RADIUS_PX of the direct hit.
  triggerExplosion(x, y, hitEnemy, baseDmg) {
    this.showExplosionVisual(x, y);
    const splashDmg = Math.max(1, Math.round(baseDmg * EXPLOSION_DMG_MULT));
    // snapshot first -- damageEnemy() can destroy() an enemy mid-loop, which
    // mutates the group's live children array and would silently skip
    // whichever enemy shifts into the just-vacated index if we iterated it
    // directly (this is a one-shot pass, unlike cleanupOffscreen's per-frame
    // sweep, so a skipped enemy here has no next frame to catch it)
    const targets = [...this.enemies.getChildren()];
    targets.forEach((other) => {
      if (other === hitEnemy || !other.active) return;
      if (Phaser.Math.Distance.Between(x, y, other.x, other.y) > EXPLOSION_RADIUS_PX) return;
      this.damageEnemy(other, splashDmg);
    });
  }

  showExplosionVisual(x, y) {
    const flash = this.add.circle(x, y, EXPLOSION_RADIUS_PX, 0xffaa33, 0.55).setDepth(9).setScale(0.15);
    this.tweens.add({
      targets: flash,
      scale: 1,
      alpha: 0,
      duration: 220,
      ease: 'Cubic.easeOut',
      onComplete: () => flash.destroy(),
    });
  }

  // NOTE: param order is (boss, bullet) even though the overlap is declared as
  // (bullets, boss) -- when Arcade physics checks a group against a single
  // sprite it always passes the sprite first (World.collideObjects swaps the
  // pair before calling collideSpriteVsGroup), regardless of declaration order.
  onBulletHitBoss(boss, bullet) {
    if (this.bossPouncing) {
      // timer already ran out and the death-blow cinematic has started --
      // bullets already in flight (or still landing despite handleAutoFire
      // being gated off) must not be able to defeat the boss mid-animation,
      // which would destroy it out from under the tween and fire the
      // "BOSS DOWN" victory path at the same time as game over
      bullet.destroy();
      return;
    }
    if (!boss.getData('locked')) {
      // still descending -- fully invulnerable until it locks in and the
      // timed fight actually begins. Bullets could otherwise chip away real
      // hp during the ~1-1.5s descent, which barely mattered against the
      // old large HP pools but now eats a huge chunk of a deliberately
      // small, precisely-timed DPS-relative hp budget before the timer
      // even starts
      bullet.destroy();
      return;
    }
    const invulnUntil = boss.getData('invulnUntil');
    if (invulnUntil && this.time.now < invulnUntil) {
      // absorb the shot harmlessly -- this is the window right as he locks
      // in, meant to soak up any bullets that were already mid-flight
      bullet.destroy();
      return;
    }

    const dmg = bullet.getData('damage') || 1;
    bullet.destroy();
    const hp = boss.getData('hp') - dmg;

    boss.setData('hp', hp);
    const pct = Phaser.Math.Clamp(hp / boss.getData('maxHp'), 0, 1);
    this.bossHpBarFill.scaleX = pct;
    if (hp <= 0) {
      this.defeatBoss();
      return;
    }
    if (boss.getData('canFireball') && !boss.getData('fireballPending')) {
      const firedThresholds = boss.getData('firedThresholds');
      const nextThreshold = FIREBALL_HP_THRESHOLDS.find((t) => pct <= t && !firedThresholds.has(t));
      if (nextThreshold !== undefined) {
        firedThresholds.add(nextThreshold);
        boss.setData('fireballPending', true);
        this.telegraphFireball();
      }
    }
  }

  // brief windup tell before the boss throws a fireball -- a flicker rather
  // than a canned scale tween, so it doesn't fight the boss's permanent idle
  // breathing tween for control of `scale`. fireballPending gates re-entry
  // so a second threshold crossed mid-telegraph waits for this one to finish
  // rather than firing two at once.
  telegraphFireball() {
    if (!this.boss) return;
    this.showFloatingText(this.boss.x, this.boss.y + 90, 'INCOMING!', '#ff5522');
    this.tweens.add({
      targets: this.boss,
      alpha: { from: 1, to: 0.35 },
      duration: 140,
      yoyo: true,
      repeat: 2,
      onComplete: () => {
        if (this.boss) {
          this.boss.setAlpha(1);
          this.boss.setData('fireballPending', false);
        }
        this.spawnFireball();
      },
    });
  }

  spawnFireball() {
    if (!this.boss) return;
    const fb = this.fireballs.create(this.boss.x, this.boss.y + 60, 'fireball');
    fb.setDepth(13);
    fb.setScale(FIREBALL_SCALE);
    fb.body.allowGravity = false;
    // generous hitbox, same "no pixel-perfect required" tolerance as the boss
    // -- radius/offset are in local (unscaled) texture space; Arcade Physics
    // scales the body to match fb.setScale() automatically
    fb.body.setCircle(28, -8, -8);

    const dx = this.formationX - fb.x;
    const dy = PLAYER_Y - fb.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    fb.body.velocity.x = (dx / dist) * FIREBALL_SPEED;
    fb.body.velocity.y = (dy / dist) * FIREBALL_SPEED;
  }

  // dropped by the Moon boss on death -- drifts down the lane like a gate.
  // Purely cosmetic: the actual upgrade is applied by collectStarUpgrade,
  // triggered from updateStarPickups() once this sprite's fall reaches the
  // army's row (PLAYER_Y), regardless of the army's x position -- it can no
  // longer be missed, this is just what makes that moment read on screen.
  spawnStarVisual(x, y) {
    const star = this.stars.create(x, y, 'star');
    star.setDepth(9);
    star.body.allowGravity = false;
    this.tweens.add({
      targets: star,
      scale: { from: 1, to: 1.25 },
      duration: 400,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  defeatBoss() {
    const wasType = this.boss ? this.boss.getData('bossType') : null;
    const dropX = this.boss ? this.boss.x : this.formationX;
    const dropY = this.boss ? this.boss.y : 220;

    if (this.bossTimerTween) this.bossTimerTween.stop();
    if (this.bossTimerBar) this.bossTimerBar.destroy();
    if (this.bossHpBarBg) this.bossHpBarBg.destroy();
    if (this.bossHpBarFill) this.bossHpBarFill.destroy();
    if (this.bossLabel) this.bossLabel.destroy();
    if (this.bossGlow) this.bossGlow.destroy();
    if (this.lightningTimer) { this.lightningTimer.remove(false); this.lightningTimer = null; }
    this.clearLightningChargeVisuals();
    if (this.waterSprayTimer) { this.waterSprayTimer.remove(false); this.waterSprayTimer = null; }
    if (this.waterCycleTimer) { this.waterCycleTimer.remove(false); this.waterCycleTimer = null; }
    if (this.boss) this.boss.destroy();
    this.boss = null;

    if (wasType === 'crescent') this.spawnStarVisual(dropX, dropY); // moon-exclusive again -- every-boss drops made post-#1 fights too easy; upgrade applies on arrival, see updateStarPickups()
    this.state = 'playing';
    // wave cadence was frozen for the whole fight -- resume it fresh from
    // here rather than the stale pre-fight value, or distance would have
    // already overshot it and dump a burst of catch-up waves immediately
    this.nextSpawnAt = this.distance + this.spawnGapPx;
    this.kills += 1;
    this.score += 25;
    this.updateScoreText();
    this.showFloatingText(this.formationX, PLAYER_Y - 60, 'BOSS DOWN! +25', '#66ff99');
    this.sound.play('boss-defeat', { volume: 0.5 });
  }

  // group vs group overlap keeps declared order (bullets, fireballs) --
  // unlike the single-sprite-vs-group boss case above, there's no swap here
  // invincible -- the bullet is absorbed (doesn't visibly pass through) but
  // does nothing to the fireball; dodging is the only counterplay
  onBulletHitFireball(bullet) {
    bullet.destroy();
  }

  // playerCollider (single sprite) vs fireballs (group) -- single sprite is
  // always passed first, same rule as onBulletHitBoss above
  onFireballHitPlayer(playerCollider, fireball) {
    const dmg = Math.max(FIREBALL_ARMY_DMG_MIN, Math.round(this.army * FIREBALL_ARMY_DMG_PCT));
    this.army = Math.max(0, this.army - dmg);
    this.showFloatingText(fireball.x, PLAYER_Y - 40, `-${dmg}`, '#ff6666');
    this.playSfxThrottled('player-hit', 150, { volume: 0.35 });
    this.destroyFireball(fireball);
    if (this.army <= 0) this.gameOver('Your army was overrun by fire!');
  }

  // group vs group overlap keeps declared order (bullets, waterDroplets) -- same rule as onBulletHitFireball above
  onBulletHitWaterDroplet(bullet, waterDroplet) {
    const dmg = bullet.getData('damage') || 1;
    bullet.destroy();
    const hp = waterDroplet.getData('hp') - dmg;
    if (hp <= 0) {
      this.destroyWaterDroplet(waterDroplet);
    } else {
      waterDroplet.setData('hp', hp);
    }
  }

  // playerCollider (single sprite) vs waterDroplets (group) -- single sprite first, same rule as onFireballHitPlayer above
  onWaterDropletHitPlayer(playerCollider, waterDroplet) {
    const dmg = Math.max(WATER_ARMY_DMG_MIN, Math.round(this.army * WATER_ARMY_DMG_PCT));
    this.army = Math.max(0, this.army - dmg);
    this.showFloatingText(waterDroplet.x, PLAYER_Y - 40, `-${dmg}`, '#66ccff');
    this.playSfxThrottled('player-hit', 150, { volume: 0.35 });
    this.destroyWaterDroplet(waterDroplet);
    if (this.army <= 0) this.gameOver('Your army was washed away!');
  }

  // applied the instant the moon boss dies (see defeatBoss) -- no player
  // action required, so the upgrade can never be missed. x/y only position
  // the floating label; the falling star sprite spawned alongside this
  // (spawnStarVisual) is purely cosmetic and carries no game logic itself.
  collectStarUpgrade(x, y) {
    this.starTier += 1;
    let label;
    if (this.starTier <= STAR_TIERS.length) {
      // tiers 1-5: original hand-authored look, combined dmg+rate multiplier
      const tier = STAR_TIERS[this.starTier - 1];
      this.starDmgMult *= STAR_TIER_MULT;
      this.starRateMult *= STAR_TIER_MULT;
      this.currentArmyColor = tier.armyTint;
      this.currentBulletTexture = tier.bulletTexture;
      label = `${tier.label.toUpperCase()} UPGRADE!`;
    } else {
      // tier 6+: uncapped and procedural -- compounds on top of the tier-5
      // baseline, with a freshly generated army color + bullet design
      this.starDmgMult *= STAR_POWER_GROWTH_RATE;
      this.starRateMult *= STAR_POWER_GROWTH_RATE;
      this.starHue = (this.starHue + STAR_HUE_STEP) % 1;
      this.currentArmyColor = hsvToHex(this.starHue, 0.75, 0.95);
      this.currentBulletTexture = this.generateStarBulletTexture(this.starHue, this.starTier);
      label = `POWER UP #${this.starTier}!`;
    }
    this.soldierSprites.getChildren().forEach((s) => s.setTint(this.currentArmyColor));
    this.updateStarStatusText();
    this.showFloatingText(x, PLAYER_Y - 60, label, '#ffffff');
    this.sound.play('star', { volume: 0.4 });
  }

  // procedurally generates a new bullet look for tier-6+ pickups. Reuses a
  // single fixed texture key (overwriting it each time) rather than minting
  // a new one per pickup, so an infinite run doesn't leak an unbounded
  // number of textures into the texture manager. The pattern cycles through
  // 4 shapes (solid / white-tipped / two-band / tri-band) as starTier climbs,
  // colored off the current hue, so both the color AND the design change
  // every pickup, not just the color.
  generateStarBulletTexture(hue, starTier) {
    const key = 'starBulletProcedural';
    if (this.textures.exists(key)) this.textures.remove(key);

    const mainColor = hsvToHex(hue, 0.8, 1.0);
    const glowColor = hsvToHex(hue, 0.7, 0.9);
    const pattern = (starTier - STAR_TIERS.length - 1) % 4;

    const g = this.add.graphics();
    g.fillStyle(glowColor, 0.35);
    g.fillRoundedRect(0, 3, 10, 14, 5);

    if (pattern === 0) {
      g.fillStyle(mainColor, 1);
      g.fillRect(3, 0, 4, 20);
    } else if (pattern === 1) {
      g.fillStyle(mainColor, 1);
      g.fillRect(3, 0, 4, 20);
      g.fillStyle(0xffffff, 1);
      g.fillRoundedRect(3, 0, 4, 5, 2);
    } else if (pattern === 2) {
      const lightColor = hsvToHex(hue, 0.35, 1.0);
      g.fillStyle(mainColor, 1);
      g.fillRect(3, 0, 4, 11);
      g.fillStyle(lightColor, 1);
      g.fillRect(3, 11, 4, 9);
    } else {
      const secondColor = hsvToHex((hue + 0.33) % 1, 0.8, 1.0);
      const thirdColor = hsvToHex((hue + 0.66) % 1, 0.8, 1.0);
      g.fillStyle(mainColor, 1);
      g.fillRect(3, 0, 4, 7);
      g.fillStyle(secondColor, 1);
      g.fillRect(3, 7, 4, 7);
      g.fillStyle(thirdColor, 1);
      g.fillRect(3, 14, 4, 6);
    }

    g.generateTexture(key, 10, 20);
    g.destroy();
    return key;
  }

  onPlayerHitGate(playerCollider, gate) {
    // guards against BOTH gates in a pair resolving at once: the player's
    // 70px-wide collider is actually wider than the ~43px gap between the
    // two gates, so standing still (or anywhere near center) overlaps both
    // simultaneously. The `consumed` flag makes this robust even if Arcade
    // Physics has already queued both overlap callbacks before either
    // destroy() takes effect within the same physics step -- checking the
    // flag (rather than relying on destroy timing) is what actually
    // prevents the second callback from applying its effect.
    if (gate.getData('consumed')) return;
    gate.setData('consumed', true);

    const type = gate.getData('type');
    const value = gate.getData('value');
    if (type === 'add') this.army += value;
    else if (type === 'sub') this.army = Math.max(0, this.army - value);
    else if (type === 'mult') this.army = Math.round(this.army * value);

    const label = type === 'add' ? `+${value}` : type === 'sub' ? `-${value}` : `x${value}`;
    this.showFloatingText(gate.x, PLAYER_Y - 40, label, type === 'sub' ? '#ff6666' : '#66ff99');
    this.sound.play(type === 'sub' ? 'gate-negative' : 'gate-positive', { volume: 0.4 });

    // picking one side disables the other, whether or not it was also overlapping
    const partner = gate.getData('partner');
    if (partner && partner.active && !partner.getData('consumed')) {
      partner.setData('consumed', true);
      partner.destroy();
    }
    gate.destroy();

    if (this.army <= 0) this.gameOver('Your army was wiped out!');
  }

  onPlayerHitEnemyRow(playerCollider, enemy) {
    // any enemy that reaches the player's row costs army strength -- the
    // cost itself grows over time, so falling behind late-game is punishing
    const breachDmg = 1 + Math.floor(this.waveIndex / ENEMY_BREACH_DMG_EVERY_N_WAVES);
    this.army = Math.max(0, this.army - breachDmg);
    this.showFloatingText(enemy.x, PLAYER_Y - 30, `-${breachDmg}`, '#ff6666');
    this.playSfxThrottled('player-hit', 150, { volume: 0.3 });
    enemy.destroy();
    if (this.army <= 0) this.gameOver('Your army was overrun!');
  }

  // ---------------- feedback / game state ----------------

  showFloatingText(x, y, text, color) {
    const t = this.add.text(x, y, text, {
      fontFamily: 'Segoe UI, sans-serif', fontSize: '26px', color, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(25);
    this.tweens.add({
      targets: t,
      y: y - 50,
      alpha: 0,
      duration: 700,
      onComplete: () => t.destroy(),
    });
  }

  gameOver(reason) {
    if (this.state === 'gameover') return;
    this.state = 'gameover';
    this.sound.play('gameover', { volume: 0.5 });
    this.hideRainbowButton();
    this.physics.pause();
    this.gameOverText.setText(
      `GAME OVER\n${reason}\nSurvived to Wave: ${this.waveIndex}\nBlocks Destroyed: ${this.kills}\nScore: ${this.score}`
    );
    this.gameOverText.setVisible(true);
    this.restartText.setVisible(true);
    this.input.once('pointerdown', () => this.scene.restart());
  }
}