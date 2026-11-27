// Byt ve 3D ze skutečného půdorysu (Pepa 27. 11. 2026: „ta stránka se přiblíží na ten jeden byt a půjde tam celý proklikat“).
// Stěny: img/3d/<kod>.json (plany3d.py), podlaha: výřez půdorysu. Místnosti jdou proklikat, pohled do nich přiletí.
import * as THREE from 'three';
import { OrbitControls } from './OrbitControls.js';

const VYSKA = [2.9, 2.5];           // výška stěn bytu a galerie (m)
let R = null;                       // jeden renderer na stránku

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const m2 = v => (Math.round(v * 10) / 10).toLocaleString('cs-CZ') + ' m²';

function ui() {
  const box = el('div', 'b3d'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
  box.innerHTML = `
    <div class="b3d-platno"></div>
    <div class="b3d-body" aria-hidden="true"></div>
    <header class="b3d-hlava">
      <button class="b3d-zpet" type="button">← Zpět na patro</button>
      <div class="b3d-titul"><p class="b3d-k"></p><h2></h2><p class="b3d-sub"></p></div>
      <div class="b3d-ovl">
        <div class="b3d-urovne" role="group" aria-label="Podlaží bytu"></div>
        <button class="b3d-pohled" type="button">Půdorys 2D</button>
      </div>
    </header>
    <aside class="b3d-panel">
      <p class="b3d-panel-k">Místnosti</p>
      <ul class="b3d-mistnosti"></ul>
      <div class="b3d-karta" hidden></div>
      <div class="b3d-akce"><a class="tl tl--svetle b3d-detail" href="#">Fotky a ceník</a><a class="tl tl--svit b3d-prohlidka" href="#prohlidka">Domluvit prohlídku</a></div>
    </aside>
    <p class="b3d-tip">Táhněte myší nebo prstem a byt se otočí. Kolečkem nebo dvěma prsty přiblížíte.</p>`;
  document.body.append(box);
  return box;
}

function svetla(scene) {
  scene.add(new THREE.HemisphereLight(0xfff6ea, 0x3b3f44, 1.35));
  const s = new THREE.DirectionalLight(0xffe2bd, 2.1);
  s.position.set(-9, 16, 7); s.castShadow = true;
  s.shadow.mapSize.set(2048, 2048); s.shadow.bias = -0.0004; s.shadow.normalBias = 0.02;
  const c = s.shadow.camera; c.left = -18; c.right = 18; c.top = 18; c.bottom = -18; c.near = 1; c.far = 60;
  scene.add(s);
  const z = new THREE.DirectionalLight(0xbcd2ff, .45); z.position.set(10, 8, -8); scene.add(z);
}

function postavUroven(u, lvlIndex, tex) {
  const g = new THREE.Group(); g.userData.lvl = lvlIndex;
  const cx = u.w / 2, cz = u.d / 2;
  // podlaha = skutečný půdorys
  const t = tex.load(u.podlaha); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const podlaha = new THREE.Mesh(new THREE.PlaneGeometry(u.w, u.d), new THREE.MeshStandardMaterial({ map: t, roughness: .92 }));
  podlaha.rotation.x = -Math.PI / 2; podlaha.receiveShadow = true; g.add(podlaha);
  // stěny: bílé boky, tmavý řez nahoře (jako v architektonickém půdorysu)
  const bok = new THREE.MeshStandardMaterial({ color: 0xf1ede6, roughness: .85 });
  const rez = new THREE.MeshStandardMaterial({ color: 0x23272b, roughness: .7 });
  const mats = [bok, bok, rez, bok, bok, bok];
  const n = u.steny.length;
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mats, n);
  im.castShadow = true; im.receiveShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  u.steny.forEach(([x, z, w, d], i) => {
    p.set(x + w / 2 - cx, 0, z + d / 2 - cz); s.set(Math.max(w, .06), 1, Math.max(d, .06));
    m.compose(p, q, s); im.setMatrixAt(i, m);
  });
  im.userData.vyska = VYSKA[Math.min(lvlIndex, 1)];
  g.add(im); g.userData.steny = im;
  return g;
}

