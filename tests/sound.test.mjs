// sound.test.mjs — every sound of every cartridge, played by the real client code
// (public/sound.js driving the chip in public/chip.js) and measured.
// This checks pitch, length and level. It cannot say whether a sound is pleasant:
// `node tools/sounds.mjs out/` writes .wav files to listen to.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from './lib.mjs';
import { makeSound, bank, measure, noteHz } from '../tools/sounds.mjs';

const { sound, render } = await makeSound();
const CARTS = ['dama', 'pong', 'flap', 'keys'];

test('every preset sounds, at its note, for about its length, without clipping', () => {
  let n = 0;
  for (const cart of CARTS) {
    const { presets } = bank(path.join(ROOT, 'dist', cart + '.wasm'));
    assert.ok(presets.length > 0, `${cart} has a sound bank`);
    for (const { id, bytes } of presets) {
      render(0.4);
      sound.sfx(bytes);
      const wanted = bytes[6] / 100, slide = bytes[5] !== 0;
      const s = render(wanted + 0.5);
      const m = measure(s, 0.003, slide ? Math.min(0.034, 0.003 + wanted / 8) : 0.034);
      const name = `${cart} sound ${id}`;
      assert.ok(m.peak > 0.03, `${name} is audible (peak ${m.peak.toFixed(3)})`);
      assert.ok(m.peak < 0.5, `${name} leaves room for the other channels (peak ${m.peak.toFixed(3)})`);
      assert.ok(m.seconds >= wanted * 0.6 && m.seconds <= wanted + 0.13, `${name} lasts ${m.seconds.toFixed(2)} s, wanted ${wanted.toFixed(2)} s`);
      if (bytes[0] !== 3 && m.hz) {                                    // pulse and wave channels have a pitch
        const off = Math.abs(m.hz / noteHz(bytes[2]) - 1);
        assert.ok(off < 0.01, `${name} plays ${m.hz.toFixed(1)} Hz, its note is ${noteHz(bytes[2]).toFixed(1)} Hz`);
        n++;
      }
    }
  }
  assert.ok(n >= 20, `${n} pitches were measured`);
});

test('a new sound on a channel replaces the old one; the other channels play on', () => {
  render(0.4);
  sound.voice(0, 2, 60, 10, 0, 50, 0);                                // a long low note on pulse 1
  render(0.05);
  sound.voice(0, 2, 72, 10, 0, 50, 0);                                // replaced by one an octave up
  const s = render(0.3);
  const hz = measure(s, 0.05, 0.1).hz;
  assert.ok(Math.abs(hz / noteHz(72) - 1) < 0.01, `only the new note is heard (${hz.toFixed(1)} Hz)`);
});

test('all four channels at full volume together stay inside the output range', () => {
  render(0.4);
  sound.voice(0, 2, 60, 15, 0, 30, 0); sound.voice(1, 2, 64, 15, 0, 30, 0);
  sound.voice(2, 0, 67, 15, 0, 30, 0); sound.voice(3, 0, 60, 15, 0, 30, 0);
  const m = measure(render(0.4));
  assert.ok(m.peak > 0.2 && m.peak <= 1, `peak ${m.peak.toFixed(3)}`);
});

test('music: a pattern loops on the client and can be switched off by the player', () => {
  const { patterns } = bank(path.join(ROOT, 'dist/dama.wasm'));
  assert.equal(patterns.length, 1);
  const song = patterns[0].song;
  assert.equal(song.steps, 16); assert.ok(Math.abs(song.step - 0.28) < 1e-9);
  sound.setMusic(false);
  sound.playMusic(song);
  assert.equal(sound.timer, null, 'MUSIC off in HOME: no timer runs');
  sound.setMusic(true);
  assert.notEqual(sound.timer, null);
  sound.playMusic({ ...song, notes: song.notes.slice() }, true);
  assert.equal(sound.step, 0);
  sound.step = 5;
  sound.playMusic({ ...song, notes: song.notes.slice() }, true);       // the same song after a resync
  assert.equal(sound.step, 5, 'it plays on instead of starting over');
  sound.playMusic({ ...song, notes: song.notes.slice() });             // a real play command
  assert.equal(sound.step, 0);
  sound.stopMusic();
  assert.equal(sound.timer, null);
});
