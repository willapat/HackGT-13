// Convert a Unity Asset Store .unitypackage into textured .glb files, no Unity needed.
// Each prefab becomes one GLB: its FBX mesh (parsed with three's FBXLoader, which triangulates
// concave n-gons correctly; FBX2glTF mangled the crosswalk road pieces) with its material's texture.
//
//   cd frontend/tools && npm install
//   node import-unitypackage.mjs "<path>.unitypackage" ../assets/simplepoly-city
//
// Skips "_separate" vehicle prefabs (loose wheels) and the demo scene.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeIO, Document } from '@gltf-transform/core';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const [pkg, outDir] = process.argv.slice(2);
if (!pkg || !outDir) throw new Error('usage: node import-unitypackage.mjs <file.unitypackage> <outDir>');

// Unpack: every entry is <guid>/{asset,pathname}.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unitypkg-'));
execFileSync('tar', ['-xzf', pkg, '-C', tmp]);
const entries = {};
for (const guid of fs.readdirSync(tmp)) {
  const pn = path.join(tmp, guid, 'pathname');
  const asset = path.join(tmp, guid, 'asset');
  if (fs.existsSync(pn) && fs.existsSync(asset)) {
    const p = fs.readFileSync(pn, 'utf8').split('\n')[0].trim();
    entries[guid] = { path: p, file: asset, name: path.basename(p, path.extname(p)), ext: path.extname(p).toLowerCase() };
  }
}
const ofType = (ext) => Object.entries(entries).filter(([, e]) => e.ext === ext);

// Binary Unity files store a GUID as 16 bytes with each byte's hex nibbles swapped.
const guidBytes = (g) => [Buffer.from(g, 'hex'), Buffer.from([...Array(16)].map((_, i) => parseInt(g[2 * i + 1] + g[2 * i], 16)))];
const refs = (file, candidates) => {
  const data = fs.readFileSync(file);
  if (!data.includes('guid:')) return candidates.filter(([g]) => guidBytes(g).some((b) => data.includes(b)));
  return candidates.filter(([g]) => data.includes(`guid: ${g}`)); // text-serialized assets
};

const fbxs = ofType('.fbx');
const mats = ofType('.mat');
const texs = ofType('.png').concat(ofType('.jpg'), ofType('.tga'));
const texOfMat = Object.fromEntries(mats.map(([g, m]) => [g, refs(m.file, texs)[0]?.[1]]));

// Bake every mesh into world space and write one untextured-material GLB document.
function fbxToDoc(buf) {
  const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  root.updateMatrixWorld(true);
  const doc = new Document();
  const buffer = doc.createBuffer();
  const material = doc.createMaterial('main').setMetallicFactor(0).setRoughnessFactor(1);
  const mesh = doc.createMesh();
  const attr = (a, type) => doc.createAccessor().setType(type).setArray(new Float32Array(a.array)).setBuffer(buffer);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const prim = doc.createPrimitive().setMaterial(material)
      .setAttribute('POSITION', attr(g.attributes.position, 'VEC3'))
      .setAttribute('NORMAL', attr(g.attributes.normal, 'VEC3'));
    if (g.attributes.uv) {
      const uv = attr(g.attributes.uv, 'VEC2');
      const a = uv.getArray();
      for (let i = 1; i < a.length; i += 2) a[i] = 1 - a[i]; // FBX v runs bottom-up, glTF top-down
      prim.setAttribute('TEXCOORD_0', uv);
    }
    if (g.index) prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(g.index.array)).setBuffer(buffer));
    mesh.addPrimitive(prim);
  });
  doc.createScene().addChild(doc.createNode('model').setMesh(mesh));
  return doc;
}

const kebab = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const io = new NodeIO();
fs.mkdirSync(outDir, { recursive: true });

let n = 0;
for (const [, prefab] of ofType('.prefab')) {
  if (prefab.name.endsWith('_separate')) continue;
  const [fbx] = refs(prefab.file, fbxs);
  const [matGuid] = refs(prefab.file, mats)[0] ?? [];
  const tex = texOfMat[matGuid];
  if (!fbx || !tex) { console.warn(`skip ${prefab.name} (fbx: ${!!fbx}, texture: ${!!tex})`); continue; }

  const doc = fbxToDoc(fs.readFileSync(fbx[1].file));
  const texture = doc.createTexture(tex.name).setImage(fs.readFileSync(tex.file)).setMimeType(tex.ext === '.png' ? 'image/png' : 'image/jpeg');
  doc.getRoot().listMaterials()[0].setBaseColorTexture(texture);
  await io.write(path.join(outDir, `${kebab(prefab.name)}.glb`), doc);
  n++;
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${n} models to ${outDir}`);
