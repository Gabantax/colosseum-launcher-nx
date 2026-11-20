// The Jukebox's Purification Chamber: XD's round hall of teal-lit pedestals, with Ludicolo from the player's own disc dancing round it to
// the music. The Ludicolo are the Pokédex's models (the same reading, rigs and materials), posed in their own battle motions and bounced
// to the beat jukebox-beat.js finds in the player's sound. Nothing is drawn while the page is hidden, the tab is in the background, or
// the music has been stopped for a few seconds, and the GPU's resources are let go when the chamber is closed.
import * as THREE from '../node_modules/three/build/three.module.js';
import { createRig, placeTexture } from './model-rig.js';
import { createLighting, createMaterial, createTexture } from './hsd-material.js';

const $ = id => document.getElementById(id);
const beatOf = () => window.coloJukeboxBeat;

const NATIONAL_LUDICOLO = 272;
const DANCERS = 6;               // round the middle, as the game's chamber has pedestals: turned half a step so none is dead ahead of the camera or behind Miror B.
const RING = 3.6, HEIGHT = 1.9, STAR_HEIGHT = 2.5, DAIS = 0.75;   // DAIS: how high the middle platform stands, for Miror B.  // the ring's radius, and how tall each Ludicolo stands, in the scene's units
const FOV = 38;
const FACING = 7;                // the point on the floor, toward the camera, that the ring's dancers look at
const LAND_FRAMES = 10;        // the hop: frames to settle after landing (it turns and winds up for a beat each, and takes off on the song's drop or break)
const NOMINAL = 0.5;           // the beat (seconds) a motion is sized for: it takes as many beats as it would at 120 BPM, so a faster song plays it faster and a slower one slower
const SLIGHT = 30;             // (and what Miror B. does with them: from INTENSE up he strikes, from EASY up he makes slight movements)
const INTENSE = 0.6, EASY = 0.3;
const BLEND = 0.16;                  // seconds a dancer takes to settle from one motion into the next   // how intense a song is (0 to 1) at which he strikes, and at which he moves a little             // a motion that turns the joints less than this much in all is a slight one
const DETECT_DELAY = 0.03;     // seconds a beat is heard late by the analyser's window, which the dancers make up
const SETTLE_MS = 3000;          // how long after the music stops the dancers go on before holding still
const TEAL = 0x2ee6c8, DEEP = 0x07262c;
const AMBIENT = [0.75, 0.8, 0.82];
const LIGHTS = [{ direction: [-0.5, 1.2, 1.4], color: [0.8, 0.78, 0.72] }, { direction: [0.7, -0.4, -1], color: [0.12, 0.3, 0.3] }];
// The battle motions a dancer takes up besides its idle and its jump (the 'special', which the ring's dancers hop platforms with), in the
// order they're tried (hsd-model.js readHeader names each kind).
const MOVES = ['physical', 'extra'];
const MAX_NOTES = 18, MAX_FIREFLIES = 70;

const hasFrames = clip => clip && clip.frames > 0 && clip.values;

