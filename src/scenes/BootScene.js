import Phaser from 'phaser';

// Generates all placeholder textures at runtime using Graphics, so the
// project runs with zero external art assets. Swap these for real sprite
// sheets later — just load them in preload() and skip the matching
// generateXTexture() call.
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload() {
    // Kenney CC0 sound effects (kenney.nl/assets) -- mp3 first for broad
    // Safari/iOS support, ogg as the fallback Phaser tries next.
    const sfx = [
      'shoot', 'enemy-kill', 'gate-positive', 'gate-negative', 'star',
      'boss-incoming', 'boss-defeat', 'player-hit', 'gameover',
    ];
    sfx.forEach((key) => this.load.audio(key, [`sfx/${key}.mp3`, `sfx/${key}.ogg`]));
  }

  create() {
    this.generateSoldierTexture();
    this.generateBulletTexture();
    this.generateEnemyTexture();
    this.generateBossBasicPlainTexture();
    this.generateBossBasicTexture();
    this.generateBossFireTexture();
    this.generateBossCrescentTexture();
    this.generateBossWaterTexture();
    this.generateFireballTexture();
    this.generateWaterDropletTexture();
    this.generateStarTexture();
    this.generateBulletTierTexture('bulletTier1', 0x33ff66, [{ color: 0x33ff66, y0: 0, y1: 20 }]);
    this.generateBulletTierTexture('bulletTier2', 0x3388ff, [{ color: 0x3388ff, y0: 0, y1: 20 }]);
    this.generateBulletTierTexture('bulletTier3', 0xaa44ff, [{ color: 0xaa44ff, y0: 0, y1: 20 }], 0xffffff);
    this.generateBulletTierTexture('bulletTier4', 0xffee55, [{ color: 0xffffff, y0: 0, y1: 11 }, { color: 0xffee55, y0: 11, y1: 20 }]);
    this.generateBulletTierTexture('bulletTier5', 0xaa44ff, [{ color: 0xff4d4d, y0: 0, y1: 7 }, { color: 0xaa44ff, y0: 7, y1: 14 }, { color: 0x33ff66, y0: 14, y1: 20 }]);
    this.generateGateTexture('gatePositive', 0x2fb8ff);
    this.generateGateTexture('gateNegative', 0xff4d4d);
    this.generateRoadTexture();
    this.generateLaneDividerTexture();
    this.generateWaterTexture();

    this.scene.start('GameScene');
  }

  generateSoldierTexture() {
    const g = this.add.graphics();
    // ground shadow for a sense of depth
    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(11, 19, 7, 3);

    // arms
    g.fillStyle(0xf0c93d, 1);
    g.fillRoundedRect(3, 10, 3, 6, 1);
    g.fillRoundedRect(16, 10, 3, 6, 1);

    // torso
    g.fillStyle(0xffe66d, 1);
    g.fillRoundedRect(6, 9, 10, 10, 3);
    g.lineStyle(1, 0xb8860b, 1);
    g.strokeRoundedRect(6, 9, 10, 10, 3);

    // backpack/spine stripe
    g.fillStyle(0xd9a521, 1);
    g.fillRect(10, 10, 2, 8);

    // gun barrel poking up from the hands
    g.fillStyle(0x2b2b3a, 1);
    g.fillRoundedRect(9.5, 0, 3, 10, 1);
    g.fillStyle(0x54546a, 1);
    g.fillRect(9.5, 0, 3, 2);

    // head
    g.fillStyle(0xffe66d, 1);
    g.fillCircle(11, 7, 5);
    g.lineStyle(1, 0xb8860b, 1);
    g.strokeCircle(11, 7, 5);

    g.generateTexture('soldier', 22, 22);
    g.destroy();
  }

  generateBulletTexture() {
    const g = this.add.graphics();
    g.fillStyle(0xffb703, 0.35);
    g.fillRoundedRect(0, 3, 10, 14, 5);
    g.fillStyle(0xfff27a, 1);
    g.fillRoundedRect(3, 0, 4, 20, 2);
    g.generateTexture('bullet', 10, 20);
    g.destroy();
  }

  generateEnemyTexture() {
    const g = this.add.graphics();
    const cx = 14;
    const cy = 14;
    const spikes = 8;
    const outerR = 13;
    const innerR = 8;

    g.fillStyle(0xd6303f, 1);
    g.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const angle = (Math.PI / spikes) * i;
      const r = i % 2 === 0 ? outerR : innerR;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fillPath();
    g.lineStyle(2, 0x7a0f18, 1);
    g.strokePath();

    // glowing eye
    g.fillStyle(0xffe066, 1);
    g.fillCircle(cx, cy, 3.5);
    g.fillStyle(0x3a0a0f, 1);
    g.fillCircle(cx, cy, 1.6);

    g.generateTexture('enemy', 28, 28);
    g.destroy();
  }

  // the very first boss ever (bossCount === 1) stays completely plain and
  // harmless: a flat purple square with yellow eyes, no lightning bolts, no
  // attack -- a true intro fight before later basic-type encounters (#4,
  // #7...) show the lightning reskin and its strike attack
  generateBossBasicPlainTexture() {
    const g = this.add.graphics();
    g.fillStyle(0x9a1fe0, 1);
    g.fillRoundedRect(15, 15, 100, 100, 14);
    g.lineStyle(6, 0xffe066, 1);
    g.strokeRoundedRect(15, 15, 100, 100, 14);
    g.fillStyle(0xffe066, 1);
    g.fillCircle(45, 55, 9);
    g.fillCircle(85, 55, 9);
    g.fillStyle(0x2b0f4e, 1);
    g.fillCircle(45, 55, 4);
    g.fillCircle(85, 55, 4);
    g.generateTexture('bossBasicPlain', 130, 130);
    g.destroy();
  }

  // the lightning reskin, used for basic-type encounters after the first:
  // now with an electric-cyan outline and a pair of jagged lightning bolts
  // in place of the old plain eyes-only look -- a "lightning" reskin ahead
  // of a dedicated attack that gets added later
  generateBossBasicTexture() {
    const g = this.add.graphics();
    g.fillStyle(0x9a1fe0, 1);
    g.fillRoundedRect(15, 15, 100, 100, 14);
    g.lineStyle(6, 0xbfefff, 1);
    g.strokeRoundedRect(15, 15, 100, 100, 14);

    // a pair of jagged lightning bolts across the chest
    const bolt = [[7, 0], [2, 15], [7, 15], [-2, 34], [12, 14], [7, 14], [13, 0]];
    g.fillStyle(0xfff45c, 1);
    [30, 88].forEach((ox) => {
      g.beginPath();
      bolt.forEach(([px, py], i) => {
        const x = ox + px;
        const y = 30 + py;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.closePath();
      g.fillPath();
    });

    g.fillStyle(0xbfefff, 1);
    g.fillCircle(45, 55, 9);
    g.fillCircle(85, 55, 9);
    g.fillStyle(0x1a0a3a, 1);
    g.fillCircle(45, 55, 4);
    g.fillCircle(85, 55, 4);
    g.generateTexture('bossBasic', 130, 130);
    g.destroy();
  }

  // fiery boss type #2 in the rotation: deep-red base with an inset
  // bright-orange layer (fakes a gradient using solid fills, since
  // Graphics.fillGradientStyle doesn't bake reliably into a texture under
  // the WebGL renderer), flame spikes licking off the top edge, glowing
  // yellow eyes
  generateBossFireTexture() {
    const g = this.add.graphics();

    g.fillStyle(0xb31217, 1);
    g.fillRoundedRect(15, 15, 100, 100, 14);
    g.lineStyle(6, 0x5c0808, 1);
    g.strokeRoundedRect(15, 15, 100, 100, 14);
    g.fillStyle(0xff7518, 1);
    g.fillRoundedRect(24, 30, 82, 80, 12);

    g.fillStyle(0xffb703, 1);
    [[28, 10], [48, 14], [68, 10], [88, 14], [108, 10]].forEach(([sx, h]) => {
      g.fillTriangle(sx - 7, 16, sx + 7, 16, sx, 16 - h);
    });

    g.fillStyle(0xffe066, 1);
    g.fillCircle(45, 55, 9);
    g.fillCircle(85, 55, 9);
    g.fillStyle(0x3a0a0f, 1);
    g.fillCircle(45, 55, 4);
    g.fillCircle(85, 55, 4);
    g.generateTexture('bossFire', 130, 130);
    g.destroy();
  }

  // moon boss: a full circular moon. (Originally a crescent punched out via
  // the ERASE blend mode, but that didn't render well, so it's just a pale
  // glowing sphere now -- simpler and reliable.) No attack -- its gimmick is
  // the star it drops on death.
  generateBossCrescentTexture() {
    const g = this.add.graphics();

    g.fillStyle(0xaeb8ff, 0.25);
    g.fillCircle(65, 65, 60);

    g.fillStyle(0xe8ecf5, 1);
    g.fillCircle(65, 65, 48);

    // pale craters for texture
    g.fillStyle(0xc7cfe6, 0.7);
    g.fillCircle(42, 48, 7);
    g.fillCircle(85, 42, 4);
    g.fillCircle(80, 82, 5);

    // simple face, matching the other bosses' eye language
    g.fillStyle(0x5a6a8a, 1);
    g.fillCircle(50, 62, 6);
    g.fillCircle(80, 62, 6);

    g.generateTexture('bossCrescent', 130, 130);
    g.destroy();
  }

  // water boss: deep-blue base with an inset lighter-blue layer (same
  // solid-fill-layering trick as the fire boss, for the same WebGL-gradient
  // reliability reason), rounded wave crests licking off the top edge
  // instead of flame triangles, glowing pale eyes. Its attack is the
  // repeating water-spray duty cycle (see WATER SPRAY in GameScene.js).
  generateBossWaterTexture() {
    const g = this.add.graphics();

    g.fillStyle(0x0a3660, 1);
    g.fillRoundedRect(15, 15, 100, 100, 14);
    g.lineStyle(6, 0x061f38, 1);
    g.strokeRoundedRect(15, 15, 100, 100, 14);
    g.fillStyle(0x2f86d1, 1);
    g.fillRoundedRect(24, 30, 82, 80, 12);

    g.fillStyle(0x8fd0ff, 1);
    [30, 50, 70, 90, 110].forEach((sx) => {
      g.fillEllipse(sx, 18, 14, 10);
    });

    g.fillStyle(0x8fd0ff, 1);
    g.fillCircle(45, 55, 9);
    g.fillCircle(85, 55, 9);
    g.fillStyle(0x061f38, 1);
    g.fillCircle(45, 55, 4);
    g.fillCircle(85, 55, 4);
    g.generateTexture('bossWater', 130, 130);
    g.destroy();
  }

  // small glowing orb -- the boss's fireball projectile. Outer soft glow +
  // a bright gradient core, generous silhouette so a wide hit tolerance
  // (set in GameScene) reads as fair rather than pixel-perfect
  generateFireballTexture() {
    const g = this.add.graphics();
    g.fillStyle(0xff8a1f, 0.35);
    g.fillCircle(20, 20, 20);
    g.fillStyle(0xff3300, 1);
    g.fillCircle(20, 20, 14);
    g.fillStyle(0xffe066, 1);
    g.fillCircle(20, 20, 8);
    g.lineStyle(2, 0x8a0f0f, 0.8);
    g.strokeCircle(20, 20, 14);
    g.generateTexture('fireball', 40, 40);
    g.destroy();
  }

  // the water boss's droplet projectile -- a teardrop shape (circle body +
  // triangular cap pointing back up toward the boss) with a glossy
  // highlight, distinct from the fireball's round orb
  generateWaterDropletTexture() {
    const g = this.add.graphics();
    g.fillStyle(0x2f86d1, 0.3);
    g.fillEllipse(14, 30, 22, 26);
    g.fillStyle(0x1f6fb2, 1);
    g.fillCircle(14, 24, 11);
    g.fillTriangle(3, 20, 25, 20, 14, 2);
    g.fillStyle(0x8fd0ff, 0.9);
    g.fillCircle(10, 20, 4);
    g.lineStyle(2, 0x0a3660, 0.8);
    g.strokeCircle(14, 24, 11);
    g.generateTexture('waterDroplet', 28, 40);
    g.destroy();
  }

  // the crescent boss's drop -- a green-glowing 5-point star (same
  // spike/inner-radius polygon trick as generateEnemyTexture) that upgrades
  // bullets and army color on pickup
  generateStarTexture() {
    const g = this.add.graphics();
    const cx = 20;
    const cy = 20;
    const spikes = 5;
    const outerR = 17;
    const innerR = 7;

    g.fillStyle(0x33ff66, 0.3);
    g.fillCircle(cx, cy, 20);

    g.fillStyle(0xccffcc, 1);
    g.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const angle = (Math.PI / spikes) * i - Math.PI / 2;
      const r = i % 2 === 0 ? outerR : innerR;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fillPath();
    g.lineStyle(2, 0x1c7a3a, 1);
    g.strokePath();

    g.generateTexture('star', 40, 40);
    g.destroy();
  }

  // one bullet look per star-upgrade tier -- swapped in via setTexture() as
  // the player collects stars, rather than tinting the base bullet, since
  // later tiers need actual multi-color bands (not achievable with a single
  // tint) and tier 3 adds a literal white tip.
  generateBulletTierTexture(key, glowColor, bands, tipColor) {
    const g = this.add.graphics();
    g.fillStyle(glowColor, 0.35);
    g.fillRoundedRect(0, 3, 10, 14, 5);
    bands.forEach(({ color, y0, y1 }) => {
      g.fillStyle(color, 1);
      g.fillRect(3, y0, 4, y1 - y0);
    });
    if (tipColor) {
      g.fillStyle(tipColor, 1);
      g.fillRoundedRect(3, 0, 4, 5, 2);
    }
    g.generateTexture(key, 10, 20);
    g.destroy();
  }

  generateGateTexture(key, color) {
    const g = this.add.graphics();
    g.fillStyle(color, 0.85);
    g.fillRoundedRect(0, 0, 150, 70, 8);
    g.lineStyle(3, 0xffffff, 0.9);
    g.strokeRoundedRect(0, 0, 150, 70, 8);
    g.generateTexture(key, 150, 70);
    g.destroy();
  }

  generateRoadTexture() {
    const g = this.add.graphics();
    g.fillStyle(0x3c3c46, 1);
    g.fillRect(0, 0, 64, 64);
    g.lineStyle(1, 0x33333d, 0.6);
    g.strokeRect(0, 0, 64, 64);
    g.generateTexture('road', 64, 64);
    g.destroy();
  }

  // a single dashed divider line -- GameScene tiles two of these across the
  // road width to mark it out as 3 lanes
  generateLaneDividerTexture() {
    const g = this.add.graphics();
    g.fillStyle(0xffe066, 0.35);
    g.fillRoundedRect(1, 4, 6, 24, 2);
    g.fillRoundedRect(1, 36, 6, 24, 2);
    g.generateTexture('laneDivider', 8, 64);
    g.destroy();
  }

  // ocean backdrop -- tiled behind the full width of the scene so the road
  // reads as a bridge crossing water. Faint horizontal bands stand in for
  // wave crests; GameScene scrolls this tile at its own slow rate so the
  // water looks like it's flowing independently beneath a fixed bridge.
  generateWaterTexture() {
    const g = this.add.graphics();
    g.fillStyle(0x0f4a80, 1);
    g.fillRect(0, 0, 64, 64);
    g.fillStyle(0x2f86d1, 0.5);
    g.fillRect(0, 14, 64, 3);
    g.fillRect(0, 46, 64, 3);
    g.fillStyle(0x0a3660, 0.5);
    g.fillRect(0, 30, 64, 2);
    g.generateTexture('water', 64, 64);
    g.destroy();
  }
}