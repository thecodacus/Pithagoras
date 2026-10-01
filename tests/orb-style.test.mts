import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ORB, ORB_PALETTES, ORB_PERSONALITIES, hexToRgb, normalizeOrb } from '../server/src/orb-style.ts';

test('nothing stored is the orb as it always was',()=>{
 assert.deepEqual(normalizeOrb(undefined),DEFAULT_ORB);
 assert.deepEqual(normalizeOrb('garbage'),DEFAULT_ORB);
 // The balanced personality with the aurora colours is the orb drawn before styles existed.
 assert.deepEqual(ORB_PERSONALITIES.balanced,{lobes:[3,5],wave:1,attack:0.3,release:0.09,rings:2,bounce:0,wobble:0.12,drift:1});
 assert.deepEqual(DEFAULT_ORB.colors,{idle:'#82bcff',input:'#53f7d7',output:'#be9fff',muted:'#a1b3cc'});
 assert.deepEqual(hexToRgb(DEFAULT_ORB.colors.idle),[130,188,255]);
});

test('a chosen style is kept, and anything out of bounds is brought back in',()=>{
 const style=normalizeOrb({personality:'playful',palette:'custom',colors:{idle:'#FFAA00',input:'#00ff00',output:'#0000ff',muted:'#123456'},speed:9,reactivity:-1,glow:1.234,ribbons:false});
 assert.equal(style.personality,'playful');
 assert.equal(style.palette,'custom');
 assert.equal(style.colors.idle,'#ffaa00');
 assert.equal(style.speed,2.5);
 assert.equal(style.reactivity,0);
 assert.equal(style.glow,1.23);
 assert.equal(style.ribbons,false);
});

test('unknown names and malformed colours fall back field by field',()=>{
 const style=normalizeOrb({personality:'angry',palette:'neon',colors:{idle:'red',input:'#12345',output:'#be9fff'},speed:'fast'});
 assert.equal(style.personality,'balanced');
 assert.equal(style.palette,'aurora');
 assert.equal(style.colors.idle,DEFAULT_ORB.colors.idle);
 assert.equal(style.colors.input,DEFAULT_ORB.colors.input);
 assert.equal(style.colors.output,'#be9fff');
 assert.equal(style.speed,1);
 for(const name of Object.keys(ORB_PALETTES))assert.equal(normalizeOrb({palette:name}).palette,name);
});
