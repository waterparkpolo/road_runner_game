import Phaser from 'phaser';
import BootScene from './scenes/BootScene.js';
import GameScene from './scenes/GameScene.js';

const config = {
  type: Phaser.AUTO,
  parent: 'app',
  width: 480,
  height: 800,
  backgroundColor: '#1c1c26',
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: 0 },
      debug: false,
    },
  },
  scale: {
    mode: Phaser.Scale.FIT,
    // NO_CENTER: the #app flexbox in style.css already centers the canvas.
    // Phaser's own CENTER_BOTH adds an inline margin-left on top of that,
    // and the two centering methods stack, shifting the canvas noticeably
    // right of true center.
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  scene: [BootScene, GameScene],
};

const game = new Phaser.Game(config);
// exposed for debugging from the browser console (e.g. forcing a boss spawn)
window.game = game;
