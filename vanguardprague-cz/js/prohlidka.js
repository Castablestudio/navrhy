// 3D prohlídka poskládaná z fotek (Pepa 27. 11. 2026 19:18: „ať to furt bude 3D, ale bude to poskládané z těch fotek“).
// Každá fotka dostane hloubku (img/hloubka/*.png, hloubka.py) a stane se z ní síť ve 3D: z místa focení vypadá
// přesně jako fotka, pohybem myši nebo prstu se dá rozhlédnout a kolečkem nebo dvěma prsty jít dál do pokoje.
// Přechod na další fotku: kamera vykročí dopředu a pokoj se prolne s dalším.
import * as THREE from 'three';

const BLIZKO = 1.4, DALEKO = 11, HFOV = 74;   // metry a vodorovný úhel záběru (širokoúhlý objektiv interiérových fotek)
let R = null;
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function nactiObrazek(src) {
  return new Promise((ok, chyba) => { const i = new Image(); i.decoding = 'async'; i.onload = () => ok(i); i.onerror = chyba; i.src = src; });
}

async function sit(foto) {
  const [img, hl] = await Promise.all([nactiObrazek(foto.src), nactiObrazek(foto.hloubka)]);
  const asp = img.naturalWidth / img.naturalHeight;
  const c = document.createElement('canvas'); c.width = hl.naturalWidth; c.height = hl.naturalHeight;
  const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(hl, 0, 0);
  const px = cx.getImageData(0, 0, c.width, c.height).data;
  const hw = c.width, hh = c.height;
  const vzorek = (u, v) => {   // bilineárně, u, v v 0..1 (v odshora)
    const x = u * (hw - 1), y = v * (hh - 1), x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(hw - 1, x0 + 1), y1 = Math.min(hh - 1, y0 + 1);
    const fx = x - x0, fy = y - y0, g = (xx, yy) => px[(yy * hw + xx) * 4] / 255;
    return (g(x0, y0) * (1 - fx) + g(x1, y0) * fx) * (1 - fy) + (g(x0, y1) * (1 - fx) + g(x1, y1) * fx) * fy;
  };
  const tanH = Math.tan(THREE.MathUtils.degToRad(HFOV / 2)), tanV = tanH / asp;
  const sx = 200, sy = Math.max(60, Math.round(200 / asp));
  const geo = new THREE.PlaneGeometry(1, 1, sx, sy);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    const disp = vzorek(u, 1 - v);
    const d = 1 / (disp * (1 / BLIZKO - 1 / DALEKO) + 1 / DALEKO);
    pos.setXYZ(i, (u * 2 - 1) * tanH * d, (v * 2 - 1) * tanV * d, -d);
  }
  pos.needsUpdate = true; geo.computeBoundingSphere();
  const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.needsUpdate = true;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: true });
  const m = new THREE.Mesh(geo, mat);
  m.userData = { vfov: THREE.MathUtils.radToDeg(2 * Math.atan(tanV)), asp };
  return m;
}