function nastavVysku(im, k) {
  // stěny rostou z půdorysu (k = 0 → plocha, 1 → plná výška)
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const h = Math.max(.02, im.userData.vyska * k);
  for (let i = 0; i < im.count; i++) {
    im.getMatrixAt(i, m); m.decompose(p, q, s);
    s.y = h; p.y = h / 2; m.compose(p, q, s); im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
}

export async function otevri(kod, info) {
  const data = await fetch(`img/3d/${info.typ3d.toLowerCase()}.json`).then(r => r.json());
  const box = ui();
  const platno = box.querySelector('.b3d-platno');
  const body = box.querySelector('.b3d-body');
  const panel = box.querySelector('.b3d-panel');
  const seznam = box.querySelector('.b3d-mistnosti');
  const karta = box.querySelector('.b3d-karta');

  // hlavička
  box.querySelector('.b3d-k').textContent = `Vanguard · ${info.p}. patro`;
  box.querySelector('h2').textContent = kod;
  box.querySelector('.b3d-sub').textContent = [info.disp, m2(info.pl) + (info.ter ? ` + terasa ${m2(info.ter)}` : ''), info.cena || 'cena na dotaz'].join(' · ');
  if (info.typ3d !== kod) box.querySelector('.b3d-sub').insertAdjacentHTML('beforeend', `<span class="b3d-typ">Půdorys loftu ${info.typ3d}, stejně velký loft ve stejné části domu</span>`);
  box.querySelector('.b3d-detail').href = '#' + kod.toLowerCase();
  box.querySelector('.b3d-prohlidka').addEventListener('click', () => { const s = document.getElementById('f-loft'); if (s) s.value = kod; });

  // scéna
  if (!R) { R = new THREE.WebGLRenderer({ antialias: true, alpha: true }); R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap; R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.05; }
  R.setPixelRatio(Math.min(devicePixelRatio, 2));
  platno.append(R.domElement);
  const scene = new THREE.Scene();
  svetla(scene);
  const tex = new THREE.TextureLoader();
  const urovne = data.urovne.map((u, i) => postavUroven(u, i, tex));
  urovne.forEach((g, i) => { g.visible = i === 0; scene.add(g); });
  const zem = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({ color: 0x1a1f23, roughness: 1 }));
  zem.rotation.x = -Math.PI / 2; zem.position.y = -.02; zem.receiveShadow = true; scene.add(zem);

  const camera = new THREE.PerspectiveCamera(38, 1, .1, 200);
  const ctrl = new OrbitControls(camera, R.domElement);
  ctrl.enableDamping = true; ctrl.dampingFactor = .08; ctrl.maxPolarAngle = 1.38; ctrl.screenSpacePanning = true;
  const vel = Math.max(data.urovne[0].w, data.urovne[0].d);
  ctrl.minDistance = 3; ctrl.maxDistance = vel * 4.5;

  let fit = 1;
  function velikost() {
    const w = platno.clientWidth, h = platno.clientHeight;
    R.setSize(w, h, false); camera.aspect = w / h;
    // byt do volného místa: na počítači vlevo od panelu, na telefonu nad panelem
    const pr = panel.getBoundingClientRect();
    // na úzké obrazovce musí kamera dál, aby se byt vešel na šířku
    const volnoW = w > 760 ? pr.left - 24 : w, volnoH = w > 760 ? h : pr.top;
    fit = Math.max(1, 1.15 / (volnoW / Math.max(200, volnoH)));
    if (w > 760) camera.setViewOffset(w, h, Math.round((w - pr.left + 24) / 2), -24, w, h);
    else camera.setViewOffset(w, h, 0, Math.round((h - pr.top) / 2) - 40, w, h);
    camera.updateProjectionMatrix();
  }
  velikost(); addEventListener('resize', velikost);

  // pohledy: shora (2D) a 3D z rohu
  const shora = () => ({ t: new THREE.Vector3(0, 0, 0), p: new THREE.Vector3(0, (vel * 1.7 + 4) * fit, .01) });
  const ze3d = () => ({ t: new THREE.Vector3(0, .6, 0), p: new THREE.Vector3(-vel * .9, vel * 1.12 + 3, vel * 1.02).multiplyScalar(fit) });
  let let_ = null;
  function letNa(cil, ms = 1100, pri) {
    const z = { t: ctrl.target.clone(), p: camera.position.clone() }, t0 = performance.now();
    let_ = { z, cil, t0, ms, pri };
  }

  // místnosti
  let lvl = 0, vybrana = null;
  const stitky = [];
  const foto = data.foto;
  const vse = foto && foto.mapa['*'];
  function obrazkyMistnosti(m) { return foto ? (foto.mapa[m.kod] || []) : []; }
  function ukazKartu(m) {
    const obr = m ? obrazkyMistnosti(m) : (vse || []);
    const nadpis = m ? `<h3>${m.nazev}</h3><p class="b3d-plocha">${m2(m.m2)}</p>` :
      `<h3>Celý loft</h3><p class="b3d-plocha">${m2(info.pl)}${info.ter ? ` + terasa ${m2(info.ter)}` : ''}</p><p class="b3d-pozn">${info.urovenText}</p>`;
    karta.innerHTML = nadpis + (obr.length ? `<div class="b3d-fotky">${obr.map(s => `<img src="${s}" alt="" loading="lazy">`).join('')}</div><p class="b3d-zdroj">Foto: ${foto.popis}</p>` : '');
    karta.hidden = false;
  }
  function vyber(m, kliknuto) {
    vybrana = m;
    stitky.forEach(s => s.b.classList.toggle('je', s.m === m));
    seznam.querySelectorAll('button').forEach(b => b.classList.toggle('je', b._m === m));
    ukazKartu(m);
    if (!m) { letNa(ze3d()); return; }
    if (m.u !== lvl) prepniUroven(m.u, false);
    const u = data.urovne[m.u];
    const t = new THREE.Vector3(m.x - u.w / 2, .4, m.z - u.d / 2);
    const smer = new THREE.Vector3(-.45, 1.5, .7).normalize().multiplyScalar(Math.max(11, Math.sqrt(m.m2) * 2.9) * fit);
    letNa({ t, p: t.clone().add(smer) });
    if (kliknuto && innerWidth < 760) panel.classList.add('dole');
  }
  function stavSeznam() {
    seznam.innerHTML = '';
    stitky.forEach(s => s.b.remove()); stitky.length = 0;
    const mis = data.mistnosti.length ? data.mistnosti : [{ kod: '*', nazev: 'Celý loft', m2: info.pl, u: 0, x: data.urovne[0].w / 2, z: data.urovne[0].d / 2, cely: true }];
    mis.forEach(m => {
      const li = el('li'); const b = el('button', null, `<span>${m.nazev}</span><span>${m2(m.m2)}</span>`);
      b.type = 'button'; b._m = m; b.addEventListener('click', () => m.cely ? vyber(null, true) : vyber(m, true));
      li.append(b); seznam.append(li);
      const s = el('button', 'b3d-stitek', `<i></i><span>${m.nazev}</span>`); s.type = 'button';
      s.addEventListener('click', () => m.cely ? vyber(null, true) : vyber(m, true));
      body.append(s); stitky.push({ b: s, m });
    });
  }
  // podlaží
  const urBox = box.querySelector('.b3d-urovne');
  function prepniUroven(i, letet = true) {
    lvl = i; urovne.forEach((g, k) => g.visible = k === i);
    urBox.querySelectorAll('button').forEach((b, k) => b.classList.toggle('je', k === i));
    if (letet) { vybrana = null; stitky.forEach(s => s.b.classList.remove('je')); seznam.querySelectorAll('button').forEach(b => b.classList.remove('je')); karta.hidden = true; letNa(ze3d(), 800); }
  }
  if (data.urovne.length > 1) data.urovne.forEach((u, i) => {
    const b = el('button', i === 0 ? 'je' : '', u.nazev); b.type = 'button'; b.addEventListener('click', () => prepniUroven(i)); urBox.append(b);
  });
  stavSeznam();
  ukazKartu(null);

  // 2D / 3D
  let ve2d = false;
  const tlPohled = box.querySelector('.b3d-pohled');
  tlPohled.addEventListener('click', () => {
    ve2d = !ve2d; tlPohled.textContent = ve2d ? 'Byt ve 3D' : 'Půdorys 2D';
    const c = ve2d ? shora() : ze3d();
    letNa(c, 900, k => urovne.forEach(g => nastavVysku(g.userData.steny, ve2d ? 1 - k : k)));
  });

  // úvod: plochý půdorys shora, stěny vyrostou a kamera se překlopí do 3D (jako ve videu)
  const s0 = shora(); camera.position.copy(s0.p); ctrl.target.copy(s0.t);
  urovne.forEach(g => nastavVysku(g.userData.steny, 0));
  setTimeout(() => letNa(ze3d(), 1700, k => urovne.forEach(g => nastavVysku(g.userData.steny, k))), 350);

  // smyčka
  const v = new THREE.Vector3();
  let bezi = true;
  function snimek(now) {
    if (!bezi) return;
    if (let_) {
      const k = Math.min(1, (now - let_.t0) / let_.ms), e = ease(k);
      ctrl.target.lerpVectors(let_.z.t, let_.cil.t, e); camera.position.lerpVectors(let_.z.p, let_.cil.p, e);
      if (let_.pri) let_.pri(e);
      if (k >= 1) let_ = null;
    }
    ctrl.update();
    R.render(scene, camera);
    const w = platno.clientWidth, h = platno.clientHeight;
    stitky.forEach(({ b, m }) => {
      const u = data.urovne[m.u];
      if (m.u !== lvl) { b.style.display = 'none'; return; }
      v.set(m.x - u.w / 2, (m.cely ? 1.4 : 1.2), m.z - u.d / 2).project(camera);
      const vidi = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      b.style.display = vidi ? '' : 'none';
      b.style.transform = `translate(${(v.x * .5 + .5) * w}px, ${(-v.y * .5 + .5) * h}px) translate(-50%, -100%)`;
    });
    requestAnimationFrame(snimek);
  }
  requestAnimationFrame(snimek);
  requestAnimationFrame(() => box.classList.add('je'));

  function zavri() {
    bezi = false; removeEventListener('resize', velikost); removeEventListener('keydown', klavesy);
    box.classList.remove('je');
    setTimeout(() => { ctrl.dispose(); scene.traverse(o => { if (o.geometry) o.geometry.dispose(); }); box.remove(); }, 400);
    document.documentElement.classList.remove('b3d-otevreno');
  }
  function klavesy(ev) { if (ev.key === 'Escape') zavri(); }
  addEventListener('keydown', klavesy);
  box.querySelector('.b3d-zpet').addEventListener('click', zavri);
  box.querySelector('.b3d-detail').addEventListener('click', zavri);
  box.querySelector('.b3d-prohlidka').addEventListener('click', zavri);
  panel.querySelector('.b3d-panel-k').addEventListener('click', () => panel.classList.toggle('dole'));
  document.documentElement.classList.add('b3d-otevreno');
  box.querySelector('.b3d-zpet').focus({ preventScroll: true });
}
