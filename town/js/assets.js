// The 3D model catalog: file paths for roads, buildings, props, vehicles and nature, grouped by use.

export const SP = 'assets/simplepoly-city/';
const COM = 'assets/city-kit-commercial/';
export const SUB = 'assets/city-kit-suburban/';
export const CH = 'assets/mini-characters/';
const CP = 'assets/city-props/'; // Coding Creature City Props 1 (CC0), modeled in meters
const cp = (name) => `${CP}${name}.glb`;
const kenney = (dir, prefix, ids) => ids.split('').map((l) => `${dir}${prefix}${l}.glb`);
export const sp = (name) => `${SP}${name}.glb`;
const colors = (name) => ['01', '02', '03'].map((n) => sp(`${name}-color${n}`));
const shops = (...names) => names.map((n) => sp(`building-${n}`));
export const HOUSES = [...['01', '02', '03', '04'].flatMap((n) => colors(`building-house-${n}`)), ...kenney(SUB, 'building-type-', 'abcdefghijklmnopqrstu')];
// City zones by distance from the central park, tallest in the middle, mixing both packs.
// Only Kenney skyscrapers form the core. Kenney buildings (sorted into zones by their real
// height) keep their proportions; `height` stretches SimplePoly models (min-max, varied per lot,
// capped at 2x) since that pack tops out at ~1.2 tiles.
export const ZONES = [
  { upTo: 3.4, height: [1.8, 2], models: kenney(COM, 'building-skyscraper-', 'abcde').concat(kenney(COM, 'building-', 'm')) },
  { upTo: 4.6, height: [1.5, 2], models: [...colors('building-sky-big'), ...colors('building-sky-small'), ...kenney(COM, 'building-', 'gfl')] },
  { upTo: 5.9, height: [1.1, 1.4], models: [...colors('building-residential'), ...shops('restaurant', 'clothing', 'fast-food', 'drug-store', 'pizza', 'music-store'), ...kenney(COM, 'building-', 'abdhi')] },
  { upTo: 7.3, height: [1, 1.15], models: [...shops('bakery', 'bar', 'chicken-shop', 'fruits-shop', 'gift-shop', 'shoes-shop', 'gas-station', 'factory'), ...kenney(COM, 'building-', 'cejkn')] },
  { upTo: Infinity, height: [1, 1], models: HOUSES },
];
// Interleave the packs within each zone so neighbors alternate styles
for (const z of ZONES) {
  const [a, b] = [z.models.filter((m) => m.startsWith(SP)), z.models.filter((m) => !m.startsWith(SP))];
  if (!a.length || !b.length) continue;
  z.models = Array.from({ length: Math.max(a.length, b.length) * 2 }, (_, i) => (i % 2 ? b : a)[Math.floor(i / 2) % (i % 2 ? b : a).length]);
}
export const ROAD = { straight: sp('road-lane-01'), cross: sp('road-intersection-01'), corner: sp('road-corner-01'), tee: sp('road-t-intersection-01'), plain: sp('road-tile') };
export const GROUND = { grass: sp('natures-grass-tile'), paved: sp('road-concrete-tile') };
export const PARK_TREES = [sp('natures-big-tree'), sp('natures-fir-tree'), sp('natures-cube-tree')];
export const PROPS = Object.fromEntries(['street-light', 'bench-1', 'bench-2', 'traffic-signal-big', 'traffic-signal-small', 'traffic-sign-stop',
  'traffic-sign-speed-limit', 'traffic-cone', 'traffic-control-barrier-fence', 'hydrant', 'dustbin', 'bus-stop', 'coffee-shop-chair',
  'windmill', 'fence', 'billboard-small', 'billboard-medium', 'billboard-large'].map((n) => [n, sp(`props-${n}`)]));
export const NATURE = Object.fromEntries(['bush-01', 'bush-02', 'bush-03', 'pot-bush-big', 'pot-bush-small', 'rock-big', 'rock-small', 'grass-fence', 'grass-bar']
  .map((n) => [n, sp(`natures-${n}`)]));
export const ROOF_PROPS = ['antenna', 'solar-panel', 'prop-air', 'prop'].map((n) => sp(`props-roof-${n}`));
export const HELIPAD = sp('props-roof-helipad');
export const PARASOLS = [`${COM}detail-parasol-a.glb`, `${COM}detail-parasol-b.glb`];
export const VEHICLES = [...colors('vehicle-car'), sp('vehicle-taxi'), ...colors('vehicle-suv'), sp('vehicle-police-car'), ...colors('vehicle-pick-up-truck'),
  ...colors('vehicle-bus'), sp('vehicle-ambulance'), ...colors('vehicle-truck'), ...colors('vehicle-container')];
export const STREET = Object.fromEntries(['trash_bin_c', 'trash_bin_c_green', 'trash_bin_c_blue', 'metal_garbage_can_01_medium', 'garbage_collector_green_medium',
  'garbage_collector_blue_medium', 'payphone_stand', 'drop_box_01', 'traffic_bollard_01_metal_medium', 'fire_hydrant_01', 'barrel_02_medium_blue',
  'barrel_02_medium_red', 'pallet_medium_01', 'concrete_jersey_barrier_01_medium', 'type_ii_barricade_01_medium', 'cone_i_medium', 'mailbox_01_white',
  'public_bench_01', 'drinking_fountain_01', 'pedestrian_traffic_light_02_base_medium_black', 'cctv_camera_01_base'].map((n) => [n, cp(n)]));
export const METER = 2.8; // `scale` that puts a meters-sized City Props model next to SimplePoly props
export const CURBSIDE = ['trash_bin_c', 'payphone_stand', 'garbage_collector_green_medium', 'trash_bin_c_green', 'drop_box_01',
  'traffic_bollard_01_metal_medium', 'metal_garbage_can_01_medium', 'garbage_collector_blue_medium', 'trash_bin_c_blue', 'fire_hydrant_01'];