export async function otevri(kod, tour) {
  const box = el('div', 'pr3d nacita');
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', `Prohlídka loftu ${kod}`);
  box.innerHTML = `
    <div class="pr3d-platno"></div>
    <header class="pr3d-hlava">
      <button class="pr3d-zpet" type="button">← Zpět</button>
      <div class="pr3d-titul"><p class="pr3d-k"></p><h2></h2></div>
      <a class="tl tl--svetlo pr3d-prohlidka" href="#prohlidka">Domluvit prohlídku</a>
    </header>
    <button class="pr3d-sip pr3d-sip--l" type="button" aria-label="Předchozí místnost">←</button>
    <button class="pr3d-sip pr3d-sip--p" type="button" aria-label="Další místnost">→</button>
    <div class="pr3d-dole">
      <p class="pr3d-mistnost" aria-live="polite"></p>
      <ul class="pr3d-pas"></ul>
      <p class="pr3d-tip">Pohněte myší a rozhlédněte se. Kolečkem nebo dvěma prsty jděte dál do pokoje.</p>
    </div>`;
  document.body.append(box);
  document.documentElement.classList.add('pr3d-otevreno');
  requestAnimationFrame(() => box.classList.add('je'));
  box.querySelector('.pr3d-k').textContent = tour.podtitul;
  box.querySelector('h2').textContent = tour.nazev;
  box.querySelector('.pr3d-prohlidka').addEventListener('click', () => { const s = document.getElementById('f-loft'); if (s) s.value = kod; zavri(); });

  const platno = box.querySelector('.pr3d-platno');
  if (!R) { R = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
  R.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  platno.append(R.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, .05, 100);
  function velikost() { const w = platno.clientWidth, h = platno.clientHeight; R.setSize(w, h, false); camera.aspect = w / h; nastavZaber(); }

  // fotky: první hned, ostatní na pozadí
  const site = new Array(tour.fotky.length).fill(null);
  const nacti = i => site[i] || (site[i] = sit(tour.fotky[i]).then(m => { scene.add(m); m.visible = false; return m; }));
  let i = 0, aktual = null, prechod = null;

  // záběr: celá fotka na obrazovce (podle poměru stran fotky i okna), bez okrajů
  function nastavZaber() {
    if (!aktual) { camera.updateProjectionMatrix(); return; }
    const { vfov, asp } = aktual.userData;
    // fotka musí vyplnit okno: když je okno širší než fotka, zúžit svislý úhel
    const v = camera.aspect > asp ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(vfov / 2)) * asp / camera.aspect)) : vfov;
    camera.fov = v * .94; camera.updateProjectionMatrix();
  }

  // ovládání: rozhlížení (myš, prst), krok dovnitř (kolečko, dva prsty), jemný samovolný pohyb
  let cilX = 0, cilY = 0, x = 0, y = 0, krok = 0, cilKrok = 0, tah = null, posledniPohyb = performance.now();
  platno.addEventListener('pointermove', ev => {
    const r = platno.getBoundingClientRect();
    if (tah) { cilX = Math.max(-1, Math.min(1, tah.x + (ev.clientX - tah.sx) / r.width * -2.4)); cilY = Math.max(-1, Math.min(1, tah.y + (ev.clientY - tah.sy) / r.height * -2.4)); }
    else if (ev.pointerType === 'mouse') { cilX = (ev.clientX - r.left) / r.width * 2 - 1; cilY = (ev.clientY - r.top) / r.height * 2 - 1; }
    posledniPohyb = performance.now();
  });
  platno.addEventListener('pointerdown', ev => { tah = { sx: ev.clientX, sy: ev.clientY, x: cilX, y: cilY }; platno.setPointerCapture(ev.pointerId); });
  platno.addEventListener('pointerup', () => { tah = null; });
  platno.addEventListener('wheel', ev => { ev.preventDefault(); cilKrok = Math.max(0, Math.min(1.6, cilKrok - ev.deltaY * .0016)); posledniPohyb = performance.now(); }, { passive: false });
  let pinch = null;
  platno.addEventListener('touchmove', ev => {
    if (ev.touches.length !== 2) return;
    const d = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
    if (pinch != null) cilKrok = Math.max(0, Math.min(1.6, cilKrok + (d - pinch) * .006));
    pinch = d; ev.preventDefault();
  }, { passive: false });
  platno.addEventListener('touchend', () => { pinch = null; });

  // pruh s místnostmi
  const pas = box.querySelector('.pr3d-pas');
  tour.fotky.forEach((f, k) => {
    const li = el('li'); const b = el('button', null, `<img src="${f.src}" alt="" loading="lazy"><span>${f.nazev}</span>`);
    b.type = 'button'; b.addEventListener('click', () => jdi(k)); li.append(b); pas.append(li);
  });
  const mistnost = box.querySelector('.pr3d-mistnost');
  function popis() {
    mistnost.textContent = `${tour.fotky[i].nazev} · ${i + 1} z ${tour.fotky.length}`;
    pas.querySelectorAll('button').forEach((b, k) => { b.classList.toggle('je', k === i); if (k === i) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); });
  }
  box.querySelector('.pr3d-sip--l').addEventListener('click', () => jdi((i - 1 + tour.fotky.length) % tour.fotky.length));
  box.querySelector('.pr3d-sip--p').addEventListener('click', () => jdi((i + 1) % tour.fotky.length));

  async function jdi(k, hned) {
    if (prechod || (k === i && aktual)) return;
    const dalsi = await nacti(k);
    const pryc = aktual;
    i = k; popis();
    dalsi.visible = true; dalsi.material.opacity = 0; dalsi.renderOrder = 2;
    if (pryc) pryc.renderOrder = 1;
    prechod = { t0: performance.now(), ms: hned ? 900 : 1150, pryc, dalsi, odKrok: krok };
    nacti((k + 1) % tour.fotky.length);   // další dopředu
  }

  const v = new THREE.Vector3();
  let bezi = true;
  function snimek(now) {
    if (!bezi) return;
    // samovolný pomalý pohyb, když se nikdo nehýbe
    const klid = now - posledniPohyb > 2500;
    const tx = klid ? Math.sin(now / 3400) * .45 : cilX, ty = klid ? Math.sin(now / 4100) * .2 : cilY;
    x += (tx - x) * .06; y += (ty - y) * .06; krok += (cilKrok - krok) * .08;
    let posun = 0;
    if (prechod) {
      const k = Math.min(1, (now - prechod.t0) / prechod.ms), e = ease(k);
      // kamera vykročí do pokoje, starý pokoj zmizí, nový se objeví a usadí
      if (prechod.pryc) prechod.pryc.material.opacity = 1 - Math.min(1, e * 1.4);
      prechod.dalsi.material.opacity = Math.min(1, e * 1.25);
      posun = prechod.pryc ? (e < .55 ? e / .55 * 1.4 : (1 - e) / .45 * -.5) : (1 - e) * .8;
      if (k >= .55 && aktual !== prechod.dalsi) { aktual = prechod.dalsi; cilKrok = krok = 0; nastavZaber(); }
      if (k >= 1) { if (prechod.pryc && prechod.pryc !== prechod.dalsi) prechod.pryc.visible = false; aktual = prechod.dalsi; nastavZaber(); prechod = null; }
    }
    // pohled: malý posun hlavy a natočení = skutečná paralaxa z hloubky fotky
    camera.position.set(x * .32, -y * .16, -(krok + posun));
    v.set(-x * .55, y * .3, -(krok + posun) - 6);
    camera.lookAt(v);
    R.render(scene, camera);
    requestAnimationFrame(snimek);
  }

  velikost();
  const naResize = () => velikost();
  addEventListener('resize', naResize);
  await nacti(0);
  box.classList.remove('nacita');
  aktual = null;
  await jdi(0, true);
  requestAnimationFrame(snimek);

  function zavri() {
    bezi = false; removeEventListener('resize', naResize); removeEventListener('keydown', klavesy);
    box.classList.remove('je'); document.documentElement.classList.remove('pr3d-otevreno');
    setTimeout(() => { site.forEach(p => p && p.then(m => { m.geometry.dispose(); m.material.map.dispose(); m.material.dispose(); })); box.remove(); }, 400);
  }
  function klavesy(ev) {
    if (ev.key === 'Escape') zavri();
    if (ev.key === 'ArrowRight') jdi((i + 1) % tour.fotky.length);
    if (ev.key === 'ArrowLeft') jdi((i - 1 + tour.fotky.length) % tour.fotky.length);
  }
  addEventListener('keydown', klavesy);
  box.querySelector('.pr3d-zpet').addEventListener('click', zavri);
  box.querySelector('.pr3d-zpet').focus({ preventScroll: true });
}
