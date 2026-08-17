globalThis.document={};
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, ROAD, CHUNK } from './src/config.js';
import { createTerrain } from './src/noise.js';
import { RoadPath } from './src/path.js';
import { ChunkManager } from './src/chunks.js';
await RAPIER.init();
const world=new RAPIER.World({x:0,y:WORLD.gravity,z:0}); world.timestep=WORLD.fixedStep;
const terrain=createTerrain(WORLD.seed), path=new RoadPath(terrain,WORLD.seed);
const chunks=new ChunkManager({scene:new THREE.Scene(),world,RAPIER,path,terrain,foliage:new Map()});
path.ensureLength(3000); chunks.update(600,99); world.step();
const EDGE=ROAD.halfWidth+ROAD.shoulder;
console.log(`kerb ${ROAD.halfWidth} m, verge edge (EDGE) ${EDGE} m, cutSlope ${ROAD.cutSlope}, fillSlope ${ROAD.fillSlope}`);
console.log('\nlateral ground profile leaving the road (worst of 60 stations):');
console.log('  from..to        max |slope|   as angle   rise over that span');
const bands=[[0,ROAD.halfWidth],[ROAD.halfWidth,EDGE],[EDGE,EDGE+5],[EDGE+5,EDGE+15],[EDGE+15,40],[40,80]];
for(const [lo,hi] of bands){
  let worst=0, rise=0;
  for(let s=200;s<800;s+=10){
    for(let v=lo;v<hi;v+=0.5){
      const a=chunks.groundAt(s,v,new THREE.Vector3()).y;
      const b=chunks.groundAt(s,v+0.5,new THREE.Vector3()).y;
      const sl=Math.abs(b-a)/0.5;
      if(sl>worst){worst=sl; rise=Math.abs(b-a);}
    }
  }
  console.log(`  ${lo.toFixed(1).padStart(5)}..${hi.toFixed(0).padEnd(4)}  ${worst.toFixed(2).padStart(11)}   ${(Math.atan(worst)*57.3).toFixed(0).padStart(6)}°   ${(worst*0.5).toFixed(2)} m per 0.5 m`);
}
// what does a car at 30 m/s actually meet?  vertical accel = v^2 * curvature
console.log('\nvertical acceleration a car meets crossing each band at 30 m/s:');
for(const [lo,hi] of bands.slice(1)){
  let worstC=0;
  for(let s=200;s<800;s+=10){
    for(let v=lo;v<hi-1;v+=0.5){
      const a=chunks.groundAt(s,v,new THREE.Vector3()).y;
      const b=chunks.groundAt(s,v+0.5,new THREE.Vector3()).y;
      const c=chunks.groundAt(s,v+1.0,new THREE.Vector3()).y;
      const curv=Math.abs(c-2*b+a)/0.25;   // second difference / dx^2
      worstC=Math.max(worstC,curv);
    }
  }
  console.log(`  ${lo.toFixed(1).padStart(5)}..${hi.toFixed(0).padEnd(4)}  curvature ${worstC.toFixed(3)} /m -> ${(worstC*900).toFixed(0)} m/s² at 30 m/s`);
}