// A glyph on a transparent canvas, for a note's sprite.
function glyphTexture(glyph, color) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  g.font = 'bold 52px serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 8;
  g.fillStyle = color;
  g.fillText(glyph, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function glow(radius, color, opacity) {
  const mesh = new THREE.Mesh(new THREE.RingGeometry(radius * 0.94, radius, 96), new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

// The chamber's room, with no dancers in it yet.
function buildRoom(scene) {
  const room = { pulse: [], edges: [], notes: [], dispose: [] };
  const own = thing => { room.dispose.push(thing); return thing; };

  scene.fog = new THREE.FogExp2(DEEP, 0.045);
  // the floor: a dark disc with rings of teal light
  const floor = new THREE.Mesh(own(new THREE.CircleGeometry(9, 96)), own(new THREE.MeshBasicMaterial({ color: 0x0a2a30 })));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;
  scene.add(floor);
  for (const [radius, opacity] of [[8.6, 0.25], [6.4, 0.2], [RING + 0.9, 0.5], [1.6, 0.7]]) {
    const ring = glow(radius, TEAL, opacity);
    own(ring.geometry); own(ring.material);
    room.pulse.push({ material: ring.material, base: opacity });
    scene.add(ring);
  }
  // a pedestal under each dancer, and the round dais in the middle
  const dais = new THREE.Mesh(own(new THREE.CylinderGeometry(1.5, 1.7, DAIS, 48)), own(new THREE.MeshBasicMaterial({ color: 0x0f3d44 })));
  dais.position.y = DAIS / 2 - 0.02;
  scene.add(dais);
  const rim = glow(1.5, TEAL, 0.9);
  rim.position.y = DAIS - 0.01;
  own(rim.geometry); own(rim.material);
  room.pulse.push({ material: rim.material, base: 0.9 });
  scene.add(rim);
  room.pedestals = beatOf().ring(DANCERS, RING, Math.PI / DANCERS).map(({ x, z }) => {
    const base = new THREE.Mesh(own(new THREE.CylinderGeometry(1.15, 1.25, 0.22, 40)), own(new THREE.MeshBasicMaterial({ color: 0x0d3840 })));
    base.position.set(x, 0.09, z);
    scene.add(base);
    const edge = glow(1.2, TEAL, 0.85);
    edge.position.set(x, 0.21, z);
    own(edge.geometry); own(edge.material);
    room.edges.push({ material: edge.material, base: 0.85, level: 1 });
    scene.add(edge);
    return base;
  });

  // fireflies: small teal motes that drift round the hall
  const count = MAX_FIREFLIES, positions = new Float32Array(count * 3), seeds = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 8;
    positions.set([Math.sin(a) * r, 0.3 + Math.random() * 4, Math.cos(a) * r - 1], i * 3);
    seeds.set([Math.random() * 6.28, 0.2 + Math.random() * 0.5, 0.3 + Math.random()], i * 3);
  }
  const motes = new THREE.BufferGeometry();
  motes.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const moteMaterial = own(new THREE.PointsMaterial({ color: TEAL, size: 0.09, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  const points = new THREE.Points(own(motes), moteMaterial);
  scene.add(points);
  room.drift = seconds => {
    const at = motes.attributes.position;
    for (let i = 0; i < count; i++) {
      const [phase, speed, wobble] = [seeds[i * 3], seeds[i * 3 + 1], seeds[i * 3 + 2]];
      at.array[i * 3 + 1] += speed * 0.004 * wobble;
      if (at.array[i * 3 + 1] > 4.5) at.array[i * 3 + 1] = 0.2;
      at.array[i * 3] += Math.sin(seconds * speed + phase) * 0.0025;
    }
    at.needsUpdate = true;
  };

  // music notes that rise from the dancers on a beat
  const textures = [glyphTexture('♪', '#ffd84a'), glyphTexture('♫', '#ffe98a')];
  textures.forEach(own);
  for (let i = 0; i < MAX_NOTES; i++) {
    const material = own(new THREE.SpriteMaterial({ map: textures[i % 2], transparent: true, opacity: 0, depthWrite: false }));
    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(0.55);
    sprite.visible = false;
    scene.add(sprite);
    room.notes.push({ sprite, life: 0, vx: 0, vy: 0, spin: 0 });
  }
  let next = 0;
  room.emit = (x, y, z) => {
    const note = room.notes[next++ % room.notes.length];
    note.sprite.position.set(x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6);
    note.life = 1;
    note.vx = (Math.random() - 0.5) * 0.6;
    note.vy = 1.1 + Math.random() * 0.7;
    note.sprite.visible = true;
  };
  room.rise = step => {
    for (const note of room.notes) {
      if (note.life <= 0) continue;
      note.life = Math.max(0, note.life - step * 0.55);
      note.sprite.position.x += note.vx * step;
      note.sprite.position.y += note.vy * step;
      note.sprite.material.opacity = Math.min(1, note.life * 2);
      if (!note.life) note.sprite.visible = false;
    }
  };
  return room;
}

// The music made visible, after the old players' visualizers (Winamp's, Media Player's, iTunes'): ribbons of the sound's waveform that circle the
// hall and trail away upward as they age, and a starburst of its spectrum on the floor that flashes on a beat. Both are thin glowing lines,
// drawn with light that adds up where they cross.
const WAVE_POINTS = 160, TRAILS = 9, BURST_RAYS = 72;
function buildVisualizer(scene) {
  const own = [];
  const lineMaterial = (color, opacity) => { const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }); own.push(m); return m; };
  // ribbons: each trail is a closed line; the newest is the sound as it is now, and the others are what it was a moment ago, higher and wider
  const trails = Array.from({ length: TRAILS }, (_, i) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WAVE_POINTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    own.push(geometry);
    const line = new THREE.LineLoop(geometry, lineMaterial(new THREE.Color().setHSL(0.47 - i * 0.035, 0.9, 0.62), 0));
    line.frustumCulled = false;
    scene.add(line);
    return { line, base: 0.9 - i * 0.09 };
  });
  // a second ribbon, tilted the other way and in gold
  const gold = trails.map(({ line }) => { const copy = new THREE.LineLoop(line.geometry, lineMaterial(0xffd45a, 0)); copy.frustumCulled = false; copy.rotation.x = 0.35; scene.add(copy); return copy; });
  // the starburst
  const rays = new THREE.BufferGeometry(), at = new Float32Array(BURST_RAYS * 6), colors = new Float32Array(BURST_RAYS * 6);
  rays.setAttribute('position', new THREE.BufferAttribute(at, 3).setUsage(THREE.DynamicDrawUsage));
  rays.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  own.push(rays);
  const burstMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  own.push(burstMaterial);
  const burst = new THREE.LineSegments(rays, burstMaterial);
  burst.frustumCulled = false;
  scene.add(burst);

  let tick = 0, level = 0;
  const frames = Array.from({ length: TRAILS }, () => new Float32Array(WAVE_POINTS * 3));
  return {
    // `wave` is the analyser's samples (128 is silence), `bins` its spectrum (0..255), `pulse` the beat's 0..1, `playing` whether there is sound.
    update(wave, bins, pulse, seconds, playing, energy = 0.5) {
      level += ((playing ? 1 : 0) - level) * 0.08;
      // the more intense the song, the wilder the ribbons and the longer and hotter the rays
      const wild = 0.45 + 1.25 * energy;
      const spin = seconds * 0.25;
      // the newest ribbon, from the waveform: round the hall's edge, swinging out and up with the samples
      if (++tick % 3 === 0) {
        frames.unshift(frames.pop());
        const now = frames[0];
        for (let i = 0; i < WAVE_POINTS; i++) {
          const angle = i / WAVE_POINTS * Math.PI * 2 + spin, sample = ((wave[Math.floor(i / WAVE_POINTS * wave.length)] ?? 128) - 128) / 128;
          const radius = RING + 2.6 + sample * (1.1 + pulse * 0.8) * level * wild;
          now[i * 3] = Math.sin(angle) * radius;
          now[i * 3 + 1] = 0.5 + Math.abs(sample) * 1.4 * level * wild;
          now[i * 3 + 2] = Math.cos(angle) * radius;
        }
      }
      trails.forEach(({ line, base }, i) => {
        const source = frames[i], target = line.geometry.attributes.position.array;
        // older ribbons have drifted up, spread out and turned a little
        const lift = i * 0.32, spread = 1 + i * 0.045, turn = i * 0.06, cos = Math.cos(turn), sin = Math.sin(turn);
        for (let k = 0; k < WAVE_POINTS; k++) {
          const x = source[k * 3] * spread, z = source[k * 3 + 2] * spread;
          target[k * 3] = x * cos - z * sin;
          target[k * 3 + 1] = source[k * 3 + 1] + lift;
          target[k * 3 + 2] = x * sin + z * cos;
        }
        line.geometry.attributes.position.needsUpdate = true;
        const fade = Math.min(1, Math.pow(1 - i / TRAILS, 1.6) * level * (0.85 + 0.15 * pulse) * (0.55 + 0.9 * energy));
        line.material.opacity = fade;
        gold[i].material.opacity = fade * 0.7;
        gold[i].rotation.y = -spin * 0.6;
      });
      // the starburst: a ray for each slice of the spectrum, out from the middle, longer for louder; hot (gold) as it gets long
      const hue = new THREE.Color();
      for (let r = 0; r < BURST_RAYS; r++) {
        const angle = r / BURST_RAYS * Math.PI * 2 - spin * 0.5, from = bins.length * 0.02, band = Math.floor(from + (r % (BURST_RAYS / 2)) / (BURST_RAYS / 2) * bins.length * 0.5);
        const strength = Math.min(1, Math.sqrt((bins[band] ?? 0) / 255) * 1.35) * level, length = 0.15 + strength * (3.2 + pulse * 1.6) * (0.5 + 1.1 * energy);
        const inner = 1.75, outer = inner + length, o = r * 6;
        at[o] = Math.sin(angle) * inner; at[o + 1] = 0.04; at[o + 2] = Math.cos(angle) * inner;
        at[o + 3] = Math.sin(angle) * outer; at[o + 4] = 0.04; at[o + 5] = Math.cos(angle) * outer;
        hue.setHSL(Math.max(0, 0.47 - Math.min(1, strength * 1.2) * 0.38 - energy * 0.25), 0.95, 0.4 + strength * 0.3);
        colors[o] = hue.r * 0.5; colors[o + 1] = hue.g * 0.5; colors[o + 2] = hue.b * 0.5;
        colors[o + 3] = hue.r; colors[o + 4] = hue.g; colors[o + 5] = hue.b;
      }
      rays.attributes.position.needsUpdate = true;
      rays.attributes.color.needsUpdate = true;
      burstMaterial.opacity = (0.75 + 0.25 * pulse) * (0.15 + 0.85 * level);
    },
    dispose() { for (const thing of own) thing.dispose?.(); },
  };
}

// A Ludicolo: one of the Pokédex's models in its own group, posed by a rig of its own (a rig writes the pose into its meshes) over the textures
// the dancers share.
function buildDancer(data, textures, lighting, group) {
  const materials = data.materials.map(() => []), variants = new Map();
  const materialFor = shape => {
    const key = `${shape.material}:${shape.color ? 1 : 0}:${shape.binormal ? 1 : 0}:${shape.doubleSided ? 1 : 0}`;
    if (!variants.has(key)) {
      const source = data.materials[shape.material], material = createMaterial(source, textures, lighting, { shape, shiny: null });
      source.layers.forEach((layer, i) => { if (material.uniforms[`xform${i}`]) placeTexture(material.uniforms[`xform${i}`].value, layer, layer.translate[0], layer.translate[1], layer.scale[0], layer.scale[1]); });
      materials[shape.material].push(material);
      variants.set(key, material);
    }
    return variants.get(key);
  };
  const makeMesh = shape => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(shape.position.length), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(shape.normal.length), 3).setUsage(THREE.DynamicDrawUsage));
    for (const [source, uv] of Object.entries(shape.uv)) geometry.setAttribute(`hsdUv${source}`, new THREE.BufferAttribute(uv, 2));
    if (shape.color) geometry.setAttribute('hsdColor', new THREE.BufferAttribute(shape.color, 4));
    if (shape.binormal) {
      geometry.setAttribute('hsdBinormal', new THREE.BufferAttribute(new Float32Array(shape.binormal.length), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('hsdTangent', new THREE.BufferAttribute(new Float32Array(shape.tangent.length), 3).setUsage(THREE.DynamicDrawUsage));
    }
    geometry.setIndex(new THREE.BufferAttribute(shape.index, 1));
    const mesh = new THREE.Mesh(geometry, materialFor(shape));
    mesh.frustumCulled = false;
    group.add(mesh);
    return { shape, mesh, geometry };
  };
  const rig = createRig(data, makeMesh);
  return { rig, materials, sources: data.materials, jointCount: data.joints.length };
}

export function createChamber(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(DEEP, 1);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  const lighting = createLighting(), lightDirections = LIGHTS.map(({ direction }) => new THREE.Vector3(...direction).normalize());
  lighting.ambientLight.value.setRGB(...AMBIENT);
  LIGHTS.forEach(({ color }, i) => lighting.lightColor.value[i].setRGB(...color));
  const room = buildRoom(scene), visualizer = buildVisualizer(scene);

  let dancers = [], disposed = false, listening = null;
  const meter = document.getElementById('jukebox-chamber-meter');
  // How the hall is framed in the canvas, as a share of its width and height to move it by: toward the top right, behind the page's header with the title and
  // the tabs left clear, while the songs are in front; centred while you watch. It eases from one to the other.
  const FRAMES = { backdrop: { x: -0.13, y: 0.19 }, watch: { x: 0, y: 0.02 } };
  let framing = { ...FRAMES.backdrop }, framingGoal = FRAMES.backdrop, canvasSize = null;
  function applyFraming() {
    if (!canvasSize) return;
    const { width, height } = canvasSize;
    camera.setViewOffset(width, height, Math.round(width * framing.x), Math.round(height * framing.y), width, height);
    camera.updateProjectionMatrix();
  }
  let lastSongId = null, levelS = 0.3, energyS = 0.15, frameStep = 0.016, barSeen = -1, hopState = { state: 'dance', u: 0, shift: 0, at: null, frame: 0, air: 1, jumpStart: 0 }, playing = false, latency = 0, running = false, background = document.hidden, lastSound = 0, lastFrame = 0, beats = 0, tempo = 0, pulse = 0, shake = 0;
  const tracker = beatOf().createBeatTracker(), clock = beatOf().createBeatClock();
  const bins = new Uint8Array(512), wave = new Uint8Array(1024).fill(128), toView = new THREE.Matrix4(), centered = new THREE.Matrix4(), inverse = new THREE.Matrix4();

  function resize() {
    const { clientWidth: width, clientHeight: height } = canvas.parentElement;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // a narrow chamber stands the camera further back, so the whole ring stays in view
    const distance = 12.2 * Math.max(1, 1.7 / camera.aspect);
    camera.position.set(0, 5.2 + distance * 0.2, distance);
    camera.lookAt(0, 0.9, 0);
    // the chamber is the backdrop of the whole page, with the songs over its lower part
    canvasSize = { width, height };
    applyFraming();
    draw(performance.now(), true);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);

  // Gives the chamber a set of dancers of one `role`: 'ring', the Ludicolo round the edge, or 'star', Miror B. in the middle. `data` is the
  // model as the Pokédex reads it, `idle` its idle motion and `moves` the other motions to dance in (any may be missing: the model then holds
  // its pose and still bounces). The dancers of the role that were there are let go.
  function fill(role, data, idle, moves, spots, height, floor, hop = null) {
    clearDancers(role);
    const kept = { textures: data.textures.map(createTexture), clips: { idle: hasFrames(idle) ? idle : null, moves: moves.filter(hasFrames), hop: hasFrames(hop) ? hop : null } };
    spots.forEach(({ x, z, yaw: inward }, i) => {
      // a ring dancer faces out toward the audience, between the middle and the camera, so that the faces are seen
      const yaw = role === 'star' ? inward : Math.atan2(-x, FACING - z);
      const group = new THREE.Group(), body = new THREE.Group();
      group.add(body);
      scene.add(group);
      const built = buildDancer(data, kept.textures, lighting, body);
      const dancer = { ...built, role, kept, clips: kept.clips, group, body, x, z, yaw, index: i, phase: 0, side: i % 2 ? -1 : 1, height, floor,
        clip: null, lastClip: null, values: undefined, frame: 0, bar: -1, move: -1, moveStart: 0, moveBeats: 4, endBar: 0, restUntil: 0, turns: 0, level: 0.5,
        // for settling from one motion into the next: the pose last shown, and the one being blended from
        mix: new Float32Array(built.jointCount * 9), last: new Float32Array(built.jointCount * 9), blend: null, posed: false, step: null, recent: [] };
      dancers.push(dancer);
      // from its idle's first pose: the middle of its body over the floor, which its moves are held to (see stay)
      dancer.clip = kept.clips.idle;
      pose(dancer, 0);
      dancer.posed = true;
      dancer.anchor = middleOf(dancer);
      if (kept.clips.hop) dancer.air = beatOf().airborne(bounceHeights(kept.clips.hop, dancer.jointCount));
      if (role === 'star' && !kept.clips.sorted) sortSteps(kept, dancer.jointCount);
      // the frames of its idle where it lands from a small hop, which the beat is kept on
      dancer.landing = kept.clips.idle ? beatOf().landings(bounceHeights(kept.clips.idle, dancer.jointCount)) : [];
      // framed by its first pose: how big the model is, and where its middle is
      const first = dancers.find(each => each.role === role);
      if (first === dancer) frame(dancer, height);
      else { dancer.scale = first.scale; dancer.offset = first.offset; }
      body.scale.setScalar(dancer.scale);
      body.children.forEach(mesh => mesh.position.copy(dancer.offset).negate());
      // body's own origin is the model's middle, so its feet are half its height below the group
      group.position.set(x, height / 2 + floor, z);
      group.rotation.y = yaw;
    });
    lastFrame = 0;
    start();
  }
  const spots = beatOf().ring(DANCERS, RING, Math.PI / DANCERS);
  const setDancers = (data, idle, moves, hop) => { hopState = { state: 'dance', u: 0, shift: 0, at: null, frame: 0, air: 1, jumpStart: 0 }; fill('ring', data, idle, moves, spots, HEIGHT, 0.2, hop); };
  const setStar = (data, idle, moves) => fill('star', data, idle, moves, [{ x: 0, z: 0, yaw: 0 }], STAR_HEIGHT, DAIS);


  // Where the middle of a dancer's skeleton is on the floor, in the model's own units: the mean of its joints.
  function middleOf(dancer) {
    let x = 0, z = 0;
    for (const joint of dancer.rig.world) { x += joint.elements[12]; z += joint.elements[14]; }
    return [x / dancer.rig.world.length, z / dancer.rig.world.length];
  }

  // The game's motions carry the whole body with them (a lunge ends a body's length from where it began, a jump may land elsewhere).
  // A dancer stays on its platform: after it is posed, the body is moved back so the middle of its skeleton is where it began. Up and down
  // are left alone, so a jump still leaves the floor and comes down in the same place.
  function stay(dancer) {
    const [x, z] = middleOf(dancer);
    for (const { mesh } of dancer.rig.meshes) mesh.position.set(-dancer.offset.x - (x - dancer.anchor[0]), -dancer.offset.y, -dancer.offset.z - (z - dancer.anchor[1]));
  }


  // How much of a body a motion moves: the turning of all its joints added up (a held pose is a few degrees, a fling is dozens of turns).
  function swing(clip, jointCount) {
    let total = 0;
    for (let j = 0; j < jointCount; j++) {
      for (let a = 0; a < 3; a++) {
        let low = Infinity, high = -Infinity;
        for (let f = 0; f < clip.frames; f++) { const v = clip.values[f * jointCount * 9 + j * 9 + 3 + a]; if (v < low) low = v; if (v > high) high = v; }
        total += high - low;
      }
    }
    return total;
  }

  // Miror B.'s motions, sorted by what he does with them: the flip (a real leap, the one that goes up with the Ludicolo's hop), his strikes
  // (big, quick moves, for the intense parts of a song), and his slight movements (a flick of an arm, the odd step, for the calmer parts).
  function sortSteps(kept, jointCount) {
    const all = kept.clips.moves.map(clip => {
      const heights = bounceHeights(clip, jointCount), air = beatOf().airborne(heights), up = Math.max(...heights) - Math.min(...heights);
      return { clip, size: swing(clip, jointCount), air, up };
    });
    const leaps = all.filter(each => each.air && each.air.land - each.air.take >= 12 && each.up > 15).sort((a, b) => b.up - a.up);
    const flip = leaps[0] ?? null, rest = all.filter(each => each !== flip);
    kept.clips.flip = flip?.clip ?? null;
    kept.clips.flipAir = flip?.air ?? null;
    kept.clips.strikes = rest.filter(each => each.size >= SLIGHT).sort((a, b) => b.size - a.size).map(each => each.clip);
    kept.clips.slights = rest.filter(each => each.size < SLIGHT).map(each => each.clip);
    kept.clips.sorted = true;
  }

  // How high the body is at each frame of a motion: that of the joint that moves up and down the most (the game's motions have no one root).
  function bounceHeights(clip, jointCount) {
    let best = [], range = 0;
    for (let j = 0; j < jointCount; j++) {
      const heights = Array.from({ length: clip.frames }, (_, f) => clip.values[f * jointCount * 9 + j * 9 + 7]);
      const spread = Math.max(...heights) - Math.min(...heights);
      if (spread > range) { range = spread; best = heights; }
    }
    return best;
  }

  // The size and middle of what's visible of a dancer's first pose
  function frame(dancer, height) {
    const box = new THREE.Box3();
    for (const { shape, mesh, geometry } of dancer.rig.meshes) {
      const source = dancer.sources[shape.material];
      const seen = mesh.material.uniforms.alpha.value > 0.01 || source.layers.some(layer => layer.alphaOp === 4 || layer.alphaOp === 6 || (layer.alphaOp === 2 && layer.blending > 0.01));
      if (!seen) continue;
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox);
    }
    if (box.isEmpty()) for (const { geometry } of dancer.rig.meshes) { geometry.computeBoundingBox(); box.union(geometry.boundingBox); }
    const size = box.getSize(new THREE.Vector3());
    dancer.offset = box.getCenter(new THREE.Vector3());
    dancer.scale = size.y > 0 ? height / size.y : 1;
  }

  function pose(dancer, index) {
    const { clip } = dancer;
    if (clip) {
      const at = index * dancer.jointCount * 9;
      dancer.values = clip.values.subarray(at, at + dancer.jointCount * 9);
      for (const { material, layer, values } of clip.materials || []) {
        const source = dancer.sources[material].layers[layer];
        for (const each of dancer.materials[material]) {
          const xform = each.uniforms[`xform${layer}`]?.value;
          if (xform) placeTexture(xform, source, values[index * 4], values[index * 4 + 1], values[index * 4 + 2], values[index * 4 + 3]);
        }
      }
    }
    let values = dancer.values;
    // a new motion starts from where the last one left the body, and settles into its own over a moment, so that nothing snaps
    if (dancer.blend && values) {
      const w = beatOf().ease(dancer.blend.t / BLEND), from = dancer.blend.from, mix = dancer.mix;
      for (let k = 0; k < mix.length; k++) {
        let d = values[k] - from[k];
        if (k % 9 >= 3 && k % 9 < 6) d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;   // a turn goes the short way round
        mix[k] = from[k] + d * w;
      }
      values = mix;
      dancer.blend.t += frameStep;
      if (dancer.blend.t >= BLEND) dancer.blend = null;
    }
    if (values) { dancer.last.set(values); dancer.posed = true; }
    dancer.rig.pose(values, dancer.rig.billboards ? toView : null);
  }

  function clearDancers(role) {
    const gone = dancers.filter(dancer => dancer.role === role || !role), sets = new Set(gone.map(dancer => dancer.kept));
    for (const dancer of gone) {
      scene.remove(dancer.group);
      for (const { geometry } of dancer.rig.meshes) geometry.dispose();
      for (const list of dancer.materials) for (const material of list) material.dispose();
    }
    for (const { textures } of sets) for (const texture of textures) {
      texture.dispose();
      if (texture.image instanceof ImageBitmap) texture.image.close();
    }
    dancers = dancers.filter(dancer => !gone.includes(dancer));
  }

  // The sound's low end, from the player's analyser, to the beat
  function listen(now) {
    const source = listening?.();
    if (!source?.analyser || !source.playing()) { pulse = Math.max(0, pulse - 0.05); playing = false; bins.fill(0); wave.fill(128); return false; }
    const { analyser } = source;
    if (bins.length !== analyser.frequencyBinCount || wave.length !== analyser.fftSize) return false;
    analyser.getByteFrequencyData(bins);
    analyser.getByteTimeDomainData(wave);
    const songId = source.id?.() ?? null;
    if (!playing || songId !== lastSongId) {
      lastSongId = songId;
      // a song has begun (or one has crossed into the next): its tempo is its own, and the hop waits for its bars
      tracker.reset(); clock.reset(); tempo = 0; beats = 0; lastRaw = 0; wraps = 0; groupChoice.clear(); groupLast.clear();
    }
    playing = true;
    latency = analyser.context.outputLatency || analyser.context.baseLatency || 0;
    const result = tracker.push(beatOf().bassEnergy(bins, analyser.context.sampleRate), now / 1000);
    pulse = result.pulse;
    if (result.tempo) { tempo = result.tempo; clock.setTempo(result.tempo, now / 1000); }
    if (result.beat) {
      clock.onset(now / 1000);
      beats++;
      shake = 1;
      const [first] = dancers;
      if (first && room.emit) {
        const who = dancers[beats % dancers.length];
        room.emit(who.x, 2.6, who.z);
      }
    }
    lastSound = now;
    return true;
  }



  // The moments of the song that change it (a drop, a break: jukebox-tempo.js found them ahead of time) at which the ring flips. The jump is timed so
  // that the takeoff is on the moment, with a beat to turn and a beat to crouch before it; with the song's beat grid the moment is put on its nearest
  // beat. Returns where, in beats, the hop is to begin, or null when none is due.
  let eventsOf = null, fired = new Set(), lastHeard = 0;
  function dueEvent(info) {
    const source = listening?.(), profile = source?.intensity?.();
    if (!profile?.events?.length) return null;
    if (profile !== eventsOf) { eventsOf = profile; fired = new Set(); }
    if (info.heard < lastHeard - 1) fired = new Set();   // the song went round again, or was taken back
    lastHeard = info.heard;
    for (let i = 0; i < profile.events.length; i++) {
      if (fired.has(i)) continue;
      const kb = info.grid ? Math.round((profile.events[i].time - info.grid.offset) / info.period) : null;
      const at = info.grid ? info.grid.offset + kb * info.period : profile.events[i].time, lead = 2 * info.period;
      if (info.heard < at - lead) continue;
      fired.add(i);
      // only if it is not too late to take off on the moment
      if (info.heard < at - lead + 0.6) return { start: info.grid ? kb - 2 + info.wraps : Math.floor(info.b), kind: profile.events[i].kind };
    }
    return null;
  }

  // The ring's hop, kept to the beat: every few bars the dancers turn to the platform beside them (a beat), crouch (a beat), jump to it together
  // (the jump lasts whole beats, so that they land on one), turn back to face the audience (a beat), and go on dancing there. `state` is
  // dance, turn, jump or back; `shift` is how many platforms round they have gone; `at` the beat to begin on; `u` how far (in beats) through a
  // turn it is, and `frame` the jump's frame.
  function stepHop(b, dancing, first, info) {
    if (!first) return;
    const h = hopState, p = clock.period, { take, land } = first.air, clip = first.clips.hop;
    if (h.state === 'dance') {
      // at a drop, break or change in the song they all take off together
      const due = dancing ? dueEvent(info) : null;
      if (due) { h.state = 'turn'; h.start = due.start; }
      return;
    }
    if (h.state === 'turn') {
      h.u = Math.min(1, b - h.start);
      if (b - h.start >= 1) { h.state = 'jump'; h.start += 1; }
      return;
    }
    if (h.state === 'jump') {
      const air = Math.max(1, Math.round((land - take) / clip.fps / p)), u = b - h.start;
      h.air = air; h.jumpStart = h.start;
      // the crouch (up to the takeoff) is a beat, the air whole beats, and the landing is at its own pace after
      h.frame = u < 1 ? take * Math.max(0, u) : u < 1 + air ? take + (land - take) * (u - 1) / air : land + (u - 1 - air) * p * clip.fps;
      if (h.frame > land + LAND_FRAMES) {
        h.state = 'back'; h.start = b; h.u = 0;
        h.shift = (h.shift + 1) % DANCERS;
        for (const dancer of dancers) if (dancer.role === 'ring') dancer.bar = -1;
      }
      return;
    }
    h.u = Math.min(1, b - h.start);
    if (b - h.start >= 1) h.state = 'dance';
  }



  // How intense the song is where it is, 0 to 1: `level` from the song's own profile (jukebox-tempo.js), a moment ahead so a move begins as the part
  // arrives, for deciding what to do; and `energy`, which follows every beat, for what to show. With no profile, from how much louder the sound is
  // now than it has been for a while.
  let fast = 0, slow = 0;
  function intensityNow() {
    const source = listening?.(), profile = source?.intensity?.();
    if (profile) {
      const at = source.position(), T = window.coloJukeboxTempo;
      return { level: T.intensityAt(profile, at + 0.4), energy: T.intensityAt(profile, at + 0.1, true) };
    }
    let sum = 0;
    for (let i = 0; i < bins.length; i++) sum += bins[i];
    const loud = sum / bins.length / 255;
    fast += (loud - fast) * 0.05; slow += (loud - slow) * 0.004;
    const level = Math.max(0, Math.min(1, 0.5 + (fast - slow) / (slow + 0.03) * 1.5));
    return { level, energy: Math.max(0, Math.min(1, level * 0.6 + pulse * 0.4)) };
  }

  // Where the music is in beats. With the song's own beat grid (jukebox-tempo.js worked it out from the sound before it played) it is the
  // playing position, less what the speakers take to sound it, so that a beat is on a whole number as it is heard. Else it is the live clock,
  // which only follows the beats as they are heard. `b` never goes back by more than a beat, though the song's position does when it loops.
  let lastRaw = 0, wraps = 0;
  function beatNow(seconds) {
    const source = listening?.(), grid = source?.grid?.();
    if (grid) {
      const period = beatOf().normalizePeriod(grid.period), raw = (source.position() - source.latency() - grid.offset) / period;
      if (raw < lastRaw - 2) wraps += Math.ceil(lastRaw - raw - 1);   // the song went round again: keep counting
      lastRaw = raw;
      // the strongest of each four beats is the first of the bar, when the beats are the song's own
      const shift = period === grid.period ? grid.bar : 0;
      return { b: raw + wraps, period, inBar: (((Math.floor(raw) - shift) % 4) + 4) % 4, grid, wraps, heard: source.position() - source.latency() };
    }
    lastRaw = 0; wraps = 0;
    const b = clock.at(seconds - latency + DETECT_DELAY), heard = source?.position ? source.position() - source.latency() : 0;
    return { b, period: clock.period, inBar: ((Math.floor(b) % 4) + 4) % 4, grid: null, wraps: 0, heard };
  }


  // The frame of a dancer's idle to show at beat `b`: every landing of its small hop on a beat (one with a single landing, or none, runs round
  // in two beats, landing on the first)
  function idleFrame(dancer, b, period) {
    const clip = dancer.clips.idle;
    if (!clip) return 0;
    const marks = dancer.landing.length ? dancer.landing : [0], perHop = dancer.landing.length > 1 ? 1 : 2;
    return Math.floor(beatOf().warp(marks, clip.frames, b, perHop)) % clip.frames;
  }

  // --- Miror B.'s dance. He has few motions of his own, so he dances them in many ways: through, backwards, in double time, a half at a time,
  // with a spin or a slide across the dais, and, for the calm parts, his idle with the body swaying, twisting, stepping, dipping or turning.
  const STRIKE_HIGH = ['normal', 'double', 'spin', 'slide', 'reverse', 'first', 'second'];
  const STRIKE_MID = ['normal', 'first', 'second', 'reverse', 'slide', 'double'];
  const BODY = ['sway', 'twist', 'step', 'dip', 'turn'];
  const hashOf = (a, b) => {
    let h = (Math.imul(a + 1, 2654435761) ^ Math.imul(b + 7, 40503)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    return (h ^ (h >>> 15)) >>> 0;
  };

  // What Miror B. does next, from how intense the song is: a strike in its intense parts, a slight movement in the rest, and now and then (when it is
  // easy) nothing at all. `slot` counts half bars. Null for standing.
  function chooseStep(dancer, level, slot, period) {
    const { strikes, slights } = dancer.clips, seed = hashOf(slot, dancer.turns++);
    const choose = list => { const fresh = list.filter(v => !dancer.recent.includes(v)), from = fresh.length ? fresh : list; return from[seed % from.length]; };
    let kind, clip = null, variant;
    if (level >= INTENSE && strikes.length) {
      kind = 'strike';
      clip = strikes[(seed >>> 5) % strikes.length];
      variant = choose(level >= 0.75 ? STRIKE_HIGH : STRIKE_MID);
    } else if (level >= EASY) {
      if (slot % 6 === 5) return null;
      kind = 'slight';
      if (slights.length && seed % 10 < 3) { clip = slights[(seed >>> 5) % slights.length]; variant = choose(['normal', 'reverse']); }
      else variant = choose(BODY);
    } else {
      if (slot % 3 !== 0) return null;
      kind = 'slight';
      variant = choose(['sway', 'dip']);
    }
    dancer.recent.push(variant);
    if (dancer.recent.length > 2) dancer.recent.shift();
    const long = clip ? clip.frames / clip.fps / NOMINAL : 4, round2 = n => Math.max(2, Math.round(n / 2) * 2);
    let beats;
    if (kind === 'strike') {
      beats = Math.min(8, round2(long));
      if (variant === 'double') beats = Math.max(2, beats / 2);
      else if (variant === 'first' || variant === 'second') beats = Math.max(2, round2(long / 2));
      else if (variant === 'spin' || variant === 'slide') beats = Math.max(4, beats);
    } else if (clip) beats = Math.min(4, round2(long));
    else beats = variant === 'dip' ? 2 : 4;
    return { kind, clip, variant, beats, start: slot * 2, dir: seed & 1 ? 1 : -1 };
  }

  // Miror B. at beat `b`: the motion and frame he is in, and how his body is moved about the dais as he does it.
  function danceStar(dancer, b, period, dancing, level) {
    const slot = Math.floor(b / 2), extra = { x: 0, yaw: 0, roll: 0, squash: 1, up: 0 };
    if (slot !== dancer.bar) {
      dancer.bar = slot;
      if (dancer.step && slot * 2 >= dancer.step.start + dancer.step.beats) dancer.step = null;
      if (!dancer.step && dancing) dancer.step = chooseStep(dancer, level, slot, period);
      if (!dancing) dancer.step = null;
    }
    const st = dancer.step, amp = 0.55 + 0.9 * level;
    // standing: his idle, on the beat
    if (!st) { dancer.clip = dancer.clips.idle; dancer.frame = idleFrame(dancer, b, period); return extra; }
    const u = Math.max(0, Math.min(1, (b - st.start) / st.beats)), turn = Math.PI * 2;
    if (st.clip) {
      const top = st.clip.frames - 1;
      const at = st.variant === 'reverse' ? 1 - u : st.variant === 'first' ? u * 0.5 : st.variant === 'second' ? 0.5 + u * 0.5 : u;
      dancer.clip = st.clip;
      dancer.frame = Math.max(0, Math.min(top, Math.round(at * top)));
    } else { dancer.clip = dancer.clips.idle; dancer.frame = idleFrame(dancer, b, period); }
    switch (st.variant) {
      case 'spin': extra.yaw = turn * beatOf().ease(u) * st.dir; break;
      case 'slide': extra.x = st.dir * 0.8 * Math.sin(Math.PI * u); break;
      case 'sway': extra.roll = 0.17 * amp * Math.sin(turn * u * 2); extra.x = 0.3 * amp * Math.sin(turn * u * 2); break;
      case 'twist': extra.yaw = 0.7 * amp * Math.sin(turn * u * 2); break;
      case 'step': extra.x = 0.7 * amp * Math.sin(turn * u); extra.yaw = 0.25 * Math.sin(turn * u); break;
      case 'dip': extra.squash = 1 - 0.12 * amp * Math.pow(Math.abs(Math.sin(Math.PI * u * st.beats)), 2); break;
      case 'turn': extra.yaw = st.dir * 0.9 * Math.sin(Math.PI * u); break;
      default: break;
    }
    return extra;
  }


  // --- The ring's dance. All six always dance their idle hop on the beat; how intense the song is adds variety to it. A calm song has them in unison
  // with a sway now and then; as it grows intense they split into two groups and then three, each doing its own thing (twisting, dipping, turning,
  // stepping, swaying), some taking up a lunge, a staggered wave of bounce running round the ring, and, at the most, spinning.
  const RING_POOLS = [
    { below: 0.25, pool: ['idle', 'idle', 'idle', 'sway'] },
    { below: 0.5, pool: ['sway', 'twist', 'dip', 'turn', 'idle', 'sway'] },
    { below: 0.75, pool: ['sway', 'twist', 'dip', 'turn', 'step', 'wave', 'move', 'twist'] },
    { below: 1.01, pool: ['spin', 'wave', 'move', 'move', 'dip', 'turn', 'twist', 'step'] },
  ];
  // What each group chose for each half bar, so that its dancers all do the same (and a group does not repeat itself: it remembers its last)
  const groupChoice = new Map(), groupLast = new Map();
  function chooseRing(dancer, level, slot) {
    const group = level < 0.5 ? 0 : level < 0.75 ? dancer.index % 2 : dancer.index % 3, seed = hashOf(slot, group + 11);
    const band = RING_POOLS.findIndex(each => level < each.below), pool = RING_POOLS[band].pool, key = `${slot}:${group}:${band}`;
    let variant = groupChoice.get(key);
    if (variant === undefined) {
      const fresh = pool.filter(v => v !== groupLast.get(group)), from = fresh.length ? fresh : pool;
      variant = from[seed % from.length];
      groupChoice.set(key, variant);
      groupLast.set(group, variant);
      for (const old of groupChoice.keys()) if (Number(old.split(':')[0]) < slot - 8) groupChoice.delete(old);
    }
    if (variant === 'idle') return null;
    if (variant === 'move' && !dancer.clips.moves.length) variant = 'dip';
    let clip = null, beats = 4;
    if (variant === 'move') {
      clip = dancer.clips.moves[(seed >>> 5) % dancer.clips.moves.length];
      beats = Math.min(8, Math.max(4, Math.round(clip.frames / clip.fps / NOMINAL / 4) * 4));
    }
    return { variant, clip, beats, start: slot * 2, dir: (seed >>> 3) & 1 ? 1 : -1 };
  }

  // A ring dancer at beat `b`: its motion and frame, and how its body is moved on its platform as it does it.
  function danceRing(dancer, b, period, dancing, level, spot) {
    const slot = Math.floor(b / 2), extra = { x: 0, z: 0, yaw: 0, roll: 0, squash: 1 };
    if (slot !== dancer.bar) {
      dancer.bar = slot;
      if (dancer.step && slot * 2 >= dancer.step.start + dancer.step.beats) dancer.step = null;
      // a step begins on the first beat of a bar and lasts whole bars, so the dancers of a group always begin and end together
      if (!dancer.step && dancing && slot % 2 === 0) dancer.step = chooseRing(dancer, level, slot);
      if (!dancing) dancer.step = null;
    }
    const st = dancer.step, amp = 0.5 + 0.9 * level, turn = Math.PI * 2;
    dancer.phase = st?.variant === 'wave' ? dancer.index * 0.33 : 0;
    dancer.clip = dancer.clips.idle;
    dancer.frame = idleFrame(dancer, b, period);
    if (!st) return extra;
    const u = Math.max(0, Math.min(1, (b - st.start) / st.beats));
    switch (st.variant) {
      case 'move': {
        dancer.clip = st.clip;
        dancer.frame = Math.max(0, Math.min(st.clip.frames - 1, Math.round(u * (st.clip.frames - 1))));
        break;
      }
      case 'sway': extra.roll = dancer.side * 0.2 * amp * Math.sin(turn * u * 2); break;
      case 'twist': extra.yaw = 0.6 * amp * Math.sin(turn * u * 2); break;
      case 'dip': extra.squash = 1 - 0.1 * amp * Math.pow(Math.abs(Math.sin(Math.PI * u * st.beats)), 2); break;
      case 'turn': extra.yaw = st.dir * 0.8 * Math.sin(Math.PI * u); break;
      case 'step': {
        // side to side along the platform
        const length = Math.hypot(spot.x, spot.z) || 1, d = 0.3 * amp * Math.sin(turn * u);
        extra.x = spot.z / length * d; extra.z = -spot.x / length * d;
        break;
      }
      case 'spin': extra.yaw = turn * beatOf().ease(u) * st.dir; break;
      default: break;
    }
    return extra;
  }

  function draw(now, still = false) {
    const seconds = now / 1000, step = Math.min(0.1, lastFrame ? (now - lastFrame) / 1000 : 0.016);
    lastFrame = now;
    frameStep = step;
    const dancing = still ? false : listen(now) || now - lastSound < SETTLE_MS;
    shake = Math.max(0, shake - step * 4);
    // how intense the song is: smoothly, for the dancers' choices, and quickly, for what is shown
    const heard = playing && !still ? intensityNow() : { level: 0.3, energy: 0.15 };
    levelS += (heard.level - levelS) * Math.min(1, step * 4);
    energyS += (heard.energy - energyS) * Math.min(1, step * 10);
    if (meter) meter.style.setProperty('--level', energyS.toFixed(3));
    // the hall settles into the framing wanted
    if (Math.abs(framing.x - framingGoal.x) + Math.abs(framing.y - framingGoal.y) > 0.0005) {
      const k = Math.min(1, step * 5);
      framing = { x: framing.x + (framingGoal.x - framing.x) * k, y: framing.y + (framingGoal.y - framing.y) * k };
      applyFraming();
    }
    // the camera sways a little and pushes in on a beat
    camera.position.x = Math.sin(seconds * 0.35) * 0.5;
    camera.lookAt(0, 0.9, 0);
    camera.updateMatrixWorld();
    lightDirections.forEach((direction, i) => lighting.lightDir.value[i].copy(direction).transformDirection(camera.matrixWorldInverse));
    for (const light of room.pulse) light.material.opacity = Math.min(1, light.base * (0.5 + 0.7 * energyS) * (0.8 + 0.4 * pulse));
    room.drift(seconds);
    visualizer.update(wave, bins, pulse, seconds, playing, energyS);
    room.rise(step);
    // where the music is in beats, as it is being heard: the sound reaches the speakers a moment after the analyser has it
    const beatInfo = beatNow(seconds), { b, period, inBar } = beatInfo;
    const bar = Math.floor(b / 4);
    const ring = dancers.filter(each => each.role === 'ring'), first = ring[0]?.clips.hop && ring[0].air ? ring[0] : null;
    stepHop(b, dancing, first, beatInfo);
    const h = hopState;
    const occupied = new Array(DANCERS).fill(0);
    for (const dancer of dancers) {
      const star = dancer.role === 'star', hopping = !star && first && h.state !== 'dance';
      let x = dancer.x, z = dancer.z, yaw = dancer.yaw, here = null;
      if (!star) {
        // where it stands, which moves along the ring as the dancers hop round it
        const slot = (dancer.index + h.shift) % DANCERS, next = spots[(slot + 1) % DANCERS], before = spots[(slot + DANCERS - 1) % DANCERS];
        here = spots[slot];
        const face = Math.atan2(-here.x, FACING - here.z), toNext = Math.atan2(next.x - here.x, next.z - here.z), fromBefore = Math.atan2(here.x - before.x, here.z - before.z);
        x = here.x; z = here.z; yaw = face;
        if (h.state === 'turn') yaw = beatOf().angleLerp(face, toNext, beatOf().ease(h.u));
        else if (h.state === 'back') yaw = beatOf().angleLerp(fromBefore, face, beatOf().ease(h.u));
        else if (h.state === 'jump') {
          const { take, land } = dancer.air, p = beatOf().ease((h.frame - take) / Math.max(1, land - take));
          yaw = toNext;
          x = here.x + (next.x - here.x) * p;
          z = here.z + (next.z - here.z) * p;
          occupied[(slot + (p > 0.5 ? 1 : 0)) % DANCERS] = 1;
        }
        if (h.state !== 'jump') occupied[slot] = 1;
      }

      const flip = star ? dancer.clips.flip : null, jumpU = b - h.jumpStart;
      let extra = null, flipping = false;
      if (!star && h.state === 'jump') {
        dancer.clip = dancer.clips.hop;
        dancer.frame = Math.max(0, Math.min(dancer.clip.frames - 1, Math.floor(h.frame)));
      } else if (flip && (h.state === 'jump' || (h.state === 'back' && jumpU < 1 + h.air + 1))) {
        // Miror B. flips as the Ludicolo leap: the same crouch, the same beats in the air, and so down on the same beat
        const { take, land } = dancer.clips.flipAir, u = jumpU;
        dancer.clip = flip;
        dancer.step = null; dancer.bar = -1; flipping = true;
        dancer.frame = Math.max(0, Math.min(flip.frames - 1, Math.floor(u < 1 ? take * Math.max(0, u) : u < 1 + h.air ? take + (land - take) * (u - 1) / h.air : land + (u - 1 - h.air) * period * flip.fps)));
      } else if (star) {
        extra = danceStar(dancer, b, period, dancing, levelS);
        dancer.level = levelS;
      } else {
        extra = danceRing(dancer, b, period, dancing, levelS, here);
        dancer.level = levelS;
      }
      // a new motion settles in from the last pose
      if (dancer.clip !== dancer.lastClip) {
        if (dancer.lastClip && dancer.posed) dancer.blend = { from: Float32Array.from(dancer.last), t: 0 };
        dancer.lastClip = dancer.clip;
      }

      const m = dancing && !hopping && h.state === 'dance' || (star && dancing && !flipping)
        ? beatOf().move({ seconds, beat: b, pulse, tempo, dancer: dancer.phase, side: dancer.side, accent: (inBar === 0 ? 1.5 : 1) * (0.4 + levelS) * (star ? 1 : 0.6 + 0.8 * energyS) })
        : { y: 0, roll: 0, yawOffset: 0, squash: 1 };
      const grow = 1, pop = 0;
      const ex = extra || { x: 0, z: 0, yaw: 0, roll: 0, squash: 1 };
      dancer.group.position.set(x + ex.x, dancer.height / 2 + dancer.floor + m.y + pop, z + (ex.z || 0));
      dancer.group.rotation.set(0, yaw + m.yawOffset + ex.yaw, m.roll + ex.roll);
      dancer.body.scale.set(dancer.scale * grow, dancer.scale * m.squash * ex.squash * grow, dancer.scale * grow);

      if (dancer.rig.billboards) {
        dancer.group.updateMatrixWorld(true);
        inverse.copy(camera.matrixWorldInverse);
        toView.multiplyMatrices(inverse, dancer.group.matrixWorld).multiply(centered);
      }
      pose(dancer, dancer.frame);
      stay(dancer);
    }
    // a pedestal glows brightest with a dancer on it, and dimly when it is bare
    room.edges.forEach((edge, i) => {
      edge.level += ((0.3 + 0.7 * occupied[i]) - edge.level) * Math.min(1, step * 8);
      edge.material.opacity = Math.min(1, edge.base * edge.level * (0.6 + 0.6 * energyS) * (0.8 + 0.4 * pulse));
    });
    renderer.render(scene, camera);
  }

  function tick(now) {
    if (!running) return;
    if (background || disposed) { running = false; return; }
    draw(now);
    // holds still once the music has been quiet for a while: a last frame is already on the canvas
    if (!dancers.length || now - lastSound > SETTLE_MS * 2) {
      if (listening?.()?.playing?.()) lastSound = now;
      else { running = false; return; }
    }
    requestAnimationFrame(tick);
  }
  function start() {
    if (running || background || disposed) return;
    running = true;
    lastSound = performance.now();
    requestAnimationFrame(tick);
  }

  const abort = new AbortController();
  document.addEventListener('visibilitychange', () => { background = document.hidden; start(); }, { signal: abort.signal });
  window.addEventListener('blur', () => { background = true; }, { signal: abort.signal });
  window.addEventListener('focus', () => { background = false; start(); }, { signal: abort.signal });
  resize();
  start();

  return {
    setDancers, setStar,
    // `source()` gives { analyser, playing() } when there is sound to dance to.
    listenTo(source) { listening = source; start(); },
    wake: start,
    // 'backdrop' (the songs in front) or 'watch' (the songs cleared away)
    frame(mode) { framingGoal = FRAMES[mode] || FRAMES.backdrop; start(); },
    dispose() {
      disposed = true;
      running = false;
      abort.abort();
      observer.disconnect();
      clearDancers();
      for (const thing of room.dispose) thing.dispose?.();
      visualizer.dispose();
      meter?.style.setProperty('--level', '0');
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

// --- The page's part: the toggle, the canvas, and reading Ludicolo from the disc --------------------------------------------------

const SAVED = 'colo.jukebox.chamber';
const remembered = () => { try { return localStorage.getItem(SAVED) !== 'off'; } catch (_) { return true; } };
const remember = on => { try { localStorage.setItem(SAVED, on ? 'on' : 'off'); } catch (_) { /* private mode */ } };

let chamber = null, request = 0, wanted = remembered();
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function setStatus(text) {
  $('jukebox-chamber-status').textContent = text;
  $('jukebox-chamber-status').hidden = !text;
}

// The motions of a model, as the Pokédex lists them: its header's, else each animation long enough to be one.
function motionsOf(model) {
  if (model.motions?.length) return model.motions;
  return model.animations.map((frames, index) => ({ index, frames })).filter(({ frames }) => frames >= 20)
    .map(({ index }, position) => ({ index, kind: position ? 'extra' : 'idle' }));
}

async function decodeHdTextures(model) {
  await Promise.all(model.textures.map(async source => {
    if (!source.image) return;
    try { source.bitmap = await createImageBitmap(new Blob([source.image], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch (_) { /* the disc's own */ }
    delete source.image;
  }));
}

async function loadDancers(mine) {
  setStatus('Calling in the Ludicolo…');
  try {
    const list = await window.colo.pokedex();
    const entry = list.species.find(each => each.national === NATIONAL_LUDICOLO);
    if (!entry) throw new Error('Ludicolo isn\'t on this disc.');
    // the Pokédex page keys a disc Pokémon by its National number (pokedex-page.js combine)
    const key = String(entry.national), form = entry.forms[0].id, model = await window.colo.pokedexModel(key, form);
    const motions = motionsOf(model), idle = motions.find(each => each.kind === 'idle') ?? motions[0];
    const clipOf = each => each ? window.colo.pokedexClip(key, form, each.index) : null;
    const moves = [];
    for (const kind of MOVES) {
      const found = motions.find(each => each.kind === kind && each !== idle);
      if (found) moves.push(found);
    }
    const jump = motions.find(each => each.kind === 'special' && each !== idle);
    const [idleClip, hopClip, ...moveClips] = await Promise.all([clipOf(idle), clipOf(jump), ...moves.map(clipOf)]);
    await decodeHdTextures(model);
    if (mine !== request || !chamber) return;
    chamber.setDancers(model, idleClip, moveClips, hopClip);
    setStatus('');
    await loadStar(mine);
  } catch (error) {
    if (mine === request) setStatus(message(error));
  }
}

// Miror B., who dances in the middle: his battle model, from XD's disc (Colosseum's has none, and then the middle stays bare). Whatever goes
// wrong with him leaves the Ludicolo dancing.
async function loadStar(mine) {
  try {
    const model = await window.colo.jukeboxMirorModel();
    if (!model || mine !== request || !chamber) return;
    const motions = motionsOf(model), idle = motions.find(each => each.kind === 'idle') ?? motions[0];
    // every other motion he has is a step to dance: his throws, his hits, the rest
    const steps = motions.filter(each => each !== idle && each.kind !== 'faint').slice(0, 5);
    const [idleClip, ...stepClips] = await Promise.all([idle, ...steps].map(each => each ? window.colo.jukeboxMirorClip(each.index) : null));
    await decodeHdTextures(model);
    if (mine !== request || !chamber) return;
    chamber.setStar(model, idleClip, stepClips);
  } catch (_) { /* no Miror B. on this disc */ }
}

function open() {
  if (chamber) return chamber;
  // a new canvas each time: a context that was let go can't make another
  const canvas = $('jukebox-chamber-canvas').cloneNode(false);
  $('jukebox-chamber-canvas').replaceWith(canvas);
  try { chamber = createChamber(canvas); }
  catch (_) { setStatus('The 3D view couldn\'t start. Restart the launcher to reset its graphics.'); return null; }
  chamber.listenTo(window.coloJukebox?.listen ?? null);
  return chamber;
}

// Watch: the songs clear away to leave the chamber, and one button brings them back.
function watch(on) {
  $('page-jukebox').toggleAttribute('data-watch', on);
  $('jukebox-chamber-back').hidden = !on;
  chamber?.frame(on ? 'watch' : 'backdrop');
}

function close() {
  request++;
  watch(false);
  chamber?.dispose();
  chamber = null;
  setStatus('');
}

function sync() {
  const page = $('page-jukebox');
  const show = wanted && !page.hidden;
  $('jukebox-chamber').hidden = !show;
  page.classList.toggle('has-chamber', show);
  $('jukebox-chamber-toggle').checked = wanted;
  $('jukebox-chamber-watch').hidden = !show;
  if (!show) return close();
  if (open() && !chamber.loaded) { chamber.loaded = true; loadDancers(++request); }
  else chamber?.wake();
}

$('jukebox-chamber-watch').addEventListener('click', () => watch(true));
$('jukebox-chamber-back').addEventListener('click', () => watch(false));
$('jukebox-chamber-toggle').addEventListener('change', event => {
  wanted = event.target.checked;
  remember(wanted);
  sync();
});
// Esc brings the song list back from Watch
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('page-jukebox').hasAttribute('data-watch')) { event.preventDefault(); watch(false); }
});

window.coloJukeboxChamber = {
  show() { sync(); },
  hide() { close(); },
  // another game's disc: its Ludicolo are read again
  reset() { close(); },
  // music has started: the dancers wake
  wake() { chamber?.wake(); },
};
